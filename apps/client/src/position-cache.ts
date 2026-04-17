/**
 * Position Cache — at-risk Morpho position store with instant HF recalculation.
 *
 * Periodically fetches positions in the HF 0.5-1.2 band from the Morpho Blue API
 * and holds them in memory. When an oracle price update is detected (e.g. via
 * FlashblockWatcher), callers invoke `findLiquidatable` to obtain positions whose
 * health factor has dropped below 1.0 — using pure math with no RPC calls.
 *
 * Oracle address note:
 *   The Morpho API returns the PROXY oracle address (e.g. 0x7104…).
 *   FlashblockWatcher detects AGGREGATOR addresses (e.g. 0x1e0b…).
 *   Callers in index.ts must maintain an aggregator→proxy mapping and pass the
 *   proxy address when calling `findLiquidatable`.
 */

import { type Address, type Hex } from "viem";

// Fixed-point constants matching Morpho Blue's on-chain math
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
// Virtual amounts added to prevent division-by-zero in share conversion
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1_000_000n;

export interface CachedPosition {
  borrower: Address;
  marketId: Hex;
  collateral: bigint;
  borrowShares: bigint;
  // Market state — needed for shares→assets conversion
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  // Market parameters
  lltv: bigint;
  /** Lowercase proxy oracle address as returned by the Morpho API */
  oracleAddress: string;
  collateralSymbol: string;
  loanSymbol: string;
  collateralDecimals: number;
  loanDecimals: number;
  // Addresses required to encode the liquidation transaction
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  /** API-reported health factor (float, ~1.0 = near liquidation) */
  apiHealthFactor: number;
}

export interface LiquidatablePosition {
  position: CachedPosition;
  /** Health factor scaled by WAD (1e18 = healthy boundary) */
  healthFactor: bigint;
  borrowAssets: bigint;
  seizableCollateral: bigint;
}

/**
 * Convert borrow shares to assets using Morpho's virtual-share formula.
 *
 * Formula (from @morpho-org/blue-sdk):
 *   assets = shares * (totalBorrowAssets + VIRTUAL_ASSETS)
 *              / (totalBorrowShares + VIRTUAL_SHARES)
 */
export function toBorrowAssets(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  // Round UP to match Morpho's on-chain math (borrow debt favors the protocol)
  const denominator = totalShares + VIRTUAL_SHARES;
  return (shares * (totalAssets + VIRTUAL_ASSETS) + denominator - 1n) / denominator;
}

/**
 * Calculate health factor for a position given an oracle price.
 *
 * HF = (collateral * oraclePrice / ORACLE_PRICE_SCALE * lltv / WAD) * WAD / borrowAssets
 *    = maxBorrowAssets * WAD / borrowAssets
 *
 * Returns WAD * 1000 (effectively infinite) when borrowAssets == 0.
 */
export function calculateHF(
  collateral: bigint,
  borrowShares: bigint,
  totalBorrowAssets: bigint,
  totalBorrowShares: bigint,
  oraclePrice: bigint,
  lltv: bigint,
): bigint {
  const borrowAssets = toBorrowAssets(borrowShares, totalBorrowAssets, totalBorrowShares);
  if (borrowAssets === 0n) return WAD * 1000n; // effectively infinite HF

  const collateralValue = (collateral * oraclePrice) / ORACLE_PRICE_SCALE;
  const maxBorrowAssets = (collateralValue * lltv) / WAD;

  return (maxBorrowAssets * WAD) / borrowAssets;
}

/**
 * Calculate the amount of collateral seizable during a liquidation.
 *
 * Morpho's liquidation incentive factor (LIF):
 *   CURSOR = 0.3 * WAD
 *   MAX_LIF = 1.15 * WAD
 *   lif = min(MAX_LIF, WAD^2 / (WAD - CURSOR * (WAD - lltv) / WAD))
 *
 * seizedAssets = borrowAssets * lif * ORACLE_PRICE_SCALE / (oraclePrice * WAD)
 * Capped at total collateral.
 */
function calculateSeizableCollateral(
  collateral: bigint,
  borrowShares: bigint,
  totalBorrowAssets: bigint,
  totalBorrowShares: bigint,
  oraclePrice: bigint,
  lltv: bigint,
): bigint {
  const CURSOR = (3n * WAD) / 10n;
  const MAX_LIF = (115n * WAD) / 100n;

  const denominator = WAD - (CURSOR * (WAD - lltv)) / WAD;
  const lif =
    denominator > 0n
      ? (WAD * WAD) / denominator < MAX_LIF
        ? (WAD * WAD) / denominator
        : MAX_LIF
      : MAX_LIF;

  const borrowAssets = toBorrowAssets(borrowShares, totalBorrowAssets, totalBorrowShares);

  // seizedAssets = borrowAssets * lif / oraclePrice (both scaled appropriately)
  const seizedAssets =
    oraclePrice > 0n ? (borrowAssets * lif * ORACLE_PRICE_SCALE) / (oraclePrice * WAD) : 0n;

  return seizedAssets < collateral ? seizedAssets : collateral;
}

export class PositionCache {
  private positions: CachedPosition[] = [];
  private readonly logTag: string;
  private readonly chainId: number;
  private readonly marketIds: string[];
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(logTag: string, chainId: number, marketIds?: string[]) {
    this.logTag = logTag;
    this.chainId = chainId;
    // Empty array = query ALL markets on this chain (auto-discovers wrsETH, new markets, etc.)
    // Specific IDs = restrict to those markets only.
    this.marketIds = marketIds ?? [];
  }

  /**
   * Start periodic position loading from the Morpho Blue API.
   *
   * @param intervalMs - Refresh interval in milliseconds (default: 30 seconds)
   */
  start(intervalMs = 30_000): void {
    void this.loadPositions(); // immediate first load
    this.refreshInterval = setInterval(() => {
      void this.loadPositions();
    }, intervalMs);
  }

  /** Stop the periodic refresh. */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /** Number of positions currently held in the cache. */
  get size(): number {
    return this.positions.length;
  }

  /** Force an immediate reload (e.g., on flash crash detection). */
  reload(): void {
    void this.loadPositions();
  }

  /**
   * Return positions with API-reported HF ≤ 1.02 — most likely to become liquidatable
   * on the next oracle update. Used when a Chainlink transmitter TX is detected.
   * Limits RPC usage by only attempting fastLiquidate on near-liquidation positions.
   */
  findNearLiquidation(maxHf = 1.01): LiquidatablePosition[] {
    const results: LiquidatablePosition[] = [];
    for (const pos of this.positions) {
      if (pos.apiHealthFactor > maxHf) continue;
      const borrowAssets = toBorrowAssets(
        pos.borrowShares,
        pos.totalBorrowAssets,
        pos.totalBorrowShares,
      );
      // Use collateral - 1n so fastLiquidate does NOT treat this as bad debt
      // (bad debt check: seizableCollateral === pos.collateral). The buffer is
      // then applied correctly. Morpho caps seized amount on-chain regardless.
      results.push({
        position: pos,
        healthFactor: WAD,
        borrowAssets,
        seizableCollateral: pos.collateral > 0n ? pos.collateral - 1n : 0n,
      });
    }
    results.sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : -1));
    return results;
  }

  /**
   * PRECISION PATH: Use a real-time Chainlink price to recalculate HF for matching positions.
   * Returns ONLY positions where recalculated HF < 1.0 (truly liquidatable).
   *
   * The scale factor from Chainlink 8-decimal → Morpho ORACLE_PRICE_SCALE (1e36)
   * is computed PER POSITION using its token decimals:
   *   morphoPrice = chainlinkPrice * 10^(36 - 8 - collateralDecimals + loanDecimals)
   *
   * This correctly handles markets with different decimal combinations
   * (e.g. cbBTC(8)/USDC(6) vs WETH(18)/USDC(6) vs wstETH(18)/WETH(18)).
   *
   * For markets where this Chainlink feed is NOT the primary oracle (e.g. wstETH/WETH
   * uses a staking ratio, not ETH/USD), the computed HF will be wildly wrong and
   * naturally filter out (HF >> 1 or HF << 0), resulting in no false positives.
   *
   * @param symbolPatterns - Collateral symbol filters (e.g. ["btc", "wbtc"])
   * @param chainlinkPrice8dec - Raw Chainlink price in 8-decimal format (e.g. 8400000000000n for $84K BTC)
   */
  findLiquidatableByPrice(
    symbolPatterns: string[],
    chainlinkPrice8dec: bigint,
  ): LiquidatablePosition[] {
    const patterns = symbolPatterns.map((p) => p.toLowerCase());
    const results: LiquidatablePosition[] = [];

    for (const pos of this.positions) {
      if (pos.apiHealthFactor > 1.15) continue;
      const sym = pos.collateralSymbol.toLowerCase();
      if (!patterns.some((p) => sym.includes(p))) continue;

      // Compute per-position scale: 10^(36 - 8 - collateralDecimals + loanDecimals)
      const scaleExp = 36 - 8 - pos.collateralDecimals + pos.loanDecimals;
      if (scaleExp < 0 || scaleExp > 60) continue; // sanity guard
      const oraclePrice = chainlinkPrice8dec * 10n ** BigInt(scaleExp);

      const hf = calculateHF(
        pos.collateral,
        pos.borrowShares,
        pos.totalBorrowAssets,
        pos.totalBorrowShares,
        oraclePrice,
        pos.lltv,
      );

      if (hf < WAD) {
        const borrowAssets = toBorrowAssets(
          pos.borrowShares,
          pos.totalBorrowAssets,
          pos.totalBorrowShares,
        );
        const seizableCollateral = calculateSeizableCollateral(
          pos.collateral,
          pos.borrowShares,
          pos.totalBorrowAssets,
          pos.totalBorrowShares,
          oraclePrice,
          pos.lltv,
        );
        results.push({ position: pos, healthFactor: hf, borrowAssets, seizableCollateral });
      }
    }

    results.sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : -1));
    return results;
  }

  /**
   * Return near-liquidation positions filtered by collateral symbol patterns.
   * Used when a specific Chainlink aggregator update is detected —
   * e.g., BTC/USD aggregator → filter for "BTC" in collateral symbol.
   *
   * @param symbolPatterns - Substrings to match against collateralSymbol (case-insensitive)
   * @param maxHf - Maximum API-reported health factor to include (default: 1.05)
   */
  findByCollateralSymbol(symbolPatterns: string[], maxHf = 1.01): LiquidatablePosition[] {
    const patterns = symbolPatterns.map((p) => p.toLowerCase());
    const results: LiquidatablePosition[] = [];
    for (const pos of this.positions) {
      if (pos.apiHealthFactor > maxHf) continue;
      const sym = pos.collateralSymbol.toLowerCase();
      if (!patterns.some((p) => sym.includes(p))) continue;
      const borrowAssets = toBorrowAssets(
        pos.borrowShares,
        pos.totalBorrowAssets,
        pos.totalBorrowShares,
      );
      results.push({
        position: pos,
        healthFactor: WAD,
        borrowAssets,
        seizableCollateral: pos.collateral > 0n ? pos.collateral - 1n : 0n,
      });
    }
    results.sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : -1));
    return results;
  }

  /**
   * Return ALL cached positions as liquidation candidates (no oracle filter).
   * Used when an oracle transmitter TX is detected but we don't know which
   * specific oracle was updated. Caller must simulate to verify.
   */
  findAllCandidates(): LiquidatablePosition[] {
    const results: LiquidatablePosition[] = [];
    for (const pos of this.positions) {
      const borrowAssets = toBorrowAssets(
        pos.borrowShares,
        pos.totalBorrowAssets,
        pos.totalBorrowShares,
      );
      results.push({
        position: pos,
        healthFactor: WAD, // unknown — caller simulates on-chain
        borrowAssets,
        seizableCollateral: pos.collateral,
      });
    }
    results.sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : -1));
    return results;
  }

  /**
   * Find all positions that become liquidatable at a given oracle price.
   *
   * This is the HOT PATH — pure math, no async, no RPC calls, sub-millisecond.
   *
   * @param oracleAddress - The oracle proxy address that updated (lowercase, with 0x prefix).
   *   Callers must map aggregator→proxy before calling this method.
   * @param newOraclePrice - New oracle price from on-chain (1e36-scaled).
   *   If omitted or 0n, all positions for this oracle are returned (caller must verify on-chain).
   * @returns Positions sorted by borrow size descending (most profitable first).
   */
  findLiquidatable(oracleAddress: string, newOraclePrice?: bigint): LiquidatablePosition[] {
    const results: LiquidatablePosition[] = [];
    const oracleLower = oracleAddress.toLowerCase();

    for (const pos of this.positions) {
      if (pos.oracleAddress !== oracleLower) continue;

      if (newOraclePrice !== undefined && newOraclePrice > 0n) {
        const hf = calculateHF(
          pos.collateral,
          pos.borrowShares,
          pos.totalBorrowAssets,
          pos.totalBorrowShares,
          newOraclePrice,
          pos.lltv,
        );

        if (hf < WAD) {
          const borrowAssets = toBorrowAssets(
            pos.borrowShares,
            pos.totalBorrowAssets,
            pos.totalBorrowShares,
          );
          const seizableCollateral = calculateSeizableCollateral(
            pos.collateral,
            pos.borrowShares,
            pos.totalBorrowAssets,
            pos.totalBorrowShares,
            newOraclePrice,
            pos.lltv,
          );
          results.push({ position: pos, healthFactor: hf, borrowAssets, seizableCollateral });
        }
      } else {
        // No price provided — return all positions for this oracle; caller verifies on-chain
        const borrowAssets = toBorrowAssets(
          pos.borrowShares,
          pos.totalBorrowAssets,
          pos.totalBorrowShares,
        );
        results.push({
          position: pos,
          healthFactor: WAD, // unknown — caller must verify
          borrowAssets,
          seizableCollateral: pos.collateral,
        });
      }
    }

    // Most profitable position first
    results.sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : -1));
    return results;
  }

  /** Fetch at-risk positions (HF 0.5–1.15) from the Morpho Blue GraphQL API.
   *  If marketIds were provided, filters to those markets only.
   *  Otherwise queries ALL markets on the chain (auto-discovers new markets). */
  private async loadPositions(): Promise<void> {
    try {
      const marketFilter =
        this.marketIds.length > 0
          ? `marketUniqueKey_in: [${this.marketIds.map((id) => `"${id}"`).join(",")}],`
          : "";
      const query = JSON.stringify({
        query: `{
          marketPositions(
            where: {
              chainId_in: [${this.chainId}],
              ${marketFilter}
              healthFactor_gte: 0.5,
              healthFactor_lte: 1.30,
              borrowShares_gte: 1
            },
            first: 500,
            orderBy: HealthFactor,
            orderDirection: Asc
          ) {
            items {
              user { address }
              market {
                uniqueKey
                oracleAddress
                irmAddress
                lltv
                collateralAsset { symbol decimals address }
                loanAsset { symbol decimals address }
                state {
                  borrowAssets
                  borrowShares
                }
              }
              borrowShares
              collateral
              healthFactor
            }
          }
        }`,
      });

      const response = await fetch("https://blue-api.morpho.org/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: query,
        signal: AbortSignal.timeout(30_000),
      });

      const data = (await response.json()) as {
        data?: {
          marketPositions?: {
            items?: {
              user: { address: string };
              market: {
                uniqueKey: string;
                oracleAddress: string;
                irmAddress: string;
                lltv: string;
                collateralAsset: { symbol: string; decimals: number; address: string };
                loanAsset: { symbol: string; decimals: number; address: string };
                state: { borrowAssets: string; borrowShares: string };
              };
              borrowShares: string;
              collateral: string;
              healthFactor: number;
            }[];
          };
        };
      };

      const items = data.data?.marketPositions?.items ?? [];

      const newPositions: CachedPosition[] = [];

      for (const item of items) {
        const collateral = BigInt(item.collateral || "0");
        const borrowShares = BigInt(item.borrowShares || "0");

        // Skip zero-collateral or zero-borrow entries — they cannot be liquidated
        if (collateral === 0n || borrowShares === 0n) continue;
        // Skip positions without IRM address — cannot construct valid market params
        if (!item.market.irmAddress) continue;

        newPositions.push({
          borrower: item.user.address as Address,
          marketId: item.market.uniqueKey as Hex,
          collateral,
          borrowShares,
          totalBorrowAssets: BigInt(item.market.state.borrowAssets || "0"),
          totalBorrowShares: BigInt(item.market.state.borrowShares || "0"),
          lltv: BigInt(item.market.lltv || "0"),
          oracleAddress: item.market.oracleAddress.toLowerCase(),
          collateralSymbol: item.market.collateralAsset.symbol,
          loanSymbol: item.market.loanAsset.symbol,
          collateralDecimals: item.market.collateralAsset.decimals,
          loanDecimals: item.market.loanAsset.decimals,
          loanToken: item.market.loanAsset.address as Address,
          collateralToken: item.market.collateralAsset.address as Address,
          oracle: item.market.oracleAddress as Address,
          irm: item.market.irmAddress as Address,
          apiHealthFactor: item.healthFactor,
        });
      }

      if (newPositions.length > 0) {
        this.positions = newPositions;
        console.log(`${this.logTag}PositionCache: loaded ${newPositions.length} at-risk positions`);
        try {
          const hs = (globalThis as { __healthState?: Record<string, unknown> }).__healthState;
          if (hs) {
            hs.positionCacheCount = newPositions.length;
            hs.positionCacheLastUpdateMs = Date.now();
          }
        } catch {
          // Ignore health-state wiring failures.
        }
      } else {
        console.log(
          `${this.logTag}PositionCache: 0 at-risk positions (API returned ${items.length} items, ${items.length - newPositions.length} filtered out); preserving ${this.positions.length} cached positions`,
        );
      }
    } catch (err) {
      console.error(
        `${this.logTag}PositionCache load error:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
