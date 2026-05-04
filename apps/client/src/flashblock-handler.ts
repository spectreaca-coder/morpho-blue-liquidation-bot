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

import type { ChainConfig, PendingPrewarmFeedMap } from "@morpho-blue-liquidation-bot/config";
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
import { POLL_GAS_LIMIT, getPollGasParams } from "./poll-liquidation-trigger.js";
import { type PositionCache, calculateHF } from "./position-cache";
import type { PreSigner, PreSignedTx } from "./preSigner.js";
import { type PrimaryWalletCoordinator } from "./primary-wallet-coordinator";
import { type ShadowLogger } from "./shadow-logger";
import { TxCache, type PrebuiltTx } from "./tx-cache";
import { buildBloxroutePromise, loadBloxrouteConfig } from "./utils/bloxrouteSubmit.js";
import { getMinBorrowUsdc6Dec } from "./utils/harness-filter-bypass.js";
import { createEventTimer, type EventTimer } from "./utils/shadowTimingLogger.js";
import { isShadowMode, submitOrShadow } from "./utils/txSubmitter.js";

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
/** Gas limit for batched Flashblock liquidation txs. Kept as a single source so
 *  PreSigner cache-hit validation doesn't hardcode the literal twice. */
const FLASHBLOCK_GAS_LIMIT = POLL_GAS_LIMIT;

/** Max age of a PreSigned tx before we consider it stale and re-sign. */
const PRESIGN_MAX_AGE_MS = 30_000;
const PENDING_PREWARM_TTL_MS = 5_000;
/** Minimum USD borrow value to attempt liquidation. Below this, spray bot territory. */
const MIN_PROFIT_GATE_USD = 10;

/** Rough ETH price used only to bucket WETH-denominated borrows into USD tiers.
 *  Kept in sync with bot.ts ETH_USD_FALLBACK / auto-refuel.ts ETH_PRICE_USD_CONSERVATIVE.
 *  Stale values cause the priority-fee tier to misclassify ~$10K WETH borrows as MID
 *  instead of WHALE, losing same-block ordering on competitive positions. */
const WETH_USD_HEURISTIC = 3500;

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

function toTimingCandidateRef(borrower: `0x${string}`, marketId: Hex, collateralSymbol: string) {
  return {
    borrower,
    marketId,
    collateralSymbol,
  };
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
  private readonly preSigner?: PreSigner;
  private readonly pendingPrewarmFeeds?: PendingPrewarmFeedMap;

  /** Per-aggregator debounce: only attempt once per block per aggregator. */
  private readonly lastBlockByAggregator = new Map<string, number>();
  private readonly pendingSeenTxs = new Map<string, number>();

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

  // ---------------------------------------------------------------------------
  // PreSign aggregate telemetry counters (rolling window, reset after each emit)
  // ---------------------------------------------------------------------------
  private presignHit = 0;
  private miss_stale = 0;
  private miss_nonce = 0;
  private miss_calldata = 0;
  private miss_gas = 0;
  private miss_fee = 0;
  private miss_tip = 0;
  private cold_no_cache = 0;
  private batchCount = 0;
  /** Accumulated cold-sign latency samples (ms). */
  private coldSignLatencyMs: number[] = [];
  /** Accumulated presign-hit read latency samples (ms). */
  private presignHitLatencyMs: number[] = [];
  private metricsEmitInterval: ReturnType<typeof setInterval> | null = null;

  /** Interval (ms) between aggregate [PreSignMetrics] emits. */
  private static readonly METRICS_EMIT_INTERVAL_MS = 60_000;

  constructor(
    logTag: string,
    config: ChainConfig,
    bot: LiquidationBot,
    positionCache: PositionCache,
    txCache: TxCache,
    primaryWalletCoordinator: PrimaryWalletCoordinator,
    canary?: CanaryTracker,
    shadowLogger?: ShadowLogger,
    preSigner?: PreSigner,
    pendingPrewarmFeeds?: PendingPrewarmFeedMap,
  ) {
    this.logTag = logTag;
    this.config = config;
    this.bot = bot;
    this.positionCache = positionCache;
    this.txCache = txCache;
    this.primaryWalletCoordinator = primaryWalletCoordinator;
    this.canary = canary;
    this.shadowLogger = shadowLogger;
    this.preSigner = preSigner;
    this.pendingPrewarmFeeds = pendingPrewarmFeeds;

    if (this.bloxrouteConfig) {
      console.log(`${this.logTag}bloXroute Protect enabled → ${this.bloxrouteConfig.url}`);
    } else {
      console.log(
        `${this.logTag}bloXroute Protect disabled (BLXR_AUTH_HEADER/BLOXROUTE_BASE_AUTH unset)`,
      );
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

    // Periodic aggregate PreSign telemetry emit (rolling window).
    this.metricsEmitInterval = setInterval(() => {
      this._emitPreSignMetrics();
    }, FlashblockHandler.METRICS_EMIT_INTERVAL_MS);
  }

  /** Emit aggregate PreSign telemetry and reset counters for the next window. */
  private _emitPreSignMetrics(): void {
    const missCount =
      this.miss_stale +
      this.miss_nonce +
      this.miss_calldata +
      this.miss_gas +
      this.miss_fee +
      this.miss_tip +
      this.cold_no_cache;
    const coldAvg =
      this.coldSignLatencyMs.length > 0
        ? this.coldSignLatencyMs.reduce((a, b) => a + b, 0) / this.coldSignLatencyMs.length
        : 0;
    const hitAvg =
      this.presignHitLatencyMs.length > 0
        ? this.presignHitLatencyMs.reduce((a, b) => a + b, 0) / this.presignHitLatencyMs.length
        : 0;
    console.log(
      `${this.logTag}[PreSignMetrics] hit=${this.presignHit} miss_stale=${this.miss_stale} ` +
        `miss_nonce=${this.miss_nonce} miss_calldata=${this.miss_calldata} miss_gas=${this.miss_gas} ` +
        `miss_fee=${this.miss_fee} miss_tip=${this.miss_tip} cold_no_cache=${this.cold_no_cache} ` +
        `missCount=${missCount} coldSignAvgMs=${coldAvg.toFixed(2)} hitReadAvgMs=${hitAvg.toFixed(2)} ` +
        `batches=${this.batchCount}`,
    );
    // Reset rolling window
    this.presignHit = 0;
    this.miss_stale = 0;
    this.miss_nonce = 0;
    this.miss_calldata = 0;
    this.miss_gas = 0;
    this.miss_fee = 0;
    this.miss_tip = 0;
    this.cold_no_cache = 0;
    this.batchCount = 0;
    this.coldSignLatencyMs = [];
    this.presignHitLatencyMs = [];
  }

  dispose(): void {
    if (this.gasPriceRefreshInterval !== null) {
      clearInterval(this.gasPriceRefreshInterval);
      this.gasPriceRefreshInterval = null;
    }
    if (this.metricsEmitInterval !== null) {
      clearInterval(this.metricsEmitInterval);
      this.metricsEmitInterval = null;
    }
  }

  /**
   * Expose full cleanup for external shutdown. Calls dispose() internally.
   * No change to construction or wiring — expose only for future use.
   */
  destroy(): void {
    this.dispose();
  }

  /**
   * Main entry point. Called by FlashblockWatcher on each oracle update event.
   * All business logic preserved exactly from the original index.ts callback.
   */
  handleOracleUpdate(event: OracleUpdateEvent): void {
    if (event.source === "alchemy-pending") {
      this.handlePendingOracleUpdate(event);
      return;
    }

    const eventTimer: EventTimer = createEventTimer("flashblock", {
      oracleAddress: event.aggregatorAddress,
      oracleBlockNumber: event.blockNumber,
    });
    eventTimer.setHandlerDispatch();

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
      const defaultMinBorrow = loanDec <= 8 ? MIN_BORROW_USDC_6DEC : MIN_BORROW_WETH_18DEC;
      const minBorrow = getMinBorrowUsdc6Dec(this.config.chainId, defaultMinBorrow);
      return c.borrowAssets >= minBorrow;
    });

    if (nearLiquidation.length > 0) {
      // BATCH FIRE: collect all candidates, sign all TXs with sequential nonces, send simultaneously.
      // Previous approach: acquire wallet per candidate → pool full after 1st → rest fallback to slow path.
      // New approach: acquire wallet ONCE, sign N TXs with nonce, nonce+1, ..., send ALL at once.
      const candidates = nearLiquidation.slice(0, 10).filter((candidate) => {
        const ref = toTimingCandidateRef(
          candidate.position.borrower,
          candidate.position.marketId,
          candidate.position.collateralSymbol,
        );
        const key = `${candidate.position.borrower.toLowerCase()}:${candidate.position.marketId}`;
        if (this.inFlightBorrowers.has(key)) {
          eventTimer.addCandidate(ref);
          eventTimer.setSkipped(ref, "in-flight");
          return false;
        }
        const MAX_IN_FLIGHT = 100;
        const EVICT_TARGET = 50;
        if (this.inFlightBorrowers.size > MAX_IN_FLIGHT) {
          const toEvict = Array.from(this.inFlightBorrowers).slice(
            0,
            this.inFlightBorrowers.size - EVICT_TARGET,
          );
          for (const staleKey of toEvict) this.inFlightBorrowers.delete(staleKey);
        }
        this.inFlightBorrowers.add(key);
        return true;
      });

      if (candidates.length === 0) return;

      // Sprint 51b: register all candidates in the timer for fan-out rows.
      for (const c of candidates) {
        eventTimer.addCandidate(
          toTimingCandidateRef(
            c.position.borrower,
            c.position.marketId,
            c.position.collateralSymbol,
          ),
        );
      }

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

      if (cacheHits.length > 0) {
        const lease = this.primaryWalletCoordinator.tryAcquire(
          `flashblock-batch:${event.blockNumber}:${symbolPatterns.join(",") || "unknown"}`,
        );
        if (lease === null) {
          console.log(`${this.logTag}FLASHBLOCK: primary wallet busy — skipping cached batch`);
          for (const { candidate: c } of cacheHits) {
            eventTimer.setSkipped(
              toTimingCandidateRef(
                c.position.borrower,
                c.position.marketId,
                c.position.collateralSymbol,
              ),
              "busy-wallet",
            );
            this.inFlightBorrowers.delete(
              `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
            );
          }
          for (const c of cacheMisses) {
            eventTimer.setSkipped(
              toTimingCandidateRef(
                c.position.borrower,
                c.position.marketId,
                c.position.collateralSymbol,
              ),
              "busy-wallet",
            );
            this.inFlightBorrowers.delete(
              `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
            );
          }
          eventTimer.flush();
          return;
        }

        this.isBatchInFlight = true;
        for (const c of cacheMisses) {
          eventTimer.setSkipped(
            toTimingCandidateRef(
              c.position.borrower,
              c.position.marketId,
              c.position.collateralSymbol,
            ),
            "in-flight",
          );
          this.inFlightBorrowers.delete(
            `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
          );
        }

        const sequencerUrl =
          this.config.chainId === 8453 ? "https://mainnet-sequencer.base.org" : undefined;
        const allCacheHitsSnapshot = [...cacheHits];

        void (async () => {
          const baseMaxFeePerGas = this.cachedMaxFeePerGas;
          const floorPriorityFee = this.cachedMaxPriorityFeePerGas;

          if (isRateFeed) {
            const oraclePrices = new Map<string, bigint>();
            const oracleReadFailed = new Set<string>();
            for (const { candidate: c } of cacheHits) {
              const oracleAddr = c.position.oracle.toLowerCase();
              if (!oraclePrices.has(oracleAddr) && !oracleReadFailed.has(oracleAddr)) {
                try {
                  const price = await readContract(this.primaryWalletCoordinator.client, {
                    address: c.position.oracle,
                    abi: ORACLE_PRICE_ABI,
                    functionName: "price",
                  });
                  oraclePrices.set(oracleAddr, price);
                } catch (err) {
                  // Fail-closed: cannot verify HF, skip to avoid revert on false positive.
                  // RATE_FEED candidates have ~high false-positive rate from blue-api lag.
                  oracleReadFailed.add(oracleAddr);
                  console.warn(
                    `${this.logTag}⚡ RATE FEED oracle read failed for ${oracleAddr} — skipping candidates (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }

            const allCacheHits = [...cacheHits];
            cacheHits = cacheHits.filter(({ candidate: c }) => {
              const oracleAddr = c.position.oracle.toLowerCase();
              if (oracleReadFailed.has(oracleAddr)) {
                eventTimer.setSkipped(
                  toTimingCandidateRef(
                    c.position.borrower,
                    c.position.marketId,
                    c.position.collateralSymbol,
                  ),
                  "gate-fail",
                );
                return false;
              }
              const oraclePrice = oraclePrices.get(oracleAddr);
              if (!oraclePrice) return true;
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
                eventTimer.setSkipped(
                  toTimingCandidateRef(
                    c.position.borrower,
                    c.position.marketId,
                    c.position.collateralSymbol,
                  ),
                  "gate-fail",
                );
                return false;
              }
              return true;
            });

            if (cacheHits.length === 0 && allCacheHits.length > 0) {
              console.log(
                `${this.logTag}⚡ RATE FEED HF GATE: all ${allCacheHits.length} candidates healthy — aborting batch`,
              );
              return;
            }
          }

          const signedTxs: {
            signed: Hex;
            prebuilt: PrebuiltEntry["prebuilt"];
            nonce: number;
            maxFeePerGas: bigint;
            maxPriorityFeePerGas: bigint;
          }[] = [];
          let hitCount = 0;

          for (const { candidate: c, prebuilt } of cacheHits) {
            const candidateRef = toTimingCandidateRef(
              prebuilt.borrower,
              prebuilt.marketId,
              prebuilt.collateralSymbol,
            );
            if (this.canary) {
              const usd = estimateBorrowUsd(prebuilt);
              const decision = this.canary.shouldAttempt({
                collateralSymbol: prebuilt.collateralSymbol,
                expectedBorrowUsd: usd,
                lltvWad: prebuilt.lltv,
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
                  expectedBorrowUsd: usd,
                  lltvWad: prebuilt.lltv,
                  estimatedProfitUsd: 0,
                  gasCostUsd: 0,
                  actualProfitUsd: 0,
                  skipReason: decision.reason,
                });
                eventTimer.setSkipped(candidateRef, "gate-fail");
                continue;
              }
            }

            const calldata = encodeFunctionData({
              abi: TxCache.functionData.abi,
              functionName: TxCache.functionData.functionName,
              args: [prebuilt.calls],
            });
            eventTimer.setCalldataReady(candidateRef);

            const dynamicTip = estimatePriorityFeeWei(prebuilt);
            const maxPriorityFeePerGas =
              dynamicTip > floorPriorityFee ? dynamicTip : floorPriorityFee;
            // Hot-path floor: 1 gwei (lowered 2026-05-04 from 2 gwei to fit bootstrap
            // wallet balances; W2 0.0013 ETH < 2 gwei × 700K = 0.0014 ETH was failing
            // every fast-path with "total cost exceeds balance"). Still higher than
            // auto-refuel's 0.1 gwei because liquidations are time-critical, but 1 gwei
            // gives 10x headroom over normal Base baseFee (<0.1 gwei). Raise once wallets
            // are funded above 0.005 ETH and re-run competitor analysis.
            const MAX_FEE_FLOOR = 1_000_000_000n;
            const dynamicCap =
              baseMaxFeePerGas > maxPriorityFeePerGas
                ? baseMaxFeePerGas
                : baseMaxFeePerGas + maxPriorityFeePerGas;
            const maxFeePerGas = dynamicCap > MAX_FEE_FLOOR ? dynamicCap : MAX_FEE_FLOOR;
            const cached: PreSignedTx | undefined = this.preSigner?.get(
              c.position.borrower,
              c.position.marketId,
            );
            const cachedAgeMs = cached === undefined ? undefined : Date.now() - cached.createdAt;
            let nonce: number | undefined;

            let reuseReason:
              | "hit"
              | "miss_none"
              | "miss_nonce"
              | "miss_fee"
              | "miss_tip"
              | "miss_calldata"
              | "miss_stale"
              | "miss_gas" = "miss_none";
            let signed: Hex | undefined;

            if (cached !== undefined) {
              if ((cachedAgeMs ?? 0) > PRESIGN_MAX_AGE_MS) {
                reuseReason = "miss_stale";
                this.miss_stale += 1;
                this.preSigner?.invalidate(c.position.borrower, c.position.marketId);
              } else if (cached.calldata !== calldata) {
                reuseReason = "miss_calldata";
                this.miss_calldata += 1;
                this.preSigner?.invalidate(c.position.borrower, c.position.marketId);
              } else if (cached.gas !== FLASHBLOCK_GAS_LIMIT) {
                reuseReason = "miss_gas";
                this.miss_gas += 1;
                this.preSigner?.invalidate(c.position.borrower, c.position.marketId);
              } else if (cached.maxFeePerGas < maxFeePerGas) {
                reuseReason = "miss_fee";
                this.miss_fee += 1;
                this.preSigner?.invalidate(c.position.borrower, c.position.marketId);
              } else if (cached.maxPriorityFeePerGas < maxPriorityFeePerGas) {
                reuseReason = "miss_tip";
                this.miss_tip += 1;
                this.preSigner?.invalidate(c.position.borrower, c.position.marketId);
              } else {
                if (this.primaryWalletCoordinator.claimReservedNonce(lease, cached.nonce)) {
                  nonce = cached.nonce;
                  reuseReason = "hit";
                  const hitReadStart = performance.now();
                  signed = cached.signedTx;
                  this.presignHitLatencyMs.push(performance.now() - hitReadStart);
                  this.presignHit += 1;
                  hitCount += 1;
                } else {
                  nonce = await this.primaryWalletCoordinator.nextNonce(lease);
                  if (cached.nonce === nonce) {
                    reuseReason = "hit";
                    const hitReadStart = performance.now();
                    signed = cached.signedTx;
                    this.presignHitLatencyMs.push(performance.now() - hitReadStart);
                    this.presignHit += 1;
                    hitCount += 1;
                  } else {
                    reuseReason = "miss_nonce";
                    this.miss_nonce += 1;
                    this.preSigner?.invalidate(c.position.borrower, c.position.marketId);
                  }
                }
              }
            } else {
              this.cold_no_cache += 1;
            }

            console.log(
              `${this.logTag}[PreSign] ${reuseReason} borrower=${c.position.borrower.slice(0, 10)} ` +
                `market=${c.position.marketId.slice(0, 10)} nonce=${nonce ?? "-"} ` +
                `cachedMaxFee=${cached?.maxFeePerGas ?? "-"} reqMaxFee=${maxFeePerGas} ` +
                `cachedTip=${cached?.maxPriorityFeePerGas ?? "-"} reqTip=${maxPriorityFeePerGas} ` +
                `age=${cachedAgeMs ?? "-"}ms`,
            );

            if (signed === undefined) {
              try {
                if (nonce === undefined) {
                  nonce = await this.primaryWalletCoordinator.nextNonce(lease);
                }
                const coldSignStart = performance.now();
                signed = await this.primaryWalletCoordinator.client.signTransaction({
                  to: this.primaryWalletCoordinator.executorAddress,
                  data: calldata,
                  gas: FLASHBLOCK_GAS_LIMIT,
                  maxFeePerGas,
                  maxPriorityFeePerGas,
                  nonce,
                  type: "eip1559" as const,
                });
                this.coldSignLatencyMs.push(performance.now() - coldSignStart);
              } catch (error) {
                if (nonce !== undefined) {
                  this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
                }
                throw error;
              }
            }

            eventTimer.setSignComplete(candidateRef, reuseReason === "hit");
            if (nonce === undefined) throw new Error("nonce unavailable after signing");
            signedTxs.push({
              signed,
              prebuilt,
              nonce,
              maxFeePerGas,
              maxPriorityFeePerGas,
            });
          }

          this.batchCount += 1;
          console.log(`${this.logTag}⚡ BATCH PRESIGN: ${hitCount}/${signedTxs.length}`);
          console.log(
            `${this.logTag}⚡ BATCH SIGNED: ${signedTxs.length} TXs (nonces ${signedTxs[0]?.nonce}-${signedTxs[signedTxs.length - 1]?.nonce})`,
          );

          const sendResults = await Promise.allSettled(
            signedTxs.map(
              async ({ signed, prebuilt, nonce, maxFeePerGas, maxPriorityFeePerGas }) => {
                const candidateRef = toTimingCandidateRef(
                  prebuilt.borrower,
                  prebuilt.marketId,
                  prebuilt.collateralSymbol,
                );
                eventTimer.setWouldSubmit(candidateRef);
                const promises: Promise<string>[] = [
                  submitOrShadow({
                    path: "alchemy",
                    triggerPath: "flashblock",
                    candidateRef,
                    gasParams: {
                      nonce,
                      gas: FLASHBLOCK_GAS_LIMIT,
                      maxFeePerGas,
                      maxPriorityFeePerGas,
                    },
                    serializedTx: signed,
                    submit: () =>
                      sendRawTransaction(this.primaryWalletCoordinator.client, {
                        serializedTransaction: signed,
                      }),
                    createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
                  }),
                ];
                if (sequencerUrl) {
                  promises.push(
                    submitOrShadow({
                      path: "sequencer",
                      triggerPath: "flashblock",
                      candidateRef,
                      gasParams: {
                        nonce,
                        gas: FLASHBLOCK_GAS_LIMIT,
                        maxFeePerGas,
                        maxPriorityFeePerGas,
                      },
                      serializedTx: signed,
                      metadata: { url: sequencerUrl },
                      submit: () =>
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
                      createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
                    }),
                  );
                }
                if (this.bloxrouteConfig) {
                  promises.push(
                    submitOrShadow({
                      path: "bloxroute",
                      triggerPath: "flashblock",
                      candidateRef,
                      gasParams: {
                        nonce,
                        gas: FLASHBLOCK_GAS_LIMIT,
                        maxFeePerGas,
                        maxPriorityFeePerGas,
                      },
                      serializedTx: signed,
                      submit: () => buildBloxroutePromise(this.bloxrouteConfig!, signed),
                      createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
                    }),
                  );
                }
                const txHash = await Promise.any(promises);
                this.preSigner?.invalidate(prebuilt.borrower, prebuilt.marketId);
                const broadcastedMs = Date.now();
                console.log(
                  `${this.logTag}⚡ BATCH TX SENT: ${prebuilt.borrower.slice(0, 10)}... ${prebuilt.collateralSymbol}/${prebuilt.loanSymbol} tx=${txHash} (nonce=${nonce})`,
                );

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
                    expectedBorrowUsd: usd,
                    lltvWad: prebuilt.lltv,
                    estimatedProfitUsd: 0,
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

          let sent = 0;
          let failed = 0;
          for (const result of sendResults) {
            if (result.status === "fulfilled") sent++;
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
            console.error(`${this.logTag}Batch error:`, e instanceof Error ? e.message : String(e));
            this.primaryWalletCoordinator.resetNonceCache(lease);
          })
          .finally(() => {
            this.isBatchInFlight = false;
            this.primaryWalletCoordinator.release(lease);
            for (const { candidate: c } of allCacheHitsSnapshot) {
              this.inFlightBorrowers.delete(
                `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
              );
            }
            eventTimer.flush();
          });
        return;
      }

      void (async () => {
        let activeMisses = cacheMisses;
        if (isRateFeed && cacheMisses.length > 0) {
          const oraclePricesFresh = new Map<string, bigint>();
          const oracleReadFailedFresh = new Set<string>();
          for (const c of cacheMisses) {
            const oracleAddr = c.position.oracle.toLowerCase();
            if (!oraclePricesFresh.has(oracleAddr) && !oracleReadFailedFresh.has(oracleAddr)) {
              try {
                const price = await readContract(this.primaryWalletCoordinator.client, {
                  address: c.position.oracle,
                  abi: ORACLE_PRICE_ABI,
                  functionName: "price",
                });
                oraclePricesFresh.set(oracleAddr, price);
              } catch (err) {
                // Fail-closed: cannot verify HF, skip to avoid revert on false positive.
                // RATE_FEED cache-miss candidates have ~high false-positive rate from blue-api lag.
                oracleReadFailedFresh.add(oracleAddr);
                console.warn(
                  `${this.logTag}⚡ RATE FEED (fresh) oracle read failed for ${oracleAddr} — skipping candidates (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
          activeMisses = cacheMisses.filter((c) => {
            const oracleAddr = c.position.oracle.toLowerCase();
            if (oracleReadFailedFresh.has(oracleAddr)) {
              eventTimer.setSkipped(
                toTimingCandidateRef(
                  c.position.borrower,
                  c.position.marketId,
                  c.position.collateralSymbol,
                ),
                "gate-fail",
              );
              this.inFlightBorrowers.delete(
                `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
              );
              return false;
            }
            const oraclePrice = oraclePricesFresh.get(oracleAddr);
            if (!oraclePrice) return true;
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
              eventTimer.setSkipped(
                toTimingCandidateRef(
                  c.position.borrower,
                  c.position.marketId,
                  c.position.collateralSymbol,
                ),
                "gate-fail",
              );
              this.inFlightBorrowers.delete(
                `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
              );
              return false;
            }
            return true;
          });
        }
        await Promise.allSettled(
          activeMisses.map((c) => {
            const candidateRef = toTimingCandidateRef(
              c.position.borrower,
              c.position.marketId,
              c.position.collateralSymbol,
            );
            eventTimer.setWouldSubmit(candidateRef);
            return this.bot
              .fastLiquidate(c.position, c.seizableCollateral, c.borrowAssets)
              .catch((e: unknown) => {
                console.error(
                  `${this.logTag}Fast liquidate error:`,
                  e instanceof Error ? e.message : e,
                );
              })
              .finally(() => {
                this.inFlightBorrowers.delete(
                  `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
                );
              });
          }),
        );
      })()
        .catch((e: unknown) => {
          console.error(
            `${this.logTag}Fresh path HF gate error:`,
            e instanceof Error ? e.message : e,
          );
        })
        .finally(() => {
          for (const c of cacheMisses) {
            this.inFlightBorrowers.delete(
              `${c.position.borrower.toLowerCase()}:${c.position.marketId}`,
            );
          }
          eventTimer.flush();
        });
    }
  }

  private handlePendingOracleUpdate(event: OracleUpdateEvent): void {
    const pendingTimer = createEventTimer("pending-prewarm", {
      oracleAddress: event.aggregatorAddress,
      oracleBlockNumber: event.blockNumber ?? 0,
    });
    pendingTimer.setHandlerDispatch();

    if (
      this.preSigner === undefined ||
      this.pendingPrewarmFeeds === undefined ||
      Object.keys(this.pendingPrewarmFeeds).length === 0
    ) {
      return;
    }

    const now = Date.now();
    for (const [key, seenAt] of this.pendingSeenTxs) {
      if (now - seenAt >= PENDING_PREWARM_TTL_MS) {
        this.pendingSeenTxs.delete(key);
      }
    }

    const aggregatorAddress = event.aggregatorAddress.toLowerCase();
    const feed = this.pendingPrewarmFeeds[aggregatorAddress];
    if (feed === undefined) return;

    const dedupKey = `${aggregatorAddress}:${event.rawTx}`;
    const seenAt = this.pendingSeenTxs.get(dedupKey);
    if (seenAt !== undefined && now - seenAt < PENDING_PREWARM_TTL_MS) return;
    this.pendingSeenTxs.set(dedupKey, now);

    const allowedMarketIds = new Set(feed.marketIds.map((marketId) => marketId.toLowerCase()));
    const candidates = this.positionCache
      .findNearLiquidation(1.05)
      .filter((candidate) => allowedMarketIds.has(candidate.position.marketId.toLowerCase()));
    const topCandidate = candidates[0];
    if (topCandidate === undefined) return;

    const candidateRef = toTimingCandidateRef(
      topCandidate.position.borrower,
      topCandidate.position.marketId,
      topCandidate.position.collateralSymbol,
    );
    pendingTimer.addCandidate(candidateRef);

    if (this.primaryWalletCoordinator.isBusy) {
      pendingTimer.setSkipped(candidateRef, "busy-wallet");
      pendingTimer.flush();
      return;
    }

    console.log(
      `${this.logTag}[PendingPrewarm] feed=${feed.feedName} aggregator=${aggregatorAddress} ` +
        `borrower=${topCandidate.position.borrower} market=${topCandidate.position.marketId} candidates=${candidates.length}`,
    );

    void this.prewarmPendingCandidate(
      topCandidate.position.borrower,
      topCandidate.position.marketId,
      topCandidate.position.collateralSymbol,
      pendingTimer,
    )
      .catch((error: unknown) => {
        console.error(
          `${this.logTag}[PendingPrewarm] error:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        pendingTimer.flush();
      });
  }

  private async prewarmPendingCandidate(
    borrower: `0x${string}`,
    marketId: Hex,
    collateralSymbol: string,
    pendingTimer: EventTimer,
  ): Promise<void> {
    if (this.preSigner === undefined) return;

    await this.txCache.rebuildOne(borrower, marketId);
    const prebuilt = this.txCache.get(borrower, marketId);
    if (prebuilt === undefined) {
      pendingTimer.setSkipped(
        toTimingCandidateRef(borrower, marketId, collateralSymbol),
        "no-cache",
      );
      return;
    }
    pendingTimer.setCalldataReady(
      toTimingCandidateRef(borrower, marketId, prebuilt.collateralSymbol),
    );

    const calldata = TxCache.encodeCalldata(prebuilt);

    const nonce = await this.primaryWalletCoordinator.reserveNonce(
      `pending-prewarm:${borrower.toLowerCase()}:${marketId}`,
      PRESIGN_MAX_AGE_MS,
    );
    const { maxFeePerGas, maxPriorityFeePerGas } = await getPollGasParams(
      this.primaryWalletCoordinator.client,
      prebuilt,
    );

    try {
      await this.preSigner.presign(
        borrower,
        marketId,
        calldata,
        nonce,
        POLL_GAS_LIMIT,
        maxFeePerGas,
        maxPriorityFeePerGas,
      );
    } catch (error) {
      this.primaryWalletCoordinator.releaseReservedNonce(nonce);
      throw error;
    }
    pendingTimer.setSignComplete(
      toTimingCandidateRef(borrower, marketId, prebuilt.collateralSymbol),
      false,
    );
  }

  /** Timing probe: dual-path (wallet RPC vs sequencer direct) latency measurement */
  private lastProbeMs = 0;
  private async sendTimingProbe(event: OracleUpdateEvent): Promise<void> {
    const now = Date.now();
    if (now - this.lastProbeMs < 60_000) return;
    this.lastProbeMs = now;
    if (isShadowMode()) return;

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
    expectedBorrowUsd: number,
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
        expectedBorrowUsd,
        lltvWad: prebuilt.lltv,
        estimatedProfitUsd: 0,
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
    let gasCostUsd: number;
    try {
      gasCostUsd = await this.bot.usdValueFromEthAmount(gasCostWei);
    } catch {
      gasCostUsd = (Number(gasCostWei) / 1e18) * 3500;
    }
    const isSuccess = receipt.status === "success";
    this.canary.recordResult({
      timestamp: nowMs,
      eventDate,
      type: isSuccess ? "pass" : "revert",
      borrower: prebuilt.borrower,
      marketId: prebuilt.marketId,
      collateralSymbol: prebuilt.collateralSymbol,
      loanSymbol: prebuilt.loanSymbol ?? "",
      expectedBorrowUsd,
      lltvWad: prebuilt.lltv,
      estimatedProfitUsd: 0,
      gasCostUsd,
      actualProfitUsd: isSuccess ? expectedBorrowUsd - gasCostUsd : -gasCostUsd,
      txHash,
      effectiveGasPriceGwei: Number(effectiveGasPrice) / 1e9,
      gasUsed: gasUsed.toString(),
    });
  }
}
