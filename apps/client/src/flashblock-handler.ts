/**
 * FlashblockHandler — processes OCR oracle update events from FlashblockWatcher.
 *
 * Encapsulates the entire hot-path logic that runs on every Chainlink price update:
 *   1. Per-aggregator block debounce (one attempt per block per aggregator)
 *   2. Price sanity check and direction detection
 *   3. Precision targeting via PositionCache.findLiquidatableByPrice()
 *   4. Fallback symbol-based filtering via PositionCache.findByCollateralSymbol()
 *   5. Profitability filter (SKIP_SYMBOLS + MIN_BORROW)
 *   6. Batch fire: sign all TXs with sequential nonces, send simultaneously
 *      via dual path (Alchemy + Base sequencer)
 *   7. Cache-miss fallback via bot.fastLiquidate()
 *
 * Extracted from index.ts for readability. Business logic is preserved exactly.
 */

import { type ChainConfig } from "@morpho-blue-liquidation-bot/config";
import { type Hex, encodeFunctionData } from "viem";
import { getGasPrice, getTransactionReceipt, readContract, sendRawTransaction } from "viem/actions";

import { type LiquidationBot } from "./bot";
import { type CanaryTracker } from "./canary";
import { discord } from "./discord-notifier";
import { type OracleUpdateEvent } from "./flashblock-watcher";
import { setFlashblockLastEventMs } from "./health";
import {
  AGGREGATOR_TO_COLLATERAL_SYMBOLS,
  MIN_BORROW_USDC_6DEC,
  MIN_BORROW_WETH_18DEC,
  PRICE_MAX,
  PRICE_MIN,
  RATE_FEED_AGGREGATORS,
  SKIP_SYMBOLS,
} from "./liquidation-constants";
import { type PositionCache, calculateHF } from "./position-cache";
import { type PrimaryWalletCoordinator } from "./primary-wallet-coordinator";
import { type ShadowLogger } from "./shadow-logger";
import { TxCache, type PrebuiltTx } from "./tx-cache";
import { buildBloxroutePromise, loadBloxrouteConfig } from "./utils/bloxrouteSubmit.js";

/**
 * H1: Dynamic priority fee tiers based on estimated USD borrow size.
 *
 * Flashblock ordering within a block is set by priority fee (after FIFO baseline).
 * The dominant operator `0x5733…` bids $0/TX (flashbots builder), so any positive
 * priority fee outranks them. We tier by profit potential so dust positions don't
 * eat a $3 gas premium that the expected LIF can't cover.
 *
 * Bid calibration (at 700K gas):
 *   0.01 gwei → $0.015   — floor, always-on baseline
 *   0.05 gwei → $0.08    — small positions
 *   0.5  gwei → $0.77    — mid-size positions
 *   2.0  gwei → $3.08    — whale positions where winning is worth the premium
 */
// Session 35: Recalibrated from Base competitor forensic analysis.
// Top 2 whale hunters (0xB949a5..., 0x3d7BEe8...) median effective tip = 0.005 gwei.
// Previous tier (whale=2 gwei) was 400x overkill. New tier targets competitor median
// with modest escalation for whale events. Dynamic overbid happens via same-block
// reaction latency, not static fee.
const PRIORITY_FEE_FLOOR = 5_000_000n; // 0.005 gwei — match competitor median baseline
const PRIORITY_FEE_SMALL = 10_000_000n; // 0.01 gwei
const PRIORITY_FEE_MID = 20_000_000n; // 0.02 gwei
const PRIORITY_FEE_WHALE = 50_000_000n; // 0.05 gwei (still 40x cheaper than old)
/** Minimum USD borrow value to attempt liquidation. Below this, spray bot territory. */
const MIN_PROFIT_GATE_USD = 10;

/** Rough ETH price used only to bucket WETH-denominated borrows into USD tiers. */
const WETH_USD_HEURISTIC = 2200;

/** WAD = 10^18, Morpho's fixed-point base for HF comparison. */
const WAD = 10n ** 18n;

/** Minimal ABI for reading Morpho oracle price(). */
const ORACLE_PRICE_ABI = [
  {
    name: "price",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

function estimatePriorityFeeWei(prebuilt: PrebuiltTx): bigint {
  const loanSymbol = prebuilt.loanSymbol?.toLowerCase() ?? "";
  let usd = 0;
  if (loanSymbol.includes("usdc") || loanSymbol.includes("usdt") || loanSymbol.includes("eurc")) {
    // 6-dec stable
    usd = Number(prebuilt.borrowAssets) / 1e6;
  } else if (loanSymbol.includes("weth") || loanSymbol.includes("eth")) {
    // 18-dec ETH-like
    usd = (Number(prebuilt.borrowAssets) / 1e18) * WETH_USD_HEURISTIC;
  } else {
    // Unknown denomination — treat as small and use the floor.
    return PRIORITY_FEE_FLOOR;
  }

  if (usd >= 10_000) return PRIORITY_FEE_WHALE;
  if (usd >= 1_000) return PRIORITY_FEE_MID;
  if (usd >= 100) return PRIORITY_FEE_SMALL;
  return PRIORITY_FEE_FLOOR;
}

/** Returns the USD borrow value of a PrebuiltTx, or 0 if denomination is unknown. */
export function estimateBorrowUsd(prebuilt: PrebuiltTx): number {
  const loanSymbol = prebuilt.loanSymbol?.toLowerCase() ?? "";
  if (loanSymbol.includes("usdc") || loanSymbol.includes("usdt") || loanSymbol.includes("eurc")) {
    return Number(prebuilt.borrowAssets) / 1e6;
  }
  if (loanSymbol.includes("weth") || loanSymbol.includes("eth")) {
    return (Number(prebuilt.borrowAssets) / 1e18) * WETH_USD_HEURISTIC;
  }
  return 0;
}

export { MIN_PROFIT_GATE_USD };

export class FlashblockHandler {
  private readonly logTag: string;
  private readonly config: ChainConfig;
  private readonly bot: LiquidationBot;
  private readonly positionCache: PositionCache;
  private readonly txCache: TxCache;
  private readonly primaryWalletCoordinator: PrimaryWalletCoordinator;
  private readonly shadowLogger?: ShadowLogger;

  /** Per-aggregator debounce: only attempt once per block per aggregator. */
  private readonly lastBlockByAggregator = new Map<string, number>();

  /** Track last extracted Chainlink price per aggregator address.
   *  Used to detect price direction: drops tighten filter, rises relax filter. */
  private readonly lastKnownPrices = new Map<string, bigint>();

  /** Track in-flight liquidation attempts to prevent duplicate submissions for same borrower. */
  private readonly inFlightBorrowers = new Set<string>();

  /** Timestamp of last received flashblock event (ms). Updated by handleOracleUpdate(). */
  lastFlashblockEventMs: number = Date.now();
  /** True while a batch of TXs is being signed/sent. Used to prevent CEX path nonce collision. */
  isBatchInFlight = false;

  /**
   * Optional callback triggered when an oracle price move exceeds 1%.
   * Index.ts wires this to refreshTxCache() so the cache stays fresh on significant moves.
   */
  onSignificantPriceMove?: (trigger: string) => void;

  /**
   * Optional callback triggered on large price moves (>3%).
   * Index.ts wires this to PositionCache.loadPositions() for immediate refresh
   * during flash crashes — eliminates 30s stale window.
   */
  onFlashCrashDetected?: () => void;

  /** Cached gas price — refreshed every 15s to avoid RPC on hot path. */
  private cachedMaxFeePerGas = 1_000_000_000n; // 1 gwei default
  private cachedMaxPriorityFeePerGas = 0n;
  private gasPriceRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly bloxrouteConfig = loadBloxrouteConfig() ?? null;

  private readonly canary?: CanaryTracker;

  constructor(
    logTag: string,
    config: ChainConfig,
    bot: LiquidationBot,
    positionCache: PositionCache,
    txCache: TxCache,
    primaryWalletCoordinator: PrimaryWalletCoordinator,
    canary?: CanaryTracker,
    shadowLogger?: ShadowLogger,
  ) {
    this.logTag = logTag;
    this.config = config;
    this.bot = bot;
    this.positionCache = positionCache;
    this.txCache = txCache;
    this.primaryWalletCoordinator = primaryWalletCoordinator;
    this.canary = canary;
    this.shadowLogger = shadowLogger;

    if (this.bloxrouteConfig) {
      console.log(`${this.logTag}bloXroute Protect enabled → ${this.bloxrouteConfig.url}`);
    } else {
      console.log(`${this.logTag}bloXroute Protect disabled (BLOXROUTE_BASE_AUTH unset)`);
    }

    // Pre-cache gas price every 15s — eliminates 30ms RPC on hot path
    const refreshGasPrice = async () => {
      try {
        const gasPrice = await getGasPrice(this.primaryWalletCoordinator.client);
        this.cachedMaxFeePerGas = gasPrice * 2n;
        // Base: 10M wei (0.01 gwei) minimum priority fee for sequencer ordering
        // Cost: ~$0.001 per TX. Without this, we're always last in the flashblock.
        this.cachedMaxPriorityFeePerGas = this.config.chainId === 8453 ? 10_000_000n : 100_000n;
      } catch {
        /* keep previous value */
      }
    };
    void refreshGasPrice(); // immediate first fetch
    this.gasPriceRefreshInterval = setInterval(() => {
      void refreshGasPrice();
    }, 15_000);
  }

  /**
   * Main entry point. Called by FlashblockWatcher on each oracle update event.
   * All business logic preserved exactly from the original index.ts callback.
   */
  handleOracleUpdate(event: OracleUpdateEvent): void {
    const now = Date.now();
    this.lastFlashblockEventMs = now;
    setFlashblockLastEventMs(now);
    const aggregatorAddr = event.aggregatorAddress.toLowerCase();

    // Debounce: only attempt once per block per aggregator
    if (event.blockNumber <= (this.lastBlockByAggregator.get(aggregatorAddr) ?? 0)) return;
    this.lastBlockByAggregator.set(aggregatorAddr, event.blockNumber);

    // Timing probe: DISABLED in production.
    // It sends a real TX from wallet[0] outside the WalletPool/NonceManager, and the
    // recent maxFee guard made those TXs actually land. That means a probe and a batch
    // liquidation can sign the same nonce on the same oracle event, breaking both.
    // We already collected enough timing data (see Session 32 memory); leave this off
    // unless we rewire it onto a dedicated wallet or through NonceManager.
    // this.sendTimingProbe(event).catch((e: unknown) => console.log(this.logTag + "TIMING PROBE outer error: " + (e instanceof Error ? e.message.slice(0,100) : String(e))));

    // Determine HF filter threshold based on price direction.
    // Price DROP → collateral is worth less → positions closer to liquidation.
    // Price INCREASE → collateral is worth more → positions safer.
    let hfThreshold = 1.05; // default: backward-compatible wide filter
    let filterDecision = "wide(default)";
    /** Price direction in basis points (>0 = drop, <0 = rise, undefined = first observation). */
    let priceDropBps: number | undefined;

    if (event.extractedPrice !== undefined) {
      const newPrice = event.extractedPrice;

      // Sanity check: reject garbage values from malformed TX parsing.
      // Valid Chainlink 8-dec prices: $1 = 100_000_000, $1M = 100_000_000_000_000.
      // Anything outside [$0.01, $10M] is clearly extraction noise.
      const priceValid = newPrice >= PRICE_MIN && newPrice <= PRICE_MAX;

      if (priceValid) {
        const lastPrice = this.lastKnownPrices.get(aggregatorAddr);

        if (lastPrice !== undefined && lastPrice > 0n) {
          const dropBps = Number(((lastPrice - newPrice) * 10000n) / lastPrice);
          priceDropBps = dropBps;
          const is18Dec = newPrice > 1_000_000_000_000_000n;
          const priceFormatted = is18Dec
            ? (Number(newPrice) / 1e18).toFixed(6)
            : (Number(newPrice) / 1e8).toFixed(2);
          const lastFormatted = is18Dec
            ? (Number(lastPrice) / 1e18).toFixed(6)
            : (Number(lastPrice) / 1e8).toFixed(2);
          const changePct = (-dropBps / 100).toFixed(3);

          if (dropBps > 100) {
            hfThreshold = 1.05;
            filterDecision = `wide(drop>${(dropBps / 100).toFixed(2)}%)`;
          } else if (dropBps > 0) {
            hfThreshold = 1.02;
            filterDecision = `tight(drop=${(dropBps / 100).toFixed(3)}%)`;
          } else {
            hfThreshold = 1.05;
            filterDecision = `wide(rise=${(-dropBps / 100).toFixed(3)}%)`;
          }

          console.log(
            `${this.logTag}⚡ FLASHBLOCK: aggregator ${aggregatorAddr.slice(0, 10)}... ` +
              `OCR2 price $${lastFormatted} → $${priceFormatted} (${changePct}%) — ` +
              `filter: HF≤${hfThreshold} [${filterDecision}]`,
          );
          // Event-driven TxCache refresh on significant price moves (>1%)
          if (Math.abs(dropBps) > 100) {
            this.onSignificantPriceMove?.(
              `${aggregatorAddr.slice(0, 10)} moved ${(dropBps / 100).toFixed(1)}%`,
            );
          }
          // Flash crash detection: >3% drop → immediate PositionCache + TxCache reload
          if (dropBps > 300) {
            console.log(
              `${this.logTag}🚨 FLASH CRASH: ${(dropBps / 100).toFixed(1)}% drop — triggering immediate cache reload`,
            );
            this.onFlashCrashDetected?.();
            discord
              .notifyFlashCrash(dropBps / 100, 0, aggregatorAddr.slice(0, 10))
              .catch((e: unknown) => {
                console.error("[notify]", e instanceof Error ? e.message : e);
              });
          }
        } else {
          const is18Dec = newPrice > 1_000_000_000_000_000n;
          const priceFormatted = is18Dec
            ? (Number(newPrice) / 1e18).toFixed(6)
            : (Number(newPrice) / 1e8).toFixed(2);
          console.log(
            `${this.logTag}⚡ FLASHBLOCK: aggregator ${aggregatorAddr.slice(0, 10)}... ` +
              `OCR2 price = $${priceFormatted} (first observation) — filter: HF≤${hfThreshold} [${filterDecision}]`,
          );
        }

        this.lastKnownPrices.set(aggregatorAddr, newPrice);
      } else {
        // Garbage price — do not store, do not fire
        console.log(
          `${this.logTag}⚡ FLASHBLOCK: aggregator ${aggregatorAddr.slice(0, 10)}... ` +
            `OCR2 price REJECTED (${newPrice} out of sanity range) — falling back to symbol filter`,
        );
        // Don't return — fall through to symbol-based fallback path below
      }
    } else {
      console.log(
        `${this.logTag}⚡ FLASHBLOCK: aggregator ${aggregatorAddr.slice(0, 10)}... ` +
          `no price extracted — filter: HF≤${hfThreshold} [${filterDecision}]`,
      );
    }

    // Precision targeting: use extracted price for exact HF calculation when possible.
    // Falls back to symbol-based API HF filter when price extraction failed.
    const symbolPatterns = AGGREGATOR_TO_COLLATERAL_SYMBOLS[aggregatorAddr] ?? [];

    // Empty patterns (e.g. USDC/USD) = loan-side oracle, no collateral to target.
    // Skip entirely to avoid blind-firing at all 500 positions.
    if (symbolPatterns.length === 0) return;

    let nearLiquidation;
    // Rate feeds (wrsETH/ETH, wstETH/stETH, cbETH/ETH) report ~1e18, not 8-dec USD.
    // PositionCache.findLiquidatableByPrice() multiplies by collateral-side scaling and
    // would return zero candidates if fed a 1e18 rate. Keep rate feeds on the fallback
    // path — the symbol match + API HF threshold is safer until precision is rewritten.
    // aggregatorAddr already includes the `0x` prefix from event.aggregatorAddress.
    const isRateFeed = RATE_FEED_AGGREGATORS.has(aggregatorAddr);

    // P1: Rate feed direction guard — rate INCREASE means collateral is worth MORE,
    // so HF improves. No liquidation opportunity can arise from a positive rate update.
    // Only fire on rate DECREASE (or first observation where direction is unknown).
    // priceDropBps > 0 = price dropped (HF worsens), <= 0 = price rose/flat (HF improves).
    // undefined = first observation (no prior price to compare) — proceed cautiously.
    if (isRateFeed && priceDropBps !== undefined && priceDropBps <= 0) {
      console.log(
        `${this.logTag}⚡ FLASHBLOCK: rate feed ${aggregatorAddr.slice(0, 10)}... ` +
          `rate UP/flat (${(-priceDropBps / 100).toFixed(3)}%) — skipping (HF improved)`,
      );
      return;
    }

    if (!isRateFeed && event.extractedPrice !== undefined && event.extractedPrice > 0n) {
      // PRECISION PATH: pass raw Chainlink 8-decimal price to PositionCache.
      nearLiquidation = this.positionCache.findLiquidatableByPrice(
        symbolPatterns,
        event.extractedPrice,
      );
    } else {
      // FALLBACK: no price available OR rate feed — use tight threshold to avoid false positives.
      // Without extracted price, we can't compute exact HF — only API HF is available.
      // API HF can be stale by minutes, so use 1.01 to minimize wasted TX.
      nearLiquidation = this.positionCache.findByCollateralSymbol(symbolPatterns, 1.01);
    }

    // Profitability filter: skip positions too small to be worth the gas + swap slippage.
    // Liquidation incentive is ~5% of borrow. On Base, gas+swap cost ~$0.50-$2.
    // Minimum borrow of ~$10 ensures at least ~$0.50 profit margin.
    // For USDC-denominated loans: 10 USDC = 10_000_000 (6 decimals).
    // For WETH-denominated loans: 0.005 WETH ≈ $10 = 5_000_000_000_000_000 (18 decimals).
    nearLiquidation = nearLiquidation.filter((c) => {
      if (SKIP_SYMBOLS.has(c.position.collateralSymbol.toLowerCase())) return false;
      const loanDec = c.position.loanDecimals;
      const minBorrow = loanDec <= 8 ? MIN_BORROW_USDC_6DEC : MIN_BORROW_WETH_18DEC;
      return c.borrowAssets >= minBorrow;
    });

    if (nearLiquidation.length > 0) {
      // BATCH FIRE: collect all candidates, sign all TXs with sequential nonces, send simultaneously.
      // Previous approach: acquire wallet per candidate → pool full after 1st → rest fallback to slow path.
      // New approach: acquire wallet ONCE, sign N TXs with nonce, nonce+1, ..., send ALL at once.
      const candidates = nearLiquidation.slice(0, 10).filter((c) => {
        const key = `${c.position.borrower.toLowerCase()}:${c.position.marketId}`;
        if (this.inFlightBorrowers.has(key)) return false;
        if (this.inFlightBorrowers.size > 100) this.inFlightBorrowers.clear();
        this.inFlightBorrowers.add(key);
        return true;
      });

      if (candidates.length === 0) return;

      // Split into cache-hit and cache-miss
      type Candidate = (typeof candidates)[0];
      interface PrebuiltEntry {
        candidate: Candidate;
        prebuilt: PrebuiltTx;
      }
      let cacheHits: PrebuiltEntry[] = [];
      const cacheMisses: Candidate[] = [];
      for (const c of candidates) {
        const prebuilt = this.txCache.get(c.position.borrower, c.position.marketId);
        if (prebuilt) cacheHits.push({ candidate: c, prebuilt });
        else cacheMisses.push(c);
      }

      console.log(
        `${this.logTag}⚡ FLASHBLOCK: block ${event.blockNumber} — ` +
          `${candidates.length} targets (HF≤${hfThreshold}) [${symbolPatterns.join(",") || "all"}], ` +
          `batch ${cacheHits.length} cached + ${cacheMisses.length} fresh [${filterDecision}]`,
      );

      // BATCH PATH: sign all cache-hit TXs with sequential nonces, send simultaneously
      if (cacheHits.length > 0) {
        // TxCache pre-built TXs use config.executorAddress (wallet[0]).
        // Must fire with wallet[0] to match the encoded executor address in callbacks.
        const lease = this.primaryWalletCoordinator.tryAcquire(
          `flashblock-batch:${event.blockNumber}:${symbolPatterns.join(",") || "unknown"}`,
        );
        if (lease !== null) {
          this.isBatchInFlight = true;
          const sequencerUrl =
            this.config.chainId === 8453 ? "https://mainnet-sequencer.base.org" : undefined;
          // Snapshot of all cache hits before any filtering — used for inFlightBorrowers cleanup.
          const allCacheHitsSnapshot = [...cacheHits];

          (async () => {
            // Gas price is pre-cached (refreshed every 15s) — zero RPC on hot path.
            const baseMaxFeePerGas = this.cachedMaxFeePerGas;
            const floorPriorityFee = this.cachedMaxPriorityFeePerGas;

            // P0: On-chain HF verification for rate feed candidates.
            // Rate feeds bypass the precision HF path (findLiquidatableByPrice) and use
            // stale API HF only. Before spending gas, verify HF < 1.0 using the Morpho
            // oracle's live price(). Adds ~50-100ms per unique oracle but prevents false
            // positive fires like the wrsETH/WETH revert at block 44608565 (HF=1.005).
            if (isRateFeed) {
              const oraclePrices = new Map<string, bigint>();
              for (const { candidate: c } of cacheHits) {
                const oracleAddr = c.position.oracle.toLowerCase();
                if (!oraclePrices.has(oracleAddr)) {
                  try {
                    const price = await readContract(this.primaryWalletCoordinator.client, {
                      address: c.position.oracle,
                      abi: ORACLE_PRICE_ABI,
                      functionName: "price",
                    });
                    oraclePrices.set(oracleAddr, price);
                  } catch {
                    // Oracle read failed — allow candidate through (fail-open)
                  }
                }
              }

              const allCacheHits = [...cacheHits]; // preserve for cleanup
              cacheHits = cacheHits.filter(({ candidate: c }) => {
                const oraclePrice = oraclePrices.get(c.position.oracle.toLowerCase());
                if (!oraclePrice) return true; // fail-open
                const hf = calculateHF(
                  c.position.collateral,
                  c.position.borrowShares,
                  c.position.totalBorrowAssets,
                  c.position.totalBorrowShares,
                  oraclePrice,
                  c.position.lltv,
                );
                if (hf >= WAD) {
                  console.log(
                    `${this.logTag}⚡ RATE FEED HF GATE: ${c.position.borrower.slice(0, 10)}... ` +
                      `${c.position.collateralSymbol}/${c.position.loanSymbol} ` +
                      `HF=${(Number(hf) / 1e18).toFixed(6)} ≥ 1.0 — BLOCKED (false positive)`,
                  );
                  return false;
                }
                return true;
              });

              if (cacheHits.length === 0 && allCacheHits.length > 0) {
                console.log(
                  `${this.logTag}⚡ RATE FEED HF GATE: all ${allCacheHits.length} candidates healthy — aborting batch`,
                );
                this.primaryWalletCoordinator.release(lease);
                this.isBatchInFlight = false;
                for (const { candidate: c } of allCacheHits) {
                  this.inFlightBorrowers.delete(
                    `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
                  );
                }
                return;
              }
            }

            // Step 1: Sign ALL TXs locally with sequential nonces (0ms per sign, 1 RPC for initial nonce)
            const signedTxs: {
              signed: Hex;
              prebuilt: PrebuiltEntry["prebuilt"];
              nonce: number;
              maxFeePerGas: bigint;
              maxPriorityFeePerGas: bigint;
              borrowerKey: string;
            }[] = [];

            for (const { candidate: c, prebuilt } of cacheHits) {
              // Canary gate (Phase 2): applied per-TX in batch path.
              if (this.canary) {
                const usd = estimateBorrowUsd(prebuilt);
                const decision = this.canary.shouldAttempt({
                  collateralSymbol: prebuilt.collateralSymbol,
                  expectedProfitUsd: usd,
                });
                if (!decision.allow) {
                  console.log(
                    `${this.logTag}Canary skip (batch): ${decision.reason} ${prebuilt.borrower} ${prebuilt.collateralSymbol}/${prebuilt.loanSymbol}`,
                  );
                  this.canary.recordResult({
                    timestamp: Date.now(),
                    eventDate: new Date().toISOString().slice(0, 10),
                    type: "skipped",
                    borrower: prebuilt.borrower,
                    marketId: prebuilt.marketId,
                    collateralSymbol: prebuilt.collateralSymbol,
                    loanSymbol: prebuilt.loanSymbol ?? "",
                    expectedProfitUsd: usd,
                    gasCostUsd: 0,
                    actualProfitUsd: 0,
                    skipReason: decision.reason,
                  });
                  continue;
                }
              }
              const calldata = encodeFunctionData({
                abi: TxCache.functionData.abi,
                functionName: TxCache.functionData.functionName,
                args: [prebuilt.calls],
              });
              // H1: per-TX dynamic priority fee based on estimated borrow USD.
              // Never below the chain floor (0.01 gwei on Base) so dust still beats 0-tip bots.
              const dynamicTip = estimatePriorityFeeWei(prebuilt);
              const maxPriorityFeePerGas =
                dynamicTip > floorPriorityFee ? dynamicTip : floorPriorityFee;
              // EIP-1559 requires maxFeePerGas >= baseFee + priorityFee.
              // Sprint D1 found cachedMaxFeePerGas (15s-stale gasPrice × 2) can lag
              // behind real-time baseFee spikes causing rejects. Hard floor at 2 gwei
              // ensures coverage up to ~1.95 gwei baseFee (covers >99% of Base scenarios).
              const MAX_FEE_FLOOR = 2_000_000_000n; // 2 gwei
              const dynamicCap =
                baseMaxFeePerGas > maxPriorityFeePerGas
                  ? baseMaxFeePerGas
                  : baseMaxFeePerGas + maxPriorityFeePerGas;
              const maxFeePerGas = dynamicCap > MAX_FEE_FLOOR ? dynamicCap : MAX_FEE_FLOOR;
              const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
              let signed: Hex;
              try {
                signed = await this.primaryWalletCoordinator.client.signTransaction({
                  to: this.primaryWalletCoordinator.executorAddress,
                  data: calldata,
                  gas: 700_000n,
                  maxFeePerGas,
                  maxPriorityFeePerGas,
                  nonce,
                  type: "eip1559" as const,
                });
              } catch (error) {
                this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
                throw error;
              }
              signedTxs.push({
                signed,
                prebuilt,
                nonce,
                maxFeePerGas,
                maxPriorityFeePerGas,
                borrowerKey: c.position.borrower.toLowerCase(),
              });
            }

            console.log(
              `${this.logTag}⚡ BATCH SIGNED: ${signedTxs.length} TXs (nonces ${signedTxs[0]?.nonce}-${signedTxs[signedTxs.length - 1]?.nonce})`,
            );

            // Step 2: Send ALL simultaneously via dual path
            const sendResults = await Promise.allSettled(
              signedTxs.map(
                async ({ signed, prebuilt, nonce, maxFeePerGas, maxPriorityFeePerGas }) => {
                  const promises: Promise<string>[] = [
                    sendRawTransaction(this.primaryWalletCoordinator.client, {
                      serializedTransaction: signed,
                    }),
                  ];
                  if (sequencerUrl) {
                    promises.push(
                      fetch(sequencerUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          jsonrpc: "2.0",
                          method: "eth_sendRawTransaction",
                          params: [signed],
                          id: 1,
                        }),
                        signal: AbortSignal.timeout(5_000),
                      })
                        .then((r) => r.json())
                        .then((r: unknown) => {
                          const res = r as { result?: string };
                          if (!res.result?.startsWith("0x")) throw new Error("empty");
                          return res.result;
                        })
                        .catch(() => {
                          throw new Error("seq failed");
                        }),
                    );
                  }
                  if (this.bloxrouteConfig) {
                    promises.push(buildBloxroutePromise(this.bloxrouteConfig, signed));
                  }
                  const txHash = await Promise.any(promises);
                  const broadcastedMs = Date.now();
                  console.log(
                    `${this.logTag}⚡ BATCH TX SENT: ${prebuilt.borrower.slice(0, 10)}... ${prebuilt.collateralSymbol}/${prebuilt.loanSymbol} tx=${txHash} (nonce=${nonce})`,
                  );

                  // Canary: log broadcast as "attempt", then fire-and-forget receipt verify.
                  const usd = estimateBorrowUsd(prebuilt);
                  if (this.canary) {
                    const flashblockReceivedMs = Date.parse(event.detectedAt);
                    const latencyMs = Number.isFinite(flashblockReceivedMs)
                      ? broadcastedMs - flashblockReceivedMs
                      : undefined;
                    this.canary.recordResult({
                      timestamp: broadcastedMs,
                      eventDate: new Date(broadcastedMs).toISOString().slice(0, 10),
                      type: "attempt",
                      borrower: prebuilt.borrower,
                      marketId: prebuilt.marketId,
                      collateralSymbol: prebuilt.collateralSymbol,
                      loanSymbol: prebuilt.loanSymbol ?? "",
                      expectedProfitUsd: usd,
                      gasCostUsd: 0,
                      actualProfitUsd: 0,
                      txHash: txHash as Hex,
                      priorityFeeGwei: Number(estimatePriorityFeeWei(prebuilt)) / 1e9,
                      broadcastedMs,
                      flashblockReceivedMs: Number.isFinite(flashblockReceivedMs)
                        ? flashblockReceivedMs
                        : undefined,
                      latencyMs,
                    });
                    // Receipt watcher — fires after ~30s and records final outcome.
                    this.verifyBatchReceipt(txHash as Hex, prebuilt, usd).catch(() => {});
                  }
                  this.shadowLogger?.recordAttempt({
                    borrower: prebuilt.borrower,
                    marketId: prebuilt.marketId,
                    collateralSymbol: prebuilt.collateralSymbol,
                    loanSymbol: prebuilt.loanSymbol ?? "",
                    ourTxHash: txHash as Hex,
                    ourTipWei: maxPriorityFeePerGas,
                    ourMaxFeePerGasWei: maxFeePerGas,
                    ourSentBlock: BigInt(event.blockNumber),
                    ourSentMs: broadcastedMs,
                    expectedProfitUsd: usd,
                    flashblockReceivedMs: Number.isFinite(Date.parse(event.detectedAt))
                      ? Date.parse(event.detectedAt)
                      : undefined,
                  });
                  return txHash;
                },
              ),
            );

            // Step 3: Check results
            let sent = 0,
              failed = 0;
            for (const r of sendResults) {
              if (r.status === "fulfilled") sent++;
              else failed++;
            }
            console.log(`${this.logTag}⚡ BATCH RESULT: ${sent} sent, ${failed} failed`);
            discord
              .notifyBatchResult(sent, failed, symbolPatterns.join(",") || "unknown")
              .catch((e: unknown) => {
                console.error("[notify]", e instanceof Error ? e.message : e);
              });

            if (failed > 0) {
              this.primaryWalletCoordinator.resetNonceCache(lease);
            }
          })()
            .catch((e: unknown) => {
              console.error(
                `${this.logTag}Batch error:`,
                e instanceof Error ? e.message : String(e),
              );
              this.primaryWalletCoordinator.resetNonceCache(lease);
            })
            .finally(() => {
              this.isBatchInFlight = false;
              this.primaryWalletCoordinator.release(lease);
              // Use snapshot to clean up ALL candidates including those filtered by HF gate
              for (const { candidate: c } of allCacheHitsSnapshot) {
                this.inFlightBorrowers.delete(
                  `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
                );
              }
            });
        } else {
          console.log(`${this.logTag}FLASHBLOCK: primary wallet busy — skipping cached batch`);
          for (const { candidate: c } of cacheHits) {
            this.inFlightBorrowers.delete(
              `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
            );
          }
        }
      }

      // FRESH PATH: cache misses go through fastLiquidate ONLY if no batch is running.
      // If batch acquired the wallet, fastLiquidate would use the same wallet → nonce collision.
      // With single wallet, skip cache misses during batch fire to prevent races.
      if (cacheHits.length === 0) {
        (async () => {
          // P0 (fresh path): HF gate for rate-feed cache misses — mirrors the cache-hit gate above.
          // Rate-feed positions use stale API HF; verify with live oracle price() before fastLiquidate.
          let activeMisses = cacheMisses;
          if (isRateFeed && cacheMisses.length > 0) {
            const oraclePricesFresh = new Map<string, bigint>();
            for (const c of cacheMisses) {
              const oracleAddr = c.position.oracle.toLowerCase();
              if (!oraclePricesFresh.has(oracleAddr)) {
                try {
                  const price = await readContract(this.primaryWalletCoordinator.client, {
                    address: c.position.oracle,
                    abi: ORACLE_PRICE_ABI,
                    functionName: "price",
                  });
                  oraclePricesFresh.set(oracleAddr, price);
                } catch {
                  // Oracle read failed — allow candidate through (fail-open)
                }
              }
            }
            activeMisses = cacheMisses.filter((c) => {
              const oraclePrice = oraclePricesFresh.get(c.position.oracle.toLowerCase());
              if (!oraclePrice) return true; // fail-open
              const hf = calculateHF(
                c.position.collateral,
                c.position.borrowShares,
                c.position.totalBorrowAssets,
                c.position.totalBorrowShares,
                oraclePrice,
                c.position.lltv,
              );
              if (hf >= WAD) {
                console.log(
                  `${this.logTag}⚡ RATE FEED HF GATE (fresh): ${c.position.borrower.slice(0, 10)}... ` +
                    `${c.position.collateralSymbol}/${c.position.loanSymbol} ` +
                    `HF=${(Number(hf) / 1e18).toFixed(6)} ≥ 1.0 — BLOCKED (false positive)`,
                );
                this.inFlightBorrowers.delete(
                  `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
                );
                return false;
              }
              return true;
            });
          }
          for (const c of activeMisses) {
            this.bot
              .fastLiquidate(c.position, c.seizableCollateral, c.borrowAssets)
              .catch((e: unknown) => {
                console.error(
                  `${this.logTag}Fast liquidate error:`,
                  e instanceof Error ? e.message : e,
                );
              })
              .finally(() =>
                this.inFlightBorrowers.delete(
                  `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
                ),
              );
          }
        })()
          .catch((e: unknown) => {
            console.error(
              `${this.logTag}Fresh path HF gate error:`,
              e instanceof Error ? e.message : e,
            );
          })
          .finally(() => {
            // Cleanup any remaining inFlightBorrowers entries not already cleaned by filter or fastLiquidate.finally.
            // Safe to call unconditionally — Set.delete is a no-op for missing keys.
            for (const c of cacheMisses) {
              this.inFlightBorrowers.delete(
                `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
              );
            }
          });
      } else {
        // Batch is running — release cache-miss borrowers without firing (avoid nonce race)
        for (const c of cacheMisses) {
          this.inFlightBorrowers.delete(
            `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
          );
        }
      }
    }
  }

  /** Timing probe: dual-path (wallet RPC vs sequencer direct) latency measurement */
  private lastProbeMs = 0;
  private async sendTimingProbe(event: OracleUpdateEvent): Promise<void> {
    const now = Date.now();
    if (now - this.lastProbeMs < 60_000) return;
    this.lastProbeMs = now;

    const lease = this.primaryWalletCoordinator.tryAcquire("timing-probe");
    if (lease === null) return;

    const detectTime = now;
    const SEQUENCER_URL = "https://mainnet-sequencer.base.org";

    try {
      // Pre-sign the TX for raw submission
      const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
      const probeTip = this.cachedMaxPriorityFeePerGas;
      const probeMaxFee =
        this.cachedMaxFeePerGas > probeTip
          ? this.cachedMaxFeePerGas
          : this.cachedMaxFeePerGas + probeTip;
      let signed: Hex;
      try {
        signed = await this.primaryWalletCoordinator.client.signTransaction({
          to: this.primaryWalletCoordinator.client.account.address,
          value: 0n,
          gas: 21_000n,
          maxFeePerGas: probeMaxFee,
          maxPriorityFeePerGas: probeTip,
          nonce,
          type: "eip1559" as const,
        });
      } catch (error) {
        this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
        throw error;
      }
      const signTime = Date.now();

      // Dual-path: send to BOTH sequencer and wallet RPC simultaneously
      const sequencerPromise = fetch(SEQUENCER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_sendRawTransaction",
          params: [signed],
          id: 1,
        }),
      })
        .then((r) => r.json())
        .then(() => Date.now());

      const rpcPromise = this.primaryWalletCoordinator.client
        .request({
          method: "eth_sendRawTransaction",
          params: [signed],
        })
        .then(() => Date.now());

      const [seqResult, rpcResult] = await Promise.allSettled([sequencerPromise, rpcPromise]);
      if (seqResult.status !== "fulfilled" && rpcResult.status !== "fulfilled") {
        this.primaryWalletCoordinator.resetNonceCache(lease);
      }

      const seqMs = seqResult.status === "fulfilled" ? seqResult.value - detectTime : -1;
      const rpcMs = rpcResult.status === "fulfilled" ? rpcResult.value - detectTime : -1;
      const signMs = signTime - detectTime;
      const fastestMs = Math.min(...[seqMs, rpcMs].filter((x) => x > 0));

      // Extract TX hash from signed TX
      const { keccak256 } = await import("viem");
      const txHash = keccak256(signed);

      console.log(
        `${this.logTag}⏱️ TIMING PROBE: sign=${signMs}ms seq=${seqMs}ms rpc=${rpcMs}ms ` +
          `fastest=${fastestMs}ms flashIdx=${event.flashblockIndex} oracleBlock=${event.blockNumber} tx=${txHash}`,
      );

      // Wait and check block inclusion
      await new Promise((r) => setTimeout(r, 3000));
      const receiptResult = await getTransactionReceipt(this.primaryWalletCoordinator.client, {
        hash: txHash,
      }).catch(() => null);
      if (!receiptResult) {
        console.log(this.logTag + "⏱️ TIMING RESULT: TX not mined after 3s");
        return;
      }
      const probeBlock = Number(receiptResult.blockNumber);
      const sameBlock = probeBlock === event.blockNumber;
      const blockDelta = probeBlock - event.blockNumber;
      console.log(
        `${this.logTag}⏱️ TIMING RESULT: ${sameBlock ? "✅ SAME BLOCK" : `❌ +${blockDelta} blocks`} ` +
          `seq=${seqMs}ms rpc=${rpcMs}ms oracleBlock=${event.blockNumber} probeBlock=${probeBlock}`,
      );
    } catch (err) {
      console.log(
        `${this.logTag}⏱️ TIMING PROBE FAILED: ${err instanceof Error ? err.message.slice(0, 100) : "unknown"}`,
      );
    } finally {
      this.primaryWalletCoordinator.release(lease);
    }
  }

  /**
   * Fire-and-forget receipt watcher for batch-path TXs. Records final canary
   * outcome with real gas cost + pass/revert status. Counterpart of
   * LiquidationBot.verifyCanaryReceipt for the L2 batch path.
   */
  private async verifyBatchReceipt(
    txHash: Hex,
    prebuilt: PrebuiltTx,
    expectedProfitUsd: number,
  ): Promise<void> {
    if (!this.canary) return;
    const deadline = Date.now() + 30_000;
    let receipt: Awaited<ReturnType<typeof getTransactionReceipt>> | null = null;
    while (Date.now() < deadline) {
      try {
        receipt = await getTransactionReceipt(this.primaryWalletCoordinator.client, {
          hash: txHash,
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const nowMs = Date.now();
    const eventDate = new Date(nowMs).toISOString().slice(0, 10);

    if (!receipt) {
      this.canary.recordResult({
        timestamp: nowMs,
        eventDate,
        type: "revert",
        borrower: prebuilt.borrower,
        marketId: prebuilt.marketId,
        collateralSymbol: prebuilt.collateralSymbol,
        loanSymbol: prebuilt.loanSymbol ?? "",
        expectedProfitUsd,
        gasCostUsd: 0,
        actualProfitUsd: 0,
        txHash,
        errorMessage: "receipt_timeout_30s",
      });
      return;
    }

    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
    const gasCostWei = gasUsed * effectiveGasPrice;
    const gasCostUsd = (Number(gasCostWei) / 1e18) * 2500;
    const isSuccess = receipt.status === "success";
    this.canary.recordResult({
      timestamp: nowMs,
      eventDate,
      type: isSuccess ? "pass" : "revert",
      borrower: prebuilt.borrower,
      marketId: prebuilt.marketId,
      collateralSymbol: prebuilt.collateralSymbol,
      loanSymbol: prebuilt.loanSymbol ?? "",
      expectedProfitUsd,
      gasCostUsd,
      actualProfitUsd: isSuccess ? expectedProfitUsd - gasCostUsd : -gasCostUsd,
      txHash,
      effectiveGasPriceGwei: Number(effectiveGasPrice) / 1e9,
      gasUsed: gasUsed.toString(),
    });
  }
}
