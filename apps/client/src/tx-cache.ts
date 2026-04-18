/**
 * TX Cache — pre-builds liquidation calldata for near-liquidation positions.
 *
 * When an oracle update triggers a liquidation opportunity, the encoder build time
 * (venue selection + RPC calls in convert()) is the primary latency bottleneck.
 * This module pre-computes the full calldata for the top-N at-risk positions so
 * that on-trigger execution is a direct writeContract with no encoder overhead.
 *
 * Cache lifetime: 30 seconds (same cadence as PositionCache refresh).
 * Stale entries (>60 seconds) are discarded on retrieval.
 * Only the top 10 positions by borrow size are pre-built to bound RPC usage.
 */

import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { ChainAddresses, getChainAddresses } from "@morpho-org/blue-sdk";
import { executorAbi } from "executooor-viem";
import {
  getAddress,
  maxUint256,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { readContract } from "viem/actions";

import type { CachedPosition } from "./position-cache.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";
import { resolveShareLiquidationPlan } from "./utils/morphoLiquidation.js";

/** Maximum number of positions to pre-build TXs for per refresh cycle.
 *  Set high to cover ALL at-risk positions — eliminates cache misses on hot path.
 *  Build cost: ~800ms per unique token pair (route lookup), subsequent same-pair = ~5ms.
 *  With 6 pairs × 800ms = ~5s total, well within the 30-min refresh window. */
const MAX_CACHED_POSITIONS = 200;

/** Maximum age in milliseconds before a cached TX is considered stale.
 *  Timer refresh is 30 min, but event-driven refresh triggers on >1% price moves.
 *  Stale threshold is generous to avoid cache miss during quiet periods. */
const STALE_THRESHOLD_MS = 12 * 60_000; // 12 minutes (timer is 10 min, event-driven fills gaps)

/** Balancer Vault address for non-standard ERC20 (USDT) flash loans. */
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address;

/** USDT and other tokens that require Balancer flash loan instead of Morpho. */
const KNOWN_NON_STANDARD = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
]);

/**
 * Collateral tokens with no viable swap route on any venue.
 * Skip these in TxCache.buildOne() to avoid repeated venue errors that waste Alchemy CU.
 * (UniswapV4 eth_getLogs hits Alchemy free tier 10-block limit; PendlePT rate-limits.)
 */
const SKIP_COLLATERAL_SYMBOLS = new Set([
  "mbasis", // mBASIS → USDC: no Uniswap/Aerodrome pool, burns 2 RPC per attempt
  "wbcoin", // wbCOIN → USDC: same issue
]);

const CBXRP_FAST_PATH_SEIZE_BPS = 500n;
const BPS = 10_000n;

/**
 * Thrown by buildOne when the failure is due to an HTTP/network error rather than
 * an on-chain revert or a missing venue.  The caller (build()) catches this and
 * keeps the existing cached TX instead of nullifying it.
 */
class HttpBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpBuildError";
  }
}

/**
 * Returns true when an error originates from a transport/network failure rather
 * than an on-chain revert or a missing swap route.
 *
 * Heuristic: viem wraps HTTP errors as HttpRequestError / FetchError / TimeoutError;
 * fetch failures contain "fetch failed" or "ECONNRESET" in the message; timeouts
 * contain "timeout".  On-chain reverts carry "execution reverted" or "revert".
 */
function isHttpError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("execution reverted") || msg.includes("revert")) return false;
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("network error") ||
    msg.includes("httprequesterror") ||
    msg.includes("fetcherror") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500")
  );
}

export interface PrebuiltTx {
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
  loanSymbol: string;
  lltv: bigint;
  /** Encoded executor calls ready for exec_606BaXt(calls). */
  calls: Hex[];
  borrowAssets: bigint;
  seizableCollateral: bigint;
  /** Unix timestamp in milliseconds when this TX was built. */
  builtAt: number;
}

export interface TxCacheInputs {
  logTag: string;
  chainId: number;
  client: WalletClient<Transport, Chain, Account>;
  executorAddress: Address;
  treasuryAddress: Address;
  liquidityVenues: LiquidityVenue[];
  /** Optional: override liquidation buffer in BPS (default: DEFAULT_LIQUIDATION_BUFFER_BPS). */
  liquidationBufferBps?: number;
}

export class TxCache {
  private readonly logTag: string;
  private readonly chainId: number;
  private readonly client: WalletClient<Transport, Chain, Account>;
  private readonly executorAddress: Address;
  private readonly treasuryAddress: Address;
  private readonly liquidityVenues: LiquidityVenue[];
  private readonly chainAddresses: ChainAddresses;
  private readonly liquidationBufferBps: number;

  /** Map keyed by "<borrower_lower>-<marketId_lower>" to PrebuiltTx. */
  private cache = new Map<string, PrebuiltTx>();

  /**
   * Tracks collateral→loan pairs for which no venue was found.
   * Key: "<collateral_lower>-<loan_lower>", value: timestamp of failure.
   * Entries expire after ROUTE_COOLDOWN_MS so newly-added venues can be tried.
   */
  private failedRoutes = new Map<string, number>();

  /** How long to suppress retries for a route with no known venue (5 minutes). */
  private static readonly ROUTE_COOLDOWN_MS = 5 * 60 * 1_000;

  constructor(inputs: TxCacheInputs) {
    this.logTag = inputs.logTag;
    this.chainId = inputs.chainId;
    this.client = inputs.client;
    this.executorAddress = inputs.executorAddress;
    this.treasuryAddress = inputs.treasuryAddress;
    this.liquidityVenues = inputs.liquidityVenues;
    this.chainAddresses = getChainAddresses(inputs.chainId);
    this.liquidationBufferBps = inputs.liquidationBufferBps ?? DEFAULT_LIQUIDATION_BUFFER_BPS;
  }

  /**
   * Pre-build liquidation TX calldata for the given at-risk positions.
   *
   * Processes the top MAX_CACHED_POSITIONS entries (sorted by borrow size descending).
   * Each build attempt is independent — a failed venue lookup for one position does
   * not affect others.
   *
   * @param positions - At-risk positions from PositionCache (any ordering).
   */
  async build(positions: CachedPosition[]): Promise<void> {
    if (positions.length === 0) {
      this.cache.clear();
      return;
    }

    // Prune expired entries from failedRoutes to prevent unbounded growth
    const now = Date.now();
    for (const [key, ts] of this.failedRoutes) {
      if (now - ts >= TxCache.ROUTE_COOLDOWN_MS) this.failedRoutes.delete(key);
    }

    // Compute borrow assets for sorting (mirrors PositionCache.findNearLiquidation logic)
    const VIRTUAL_ASSETS = 1n;
    const VIRTUAL_SHARES = 1_000_000n;

    interface SortEntry {
      pos: CachedPosition;
      borrowAssets: bigint;
    }
    const entries: SortEntry[] = positions.map((pos) => {
      const denominator = pos.totalBorrowShares + VIRTUAL_SHARES;
      const borrowAssets =
        (pos.borrowShares * (pos.totalBorrowAssets + VIRTUAL_ASSETS) + denominator - 1n) /
        denominator;
      return { pos, borrowAssets };
    });

    // Sort descending by borrow size — most profitable positions first
    entries.sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : -1));

    // Filter out tokens with no viable swap route BEFORE slicing top N.
    // Without this, exotic tokens (mBASIS, wbCOIN) can fill all N slots,
    // leaving no room for buildable positions like cbBTC/USDC.
    const buildable = entries.filter(
      ({ pos }) => !SKIP_COLLATERAL_SYMBOLS.has(pos.collateralSymbol.toLowerCase()),
    );
    const top = buildable.slice(0, MAX_CACHED_POSITIONS);
    const newCache = new Map<string, PrebuiltTx>();

    let builtCount = 0;

    for (const { pos, borrowAssets } of top) {
      const key = this.cacheKey(pos.borrower, pos.marketId);

      try {
        const prebuilt = await this.buildOne(pos, borrowAssets);
        if (prebuilt !== null) {
          newCache.set(key, prebuilt);
          builtCount++;
        } else {
          console.log(
            `${this.logTag}TxCache: NULL for ${pos.collateralSymbol}→${pos.loanSymbol} (borrower: ${pos.borrower.slice(0, 10)})`,
          );
        }
      } catch (err) {
        if (err instanceof HttpBuildError) {
          // HTTP/network failure — preserve the existing cached TX rather than
          // nullifying it.  A slightly stale TX is better than no TX at all.
          // The HF gate in flashblock-handler re-validates the position before
          // firing, so a stale pre-built TX cannot cause an incorrect liquidation.
          const existing = this.cache.get(key);
          if (existing !== undefined) {
            newCache.set(key, existing);
            console.log(
              `${this.logTag}TxCache: HTTP error for ${pos.collateralSymbol}→${pos.loanSymbol} — keeping existing cache`,
            );
          } else {
            console.warn(
              `${this.logTag}TxCache: HTTP error for ${pos.collateralSymbol}→${pos.loanSymbol} — no existing cache to keep`,
            );
          }
        } else {
          console.warn(
            `${this.logTag}TxCache: failed to build TX for ${pos.borrower} ` +
              `${pos.collateralSymbol}/${pos.loanSymbol}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    this.cache = newCache;
    console.log(
      `${this.logTag}TxCache: built ${builtCount} TXs for ${top.length} positions ` +
        `(${positions.length} total at-risk)`,
    );
    (() => {
      try {
        const hs = (globalThis as any).__healthState;
        hs.txCacheBuiltCount = builtCount;
        hs.txCacheTotalAtRisk = positions.length;
      } catch {
        /* ignore */
      }
    })();
  }

  /**
   * Retrieve a pre-built TX for the given borrower and market.
   *
   * Returns undefined if no TX is cached or the cached TX is stale (>60 seconds).
   *
   * @param borrower - Borrower address.
   * @param marketId - Market ID hex string.
   */
  get(borrower: Address, marketId: Hex): PrebuiltTx | undefined {
    const key = this.cacheKey(borrower, marketId);
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;

    const age = Date.now() - entry.builtAt;
    if (age > STALE_THRESHOLD_MS) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  /**
   * Return all cached TXs sorted by borrow size descending.
   *
   * Stale entries are excluded from the result.
   */
  getAll(): PrebuiltTx[] {
    const now = Date.now();
    const result: PrebuiltTx[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.builtAt > STALE_THRESHOLD_MS) {
        this.cache.delete(key);
        continue;
      }
      result.push(entry);
    }

    result.sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : -1));
    return result;
  }

  /** Returns the route key for a collateral→loan pair. */
  private routeKey(src: Address, dst: Address): string {
    return `${src.toLowerCase()}-${dst.toLowerCase()}`;
  }

  /**
   * Build calldata for a single position.
   *
   * Mirrors the fastLiquidate flow in bot.ts exactly:
   *   1. Build collateral→loan conversion calls via venues
   *   2. approve + liquidate (with conversion as callback)
   *   3. Wrap in flash loan (Morpho standard / Balancer for USDT)
   *   4. Skim remaining to treasury
   *
   * @returns PrebuiltTx on success, null if no venue supports the route.
   */
  private async buildOne(pos: CachedPosition, borrowAssets: bigint): Promise<PrebuiltTx | null> {
    // Skip tokens with no known swap route — avoids repeated venue errors that waste CU.
    if (SKIP_COLLATERAL_SYMBOLS.has(pos.collateralSymbol.toLowerCase())) {
      return null;
    }

    // Skip routes that previously had no venue, until the cooldown expires.
    const rKey = this.routeKey(pos.collateralToken, pos.loanToken);
    const lastFail = this.failedRoutes.get(rKey);
    if (lastFail !== undefined && Date.now() - lastFail < TxCache.ROUTE_COOLDOWN_MS) {
      console.log(
        `${this.logTag}TxCache: SKIP (cooldown) ${pos.collateralSymbol}→${pos.loanSymbol}`,
      );
      return null;
    }

    const morpho = this.chainAddresses.morpho;
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);

    const marketParams = {
      loanToken: pos.loanToken,
      collateralToken: pos.collateralToken,
      oracle: pos.oracle,
      irm: pos.irm,
      lltv: pos.lltv,
    };

    // Always apply buffer to seizable collateral. Using pos.collateral directly
    // would match the bad-debt branch in fastLiquidate (seizableCollateral === collateral).
    // By applying the buffer here, we seize slightly less than max — safe for normal
    // liquidations and only marginally suboptimal for true bad debt ($0.001 revert cost).
    const seizableCollateral = pos.collateral > 0n ? pos.collateral - 1n : 0n;
    const decreasedSeizable = wMulDown(
      seizableCollateral,
      WAD - parseUnits(this.liquidationBufferBps.toString(), 14),
    );
    // cbXRP: use repaidShares path with 5% seize cap to avoid Morpho underflow.
    // All other tokens: use original seizedAssets path (proven, no oracle read needed).
    const isCbXRP = pos.collateralSymbol === "cbXRP";
    const cappedSeizable = isCbXRP
      ? (decreasedSeizable * CBXRP_FAST_PATH_SEIZE_BPS) / BPS
      : decreasedSeizable;

    // For cbXRP, resolve share-based liquidation plan (requires oracle price).
    let liquidationPlan: {
      repaidShares: bigint;
      repaidAssets: bigint;
      seizedAssets: bigint;
    } | null = null;
    if (isCbXRP) {
      let oraclePrice: bigint;
      try {
        oraclePrice = await readContract(this.client, {
          address: marketParams.oracle,
          abi: [
            {
              name: "price",
              type: "function",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "uint256" }],
            },
          ] as const,
          functionName: "price",
        });
      } catch (err) {
        if (isHttpError(err)) {
          throw new HttpBuildError(
            `oracle price read failed (HTTP) for ${pos.collateralSymbol}/${pos.loanSymbol}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        console.warn(
          `${this.logTag}TxCache: cannot read oracle price for ${pos.collateralSymbol}/${pos.loanSymbol}`,
        );
        return null;
      }

      liquidationPlan = resolveShareLiquidationPlan({
        borrowShares: pos.borrowShares,
        collateral: pos.collateral,
        totalBorrowAssets: pos.totalBorrowAssets,
        totalBorrowShares: pos.totalBorrowShares,
        price: oraclePrice,
        lltv: pos.lltv,
        targetSeizedAssets: cappedSeizable,
      });

      if (liquidationPlan === null) {
        console.warn(
          `${this.logTag}TxCache: no safe repaidShares plan for ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol}`,
        );
        return null;
      }
    }

    // Actual seize amount: from liquidation plan for cbXRP, from buffer calc for others.
    const effectiveSeizable =
      liquidationPlan !== null ? liquidationPlan.seizedAssets : cappedSeizable;

    // Step 1: Build collateral→loan conversion calls via venues
    const src = getAddress(marketParams.collateralToken);
    const dst = getAddress(marketParams.loanToken);

    let toConvert = { src, dst, srcAmount: effectiveSeizable };
    let converted = false;

    // Whether this is the first time we see this route fail (controls logging verbosity).
    const isFirstAttempt = lastFail === undefined;

    for (const venue of this.liquidityVenues) {
      try {
        if (await venue.supportsRoute(encoder, toConvert.src, toConvert.dst)) {
          toConvert = await venue.convert(encoder, toConvert);
        }
      } catch (err) {
        // HTTP/network failures are transient — escalate immediately so the caller
        // (build()) can preserve the existing cache entry.  Do NOT record the route
        // in failedRoutes: the route itself is fine, only the RPC is flaky.
        if (isHttpError(err)) {
          throw new HttpBuildError(
            `venue HTTP error for ${pos.collateralSymbol}→${pos.loanSymbol}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        // Non-HTTP venue error (revert, unsupported route, etc.) — try next venue.
        // Only surface per-venue errors on the first attempt for this route.
        // After the route is known-failed, errors are suppressed until cooldown expires.
        if (isFirstAttempt) {
          console.warn(
            `${this.logTag}TxCache: venue error for ${pos.collateralSymbol}→${pos.loanSymbol}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
        continue;
      }

      if (toConvert.src === toConvert.dst) {
        converted = true;
        break;
      }
    }

    if (!converted) {
      // Record failure so this route is skipped for the cooldown period.
      this.failedRoutes.set(rKey, Date.now());
      // Only log on first failure — subsequent cycles are silenced by the cooldown guard above.
      if (isFirstAttempt) {
        console.warn(
          `${this.logTag}TxCache: no venue for ${pos.collateralSymbol}→${pos.loanSymbol} — suppressing for ${TxCache.ROUTE_COOLDOWN_MS / 60_000} min`,
        );
      }
      return null;
    }

    const collateralToLoanCalls = encoder.flush();

    // Step 2: Repay amount with 1% buffer for interest accrual
    const repayAmount =
      liquidationPlan !== null
        ? (liquidationPlan.repaidAssets * 101n) / 100n
        : (borrowAssets * 101n) / 100n;

    // Step 3: Build flash loan liquidation callback
    const market = {
      loanToken: marketParams.loanToken,
      collateralToken: marketParams.collateralToken,
      oracle: marketParams.oracle,
      irm: marketParams.irm,
      lltv: BigInt(marketParams.lltv),
    };

    encoder.erc20Approve(marketParams.loanToken, morpho, 0n);
    encoder.erc20Approve(marketParams.loanToken, morpho, maxUint256);
    if (liquidationPlan !== null) {
      // cbXRP: repaidShares path avoids Morpho borrowShares underflow
      encoder.morphoBlueLiquidate(
        morpho,
        market,
        pos.borrower,
        0n,
        liquidationPlan.repaidShares,
        collateralToLoanCalls,
      );
    } else {
      // All other tokens: proven seizedAssets path (no oracle read needed)
      encoder.morphoBlueLiquidate(
        morpho,
        market,
        pos.borrower,
        cappedSeizable,
        0n,
        collateralToLoanCalls,
      );
    }

    const flashLoanCallbackCalls = encoder.flush();

    // Step 4: Wrap in appropriate flash loan
    const isNonStandard = KNOWN_NON_STANDARD.has(marketParams.loanToken.toLowerCase());

    if (isNonStandard) {
      encoder.erc20Approve(marketParams.loanToken, BALANCER_VAULT, 0n);
      encoder.erc20Approve(marketParams.loanToken, BALANCER_VAULT, repayAmount);
      const vaultApprovals = encoder.flush();

      encoder.balancerFlashLoan(
        BALANCER_VAULT,
        [{ asset: marketParams.loanToken, amount: repayAmount }],
        [...flashLoanCallbackCalls, ...vaultApprovals],
      );
    } else {
      encoder.blueFlashLoan(morpho, marketParams.loanToken, repayAmount, flashLoanCallbackCalls);
    }

    // Step 5: Skim remaining profit to treasury
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);
    const calls = encoder.flush();

    return {
      borrower: pos.borrower,
      marketId: pos.marketId,
      collateralSymbol: pos.collateralSymbol,
      loanSymbol: pos.loanSymbol,
      lltv: pos.lltv,
      calls,
      borrowAssets,
      seizableCollateral,
      builtAt: Date.now(),
    };
  }

  /** Returns the cache map key for a given borrower and marketId. */
  private cacheKey(borrower: Address, marketId: Hex): string {
    return `${borrower.toLowerCase()}-${marketId.toLowerCase()}`;
  }

  /**
   * Returns the executor ABI entry for exec_606BaXt.
   * Convenience for callers that need to build writeContract args from a PrebuiltTx.
   */
  static get functionData() {
    return {
      abi: executorAbi,
      functionName: "exec_606BaXt",
    } as const;
  }
}
