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

import { chainConfigs, type CbXrpPoolAwareConfig } from "@morpho-blue-liquidation-bot/config";
import type {
  LiquidityVenue,
  ToConvert,
  UniswapV3PoolSnapshot,
} from "@morpho-blue-liquidation-bot/liquidity-venues";
import {
  AerodromeV3Venue,
  buildUniswapV3Path,
  encodeUniswapV3RouterExactInput,
  estimateUniswapV3MaxSwapIn,
  getUniswapV3SpotAmountOut,
  OneInch,
  readUniswapV3PoolSnapshot,
  UniswapV3Venue,
} from "@morpho-blue-liquidation-bot/liquidity-venues";
import { ChainAddresses, getChainAddresses, MarketUtils } from "@morpho-org/blue-sdk";
import { executorAbi } from "executooor-viem";
import {
  encodeFunctionData,
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

import { maxSafeSeize } from "./poolCap.js";
import { toBorrowAssets, type CachedPosition, type PositionCache } from "./position-cache.js";
import { quoteAerodromeSlipstreamOut } from "./utils/aerodromeQuoter.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";
import { resolveShareLiquidationPlan } from "./utils/morphoLiquidation.js";
import {
  checkSwapQuoteGate,
  quoteFixedUniswapV3Route,
  quoteOneInchOut,
  raceClearingSwapQuotes,
  type QuoteRaceVenueName,
} from "./utils/swapQuoter.js";

/** Maximum number of positions to pre-build TXs for per refresh cycle.
 *  Set high to cover ALL at-risk positions — eliminates cache misses on hot path.
 *  Build cost: ~800ms per unique token pair (route lookup), subsequent same-pair = ~5ms.
 *  With 6 pairs × 800ms = ~5s total, well within the 30-min refresh window. */
const MAX_CACHED_POSITIONS = 200;

/** Maximum age in milliseconds before a cached TX is considered stale.
 *  Timer refresh is 30 min, but event-driven refresh triggers on >1% price moves.
 *  Stale threshold is generous to avoid cache miss during quiet periods. */
const STALE_THRESHOLD_MS = 12 * 60_000; // Event-driven rebuilds keep hot entries fresh between fallback cycles

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

function serializeBigInts(value: unknown) {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

function getOtherPoolToken(snapshot: UniswapV3PoolSnapshot, token: Address): Address {
  if (snapshot.token0.toLowerCase() === token.toLowerCase()) return snapshot.token1;
  if (snapshot.token1.toLowerCase() === token.toLowerCase()) return snapshot.token0;
  throw new Error(`token ${token} not found in pool ${snapshot.pool}`);
}

function toPoolSnapshotTelemetry(snapshot: UniswapV3PoolSnapshot) {
  return {
    pool: snapshot.pool,
    sqrtPriceX96: snapshot.sqrtPriceX96,
    tick: snapshot.tick,
    liquidity: snapshot.liquidity,
  };
}

export interface CbXrpPoolAwareTelemetry {
  marketId: Hex;
  borrower: Address;
  requestedRepaidShares: bigint;
  cappedRepaidShares: bigint;
  directPoolSnapshot: {
    pool: Address;
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
    ticksCrossed: number;
    maxSwapIn: bigint;
  };
  fallbackPoolSnapshots: {
    pool: Address;
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
  }[];
  chosenRoute: "direct" | "fallback";
  predictedSlippageBps: number;
  predictedExpectedOut: bigint;
  requiredOut: bigint;
  realizedSwapOut: bigint | null;
  realizedSlippageBps: number | null;
  residualCbXrp: bigint | null;
}

export interface QuoteRaceTelemetry {
  quoteRaceTriggered: true;
  quoteRaceWinner: QuoteRaceVenueName | null;
  quoteRaceRequiredOut: bigint;
  quoteRaceClearingOut: bigint;
  quoteRaceQuotesByVenue: Partial<Record<QuoteRaceVenueName, bigint | null>>;
  quoteRaceTimedOutVenues: QuoteRaceVenueName[];
  quoteRaceLossVsBest: bigint;
  quoteRaceUsedFallback: boolean;
}

interface CbXrpPoolAwareDecision {
  liquidationPlan: {
    repaidShares: bigint;
    repaidAssets: bigint;
    seizedAssets: bigint;
  };
  requiredOut: bigint;
  path: Hex;
  telemetry: CbXrpPoolAwareTelemetry;
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
  swapTelemetry?: CbXrpPoolAwareTelemetry | QuoteRaceTelemetry;
}

export async function applyCbXrpPoolAwareCap(params: {
  client: WalletClient<Transport, Chain, Account>;
  borrower: Address;
  marketId: Hex;
  collateralToken: Address;
  loanToken: Address;
  requestedPlan: {
    repaidShares: bigint;
    repaidAssets: bigint;
    seizedAssets: bigint;
  };
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  price: bigint;
  lltv: bigint;
  quoteGateBufferBps: number;
  cbXrpPoolAware: CbXrpPoolAwareConfig;
}): Promise<CbXrpPoolAwareDecision | null> {
  if (params.marketId.toLowerCase() !== params.cbXrpPoolAware.marketId.toLowerCase()) {
    return null;
  }

  const market = {
    totalBorrowAssets: params.totalBorrowAssets,
    totalBorrowShares: params.totalBorrowShares,
    price: params.price,
  };
  const liquidationConfig = { lltv: params.lltv };
  const snapshotCache = new Map<string, UniswapV3PoolSnapshot>();
  const directDepth = await estimateUniswapV3MaxSwapIn({
    client: params.client,
    pool: params.cbXrpPoolAware.direct.pool,
    tokenIn: params.collateralToken,
    slippageBudgetBps: params.cbXrpPoolAware.slippageBudgetBps,
    snapshotCache,
  });

  if (directDepth.maxSwapIn === 0n) return null;

  let fallbackSnapshots: [UniswapV3PoolSnapshot, UniswapV3PoolSnapshot] | null = null;
  let fallbackWeth: Address | null = null;
  let low = 0n;
  let high = params.requestedPlan.repaidShares;
  let best: CbXrpPoolAwareDecision | null = null;

  while (low <= high) {
    const mid = low + (high - low) / 2n;
    if (mid === 0n) {
      low = 1n;
      continue;
    }

    const seizedAssets = MarketUtils.getLiquidationSeizedAssets(mid, market, liquidationConfig);
    if (seizedAssets === undefined || seizedAssets === 0n || seizedAssets > directDepth.maxSwapIn) {
      high = mid - 1n;
      continue;
    }

    const repaidAssets = MarketUtils.toBorrowAssets(mid, market, "Up");
    const requiredOut = (repaidAssets * BigInt(10_000 + params.quoteGateBufferBps)) / 10_000n;
    const directSpotOut = getUniswapV3SpotAmountOut(
      directDepth,
      params.collateralToken,
      seizedAssets,
    );
    const directQuote = await quoteFixedUniswapV3Route({
      client: params.client,
      amountIn: seizedAssets,
      spotOut: directSpotOut,
      hops: [
        {
          tokenIn: params.collateralToken,
          tokenOut: params.loanToken,
          fee: params.cbXrpPoolAware.direct.fee,
        },
      ],
    });

    let fallbackQuote: Awaited<ReturnType<typeof quoteFixedUniswapV3Route>> = null;
    if (
      directQuote === null ||
      directQuote.predictedSlippageBps > params.cbXrpPoolAware.slippageBudgetBps ||
      directQuote.expectedOut < requiredOut
    ) {
      if (fallbackSnapshots === null) {
        fallbackSnapshots = [
          await readUniswapV3PoolSnapshot(
            params.client,
            params.cbXrpPoolAware.fallback.cbXrpToWeth.pool,
            snapshotCache,
          ),
          await readUniswapV3PoolSnapshot(
            params.client,
            params.cbXrpPoolAware.fallback.wethToUsdc.pool,
            snapshotCache,
          ),
        ];
        fallbackWeth = getOtherPoolToken(fallbackSnapshots[0], params.collateralToken);
      }

      const firstHopSpotOut = getUniswapV3SpotAmountOut(
        fallbackSnapshots[0],
        params.collateralToken,
        seizedAssets,
      );
      const fallbackSpotOut = getUniswapV3SpotAmountOut(
        fallbackSnapshots[1],
        fallbackWeth!,
        firstHopSpotOut,
      );
      fallbackQuote = await quoteFixedUniswapV3Route({
        client: params.client,
        amountIn: seizedAssets,
        spotOut: fallbackSpotOut,
        hops: [
          {
            tokenIn: params.collateralToken,
            tokenOut: fallbackWeth!,
            fee: params.cbXrpPoolAware.fallback.cbXrpToWeth.fee,
          },
          {
            tokenIn: fallbackWeth!,
            tokenOut: params.loanToken,
            fee: params.cbXrpPoolAware.fallback.wethToUsdc.fee,
          },
        ],
      });
    }

    const directOk = directQuote !== null && directQuote.expectedOut >= requiredOut;
    const fallbackOk = fallbackQuote !== null && fallbackQuote.expectedOut >= requiredOut;
    if (!directOk && !fallbackOk) {
      high = mid - 1n;
      continue;
    }

    const useFallback =
      fallbackOk &&
      (!directOk || fallbackQuote!.predictedSlippageBps < directQuote.predictedSlippageBps);
    const route = useFallback ? "fallback" : "direct";
    const routeQuote = useFallback ? fallbackQuote! : directQuote!;

    best = {
      liquidationPlan: {
        repaidShares: mid,
        repaidAssets,
        seizedAssets,
      },
      requiredOut,
      path: buildUniswapV3Path(
        params.collateralToken,
        route === "direct"
          ? [{ fee: params.cbXrpPoolAware.direct.fee, tokenOut: params.loanToken }]
          : [
              {
                fee: params.cbXrpPoolAware.fallback.cbXrpToWeth.fee,
                tokenOut: fallbackWeth!,
              },
              {
                fee: params.cbXrpPoolAware.fallback.wethToUsdc.fee,
                tokenOut: params.loanToken,
              },
            ],
      ),
      telemetry: {
        marketId: params.marketId,
        borrower: params.borrower,
        requestedRepaidShares: params.requestedPlan.repaidShares,
        cappedRepaidShares: mid,
        directPoolSnapshot: {
          pool: directDepth.pool,
          sqrtPriceX96: directDepth.sqrtPriceX96,
          tick: directDepth.tick,
          liquidity: directDepth.liquidity,
          ticksCrossed: directDepth.ticksCrossed,
          maxSwapIn: directDepth.maxSwapIn,
        },
        fallbackPoolSnapshots:
          fallbackSnapshots === null ? [] : fallbackSnapshots.map(toPoolSnapshotTelemetry),
        chosenRoute: route,
        predictedSlippageBps: routeQuote.predictedSlippageBps,
        predictedExpectedOut: routeQuote.expectedOut,
        requiredOut,
        realizedSwapOut: null,
        realizedSlippageBps: null,
        residualCbXrp: null,
      },
    };
    low = mid + 1n;
  }

  return best;
}

export interface TxCacheInputs {
  logTag: string;
  chainId: number;
  client: WalletClient<Transport, Chain, Account>;
  positionCache: PositionCache;
  executorAddress: Address;
  treasuryAddress: Address;
  liquidityVenues: LiquidityVenue[];
  /** Optional: override liquidation buffer in BPS (default: DEFAULT_LIQUIDATION_BUFFER_BPS). */
  liquidationBufferBps?: number;
  /** Optional: fire-and-forget hook when a prebuilt entry is refreshed. */
  onBuildComplete?: (prebuilt: PrebuiltTx) => Promise<void> | void;
  /**
   * Enable the UniswapV3 swap profitability gate.
   * When true, a quoteExactInputSingle is issued before finalising calldata.
   * If the expected swap output cannot cover flash-loan repayment + buffer, the
   * build returns null (same semantics as "no venue found").
   * Defaults to true.
   */
  quoteGateEnabled?: boolean;
  /**
   * Buffer applied on top of repaidAssets when evaluating gate profitability.
   * Expressed in basis points (100 = 1%).  Defaults to 100 (1%).
   */
  quoteGateBufferBps?: number;
  quoteRaceEnabled?: boolean;
}

export class TxCache {
  private readonly logTag: string;
  private readonly chainId: number;
  private readonly client: WalletClient<Transport, Chain, Account>;
  private readonly positionCache: PositionCache;
  private readonly executorAddress: Address;
  private readonly treasuryAddress: Address;
  private readonly liquidityVenues: LiquidityVenue[];
  private readonly chainAddresses: ChainAddresses;
  private readonly liquidationBufferBps: number;
  private readonly onBuildComplete?: (prebuilt: PrebuiltTx) => Promise<void> | void;
  private readonly quoteGateEnabled: boolean;
  private readonly quoteGateBufferBps: number;
  private readonly quoteRaceEnabled: boolean;
  private readonly cbXrpPoolAware?: CbXrpPoolAwareConfig;

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
    this.positionCache = inputs.positionCache;
    this.executorAddress = inputs.executorAddress;
    this.treasuryAddress = inputs.treasuryAddress;
    this.liquidityVenues = inputs.liquidityVenues;
    this.chainAddresses = getChainAddresses(inputs.chainId);
    this.liquidationBufferBps = inputs.liquidationBufferBps ?? DEFAULT_LIQUIDATION_BUFFER_BPS;
    this.onBuildComplete = inputs.onBuildComplete;
    this.quoteGateEnabled = inputs.quoteGateEnabled ?? true;
    this.quoteGateBufferBps = inputs.quoteGateBufferBps ?? 100;
    this.quoteRaceEnabled = inputs.quoteRaceEnabled ?? false;
    this.cbXrpPoolAware = chainConfigs[this.chainId]?.options.cbXrpPoolAware;
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

    interface SortEntry {
      pos: CachedPosition;
      borrowAssets: bigint;
    }
    const entries: SortEntry[] = positions.map((pos) => {
      return { pos, borrowAssets: this.getBorrowAssets(pos) };
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
    // Snapshot cache shared across all buildOne calls in this cycle.
    // Prevents duplicate readUniswapV3PoolSnapshot RPC calls for the same pool
    // when multiple cbXRP positions exist in the same build batch.
    const buildCycleSnapshotCache = new Map<string, UniswapV3PoolSnapshot>();

    for (const { pos, borrowAssets } of top) {
      const key = this.cacheKey(pos.borrower, pos.marketId);

      try {
        const prebuilt = await this.buildOne(pos, borrowAssets, buildCycleSnapshotCache);
        if (prebuilt !== null) {
          newCache.set(key, prebuilt);
          builtCount++;
          if (this.onBuildComplete) {
            void Promise.resolve(this.onBuildComplete(prebuilt)).catch((error: unknown) => {
              console.error(
                `${this.logTag}TxCache: onBuildComplete error for ${prebuilt.borrower} ${prebuilt.marketId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          }
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
        const hs = (
          globalThis as {
            __healthState?: {
              txCacheBuiltCount?: number;
              txCacheTotalAtRisk?: number;
            };
          }
        ).__healthState;
        if (hs) {
          hs.txCacheBuiltCount = builtCount;
          hs.txCacheTotalAtRisk = positions.length;
        }
      } catch {
        /* ignore */
      }
    })();
  }

  async rebuildOne(borrower: Address, marketId: Hex): Promise<void> {
    const cached = this.positionCache.findByBorrowerAndMarket(borrower, marketId);
    const key = this.cacheKey(borrower, marketId);

    if (cached === undefined) {
      this.cache.delete(key);
      return;
    }

    try {
      const prebuilt = await this.buildOne(cached.position, cached.borrowAssets);
      if (prebuilt !== null) {
        this.cache.set(key, prebuilt);
        if (this.onBuildComplete) {
          void Promise.resolve(this.onBuildComplete(prebuilt)).catch((error: unknown) => {
            console.error(
              `${this.logTag}TxCache: onBuildComplete error for ${prebuilt.borrower} ${prebuilt.marketId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
        console.log(`${this.logTag}TxCache: rebuilt (borrower=${borrower} market=${marketId})`);
      } else {
        this.cache.delete(key);
      }
    } catch (err) {
      if (err instanceof HttpBuildError) {
        const existing = this.cache.get(key);
        if (existing !== undefined) {
          console.log(
            `${this.logTag}TxCache: HTTP error for rebuild borrower=${borrower} market=${marketId} — keeping existing cache`,
          );
        } else {
          console.warn(
            `${this.logTag}TxCache: HTTP error for rebuild borrower=${borrower} market=${marketId} — no existing cache to keep`,
          );
        }
      } else {
        console.warn(
          `${this.logTag}TxCache: failed to rebuild TX for borrower=${borrower} market=${marketId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
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

  private getBorrowAssets(pos: CachedPosition): bigint {
    return toBorrowAssets(pos.borrowShares, pos.totalBorrowAssets, pos.totalBorrowShares);
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
  private async buildOne(
    pos: CachedPosition,
    borrowAssets: bigint,
    snapshotCache?: Map<string, UniswapV3PoolSnapshot>,
  ): Promise<PrebuiltTx | null> {
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
    // Coarse pre-filter: for cbXRP positions on the pool-aware market, cap to pool depth
    // using maxSafeSeize (Phase 1 poolCap.ts).  Falls back to the static 5% cap on RPC error
    // so we never proceed without a cap in place.  applyCbXrpPoolAwareCap (binary-search)
    // further refines this estimate in the isCbXrpMarket branch below.
    const isCbXRP = pos.collateralSymbol === "cbXRP";
    const isCbXrpPoolAwareMarket =
      isCbXRP &&
      this.cbXrpPoolAware !== undefined &&
      this.cbXrpPoolAware.marketId.toLowerCase() === pos.marketId.toLowerCase();

    let cappedSeizable: bigint;
    if (isCbXrpPoolAwareMarket && this.cbXrpPoolAware !== undefined) {
      try {
        const cache = snapshotCache ?? new Map<string, UniswapV3PoolSnapshot>();
        const directDepth = await estimateUniswapV3MaxSwapIn({
          client: this.client,
          pool: this.cbXrpPoolAware.direct.pool,
          tokenIn: pos.collateralToken,
          slippageBudgetBps: this.cbXrpPoolAware.slippageBudgetBps,
          snapshotCache: cache,
        });
        const fallbackDepth = await estimateUniswapV3MaxSwapIn({
          client: this.client,
          pool: this.cbXrpPoolAware.fallback.cbXrpToWeth.pool,
          tokenIn: pos.collateralToken,
          slippageBudgetBps: this.cbXrpPoolAware.slippageBudgetBps,
          snapshotCache: cache,
        });
        const poolCap = maxSafeSeize({
          directPoolMaxIn: directDepth.maxSwapIn,
          fallbackLeg1MaxIn: fallbackDepth.maxSwapIn,
          requestedSeize: decreasedSeizable,
          config: this.cbXrpPoolAware,
        });
        // If both pools report 0 depth, fall back to static cap so build can proceed.
        cappedSeizable =
          poolCap > 0n ? poolCap : (decreasedSeizable * CBXRP_FAST_PATH_SEIZE_BPS) / BPS;
      } catch (err) {
        if (isHttpError(err)) {
          throw new HttpBuildError(
            `pool depth estimate failed (HTTP) for cbXRP cap: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        // Non-HTTP error (e.g. contract revert on pool read): fall back to static cap.
        console.warn(
          `${this.logTag}TxCache: pool depth estimate error for cbXRP — using static 5% cap: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        cappedSeizable = (decreasedSeizable * CBXRP_FAST_PATH_SEIZE_BPS) / BPS;
      }
    } else if (isCbXRP) {
      // cbXRP but no pool-aware config or market mismatch — use static 5% cap.
      cappedSeizable = (decreasedSeizable * CBXRP_FAST_PATH_SEIZE_BPS) / BPS;
    } else {
      cappedSeizable = decreasedSeizable;
    }

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

    let liquidationPlan: {
      repaidShares: bigint;
      repaidAssets: bigint;
      seizedAssets: bigint;
    } | null = resolveShareLiquidationPlan({
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

    // Step 1: Build collateral→loan conversion calls via venues
    const src = getAddress(marketParams.collateralToken);
    const dst = getAddress(marketParams.loanToken);
    let collateralToLoanCalls: Hex[];
    let swapTelemetry: CbXrpPoolAwareTelemetry | QuoteRaceTelemetry | undefined;
    const isCbXrpMarket =
      isCbXRP &&
      this.cbXrpPoolAware !== undefined &&
      this.cbXrpPoolAware.marketId.toLowerCase() === pos.marketId.toLowerCase();

    if (isCbXrpMarket && this.liquidityVenues.some((venue) => venue instanceof UniswapV3Venue)) {
      const poolAwareDecision = await applyCbXrpPoolAwareCap({
        client: this.client,
        borrower: pos.borrower,
        marketId: pos.marketId,
        collateralToken: src,
        loanToken: dst,
        requestedPlan: liquidationPlan,
        totalBorrowAssets: pos.totalBorrowAssets,
        totalBorrowShares: pos.totalBorrowShares,
        price: oraclePrice,
        lltv: pos.lltv,
        quoteGateBufferBps: this.quoteGateBufferBps,
        cbXrpPoolAware: this.cbXrpPoolAware,
      });
      if (poolAwareDecision === null) {
        console.log(
          `${this.logTag}TxCache: cbXRP pool-aware SKIP market=${pos.marketId} borrower=${pos.borrower.slice(0, 10)}`,
        );
        return null;
      }

      liquidationPlan = poolAwareDecision.liquidationPlan;
      encodeUniswapV3RouterExactInput(encoder, {
        router: this.cbXrpPoolAware.router,
        tokenIn: src,
        amountIn: liquidationPlan.seizedAssets,
        minAmountOut: poolAwareDecision.requiredOut,
        path: poolAwareDecision.path,
      });
      collateralToLoanCalls = encoder.flush();
      swapTelemetry = poolAwareDecision.telemetry;
      console.log(`${this.logTag}TxCache: cbXRP pool-aware ${serializeBigInts(swapTelemetry)}`);
    } else {
      const effectiveSeizable = liquidationPlan.seizedAssets;
      const routeEncoder = new LiquidationEncoder(this.executorAddress, this.client);
      let toConvert: ToConvert = { src, dst, srcAmount: effectiveSeizable };
      let converted = false;
      let winningVenue: LiquidityVenue | undefined;
      let winningVenueInput: ToConvert = { ...toConvert };
      const prefixVenues: LiquidityVenue[] = [];

      const isFirstAttempt = lastFail === undefined;

      for (const venue of this.liquidityVenues) {
        try {
          if (await venue.supportsRoute(routeEncoder, toConvert.src, toConvert.dst)) {
            const beforeVenue = { ...toConvert };
            toConvert = await venue.convert(routeEncoder, toConvert);
            if (toConvert.src === toConvert.dst) {
              converted = true;
              winningVenue = venue;
              winningVenueInput = beforeVenue;
              break;
            }
            prefixVenues.push(venue);
          }
        } catch (err) {
          if (isHttpError(err)) {
            throw new HttpBuildError(
              `venue HTTP error for ${pos.collateralSymbol}→${pos.loanSymbol}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          if (isFirstAttempt) {
            console.warn(
              `${this.logTag}TxCache: venue error for ${pos.collateralSymbol}→${pos.loanSymbol}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
          continue;
        }
      }

      if (!converted) {
        this.failedRoutes.set(rKey, Date.now());
        if (isFirstAttempt) {
          console.warn(
            `${this.logTag}TxCache: no venue for ${pos.collateralSymbol}→${pos.loanSymbol} — suppressing for ${TxCache.ROUTE_COOLDOWN_MS / 60_000} min`,
          );
        }
        return null;
      }

      if (this.quoteGateEnabled && winningVenue instanceof UniswapV3Venue && !isCbXrpMarket) {
        const requiredOut =
          (liquidationPlan.repaidAssets * BigInt(10_000 + this.quoteGateBufferBps)) / 10_000n;
        const gateResult = await checkSwapQuoteGate({
          client: this.client,
          collateralToken: winningVenueInput.src,
          loanToken: winningVenueInput.dst,
          seizedAssets: winningVenueInput.srcAmount,
          requiredOut,
          logTag: this.logTag,
          marketId: pos.marketId,
          borrower: pos.borrower,
        });
        if (!gateResult.pass) {
          if (!this.quoteRaceEnabled) return null;

          const oneInchVenue = this.liquidityVenues.find(
            (venue): venue is OneInch => venue instanceof OneInch,
          );
          const aerodromeV3Venue = this.liquidityVenues.find(
            (v): v is AerodromeV3Venue => v instanceof AerodromeV3Venue,
          );
          const aerodromeEnabled = this.chainId === 8453 && aerodromeV3Venue !== undefined;
          const raceResult = await raceClearingSwapQuotes({
            requiredOut,
            probes: [
              { venue: "uniswapV3", quote: async () => gateResult.expectedSwapOut },
              {
                venue: "1inch",
                enabled:
                  oneInchVenue !== undefined && process.env.ONE_INCH_SWAP_API_KEY !== undefined,
                quote: async () =>
                  quoteOneInchOut({
                    chainId: this.chainId,
                    collateralToken: winningVenueInput.src,
                    loanToken: winningVenueInput.dst,
                    seizedAssets: winningVenueInput.srcAmount,
                    executorAddress: this.executorAddress,
                    originAddress: this.client.account.address,
                  }),
              },
              { venue: "balancer", enabled: false },
              {
                venue: "aerodromeV3",
                enabled: aerodromeEnabled,
                quote: async () =>
                  quoteAerodromeSlipstreamOut({
                    client: this.client,
                    chainId: this.chainId,
                    collateralToken: winningVenueInput.src,
                    loanToken: winningVenueInput.dst,
                    seizedAssets: winningVenueInput.srcAmount,
                    executorAddress: this.executorAddress,
                    originAddress: this.client.account.address,
                  }),
              },
            ],
          });
          if (raceResult.winnerVenue === null) {
            return null;
          }

          const selectedEncoder = new LiquidationEncoder(this.executorAddress, this.client);
          let selectedConvert: ToConvert = { src, dst, srcAmount: effectiveSeizable };
          for (const venue of prefixVenues) {
            selectedConvert = await venue.convert(selectedEncoder, selectedConvert);
          }

          const selectedVenue =
            raceResult.winnerVenue === "1inch"
              ? oneInchVenue
              : raceResult.winnerVenue === "uniswapV3"
                ? winningVenue
                : raceResult.winnerVenue === "aerodromeV3"
                  ? aerodromeV3Venue
                  : undefined;
          if (selectedVenue === undefined) {
            return null;
          }

          selectedConvert = await selectedVenue.convert(selectedEncoder, selectedConvert);
          if (selectedConvert.src !== selectedConvert.dst) {
            return null;
          }

          swapTelemetry = {
            quoteRaceTriggered: true,
            quoteRaceWinner: raceResult.winnerVenue,
            quoteRaceRequiredOut: requiredOut,
            quoteRaceClearingOut: raceResult.expectedOut,
            quoteRaceQuotesByVenue: raceResult.quotesByVenue,
            quoteRaceTimedOutVenues: raceResult.timedOutVenues,
            quoteRaceLossVsBest:
              raceResult.bestObservedOut > gateResult.expectedSwapOut
                ? raceResult.bestObservedOut - gateResult.expectedSwapOut
                : 0n,
            quoteRaceUsedFallback: raceResult.usedFallback,
          };
          console.log(`${this.logTag}TxCache: quote-race ${serializeBigInts(swapTelemetry)}`);
          collateralToLoanCalls = selectedEncoder.flush();
        } else {
          collateralToLoanCalls = routeEncoder.flush();
        }
      } else {
        collateralToLoanCalls = routeEncoder.flush();
      }
    }

    // Step 2: Repay amount with 1% buffer for interest accrual
    const repayAmount = (liquidationPlan.repaidAssets * 101n) / 100n;

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
    encoder.morphoBlueLiquidate(
      morpho,
      market,
      pos.borrower,
      0n,
      liquidationPlan.repaidShares,
      collateralToLoanCalls,
    );

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
      swapTelemetry,
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

  static encodeCalldata(prebuilt: PrebuiltTx): Hex {
    return encodeFunctionData({
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [prebuilt.calls],
    });
  }
}
