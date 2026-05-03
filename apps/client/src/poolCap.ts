/**
 * poolCap — pool-capacity-aware seize-size cap for cbXRP liquidations.
 *
 * Computes the maximum collateral amount that can be sold through the
 * cbXRP/WETH and cbXRP/USDC pools without breaching a slippage budget,
 * given the oracle price expressed as a WAD-scaled value.
 *
 * This module contains ONLY the pure calculation logic.  It does not
 * perform any RPC calls and does not touch the live liquidation path.
 * Phase 2 wiring complete: `CBXRP_FAST_PATH_SEIZE_BPS` static cap in
 * `tx-cache.ts` and `bot.ts` replaced with a call to `maxSafeSeize`.
 *
 * Reference: Sprint 46b `swapQuoter.ts` pattern — reuse existing viem
 * PublicClient, bigint-only arithmetic, no new RPC dependencies.
 */

import type { CbXrpPoolAwareConfig } from "@morpho-blue-liquidation-bot/config";

/** Basis-point denominator. */
const BPS = 10_000n;

/**
 * Parameters for the pool-capacity cap computation.
 *
 * All amounts use their native token decimals (cbXRP = 6 decimals).
 */
export interface PoolCapParams {
  /**
   * Pool depth estimate — the maximum amount of cbXRP (in cbXRP decimals)
   * the direct cbXRP/USDC pool can absorb within the slippage budget.
   * Obtained from `estimateUniswapV3MaxSwapIn` in the caller.
   */
  directPoolMaxIn: bigint;

  /**
   * Pool depth estimate for the cbXRP/WETH leg of the two-hop fallback path.
   * If null, the fallback route is considered unavailable.
   */
  fallbackLeg1MaxIn: bigint | null;

  /**
   * Requested seize amount in cbXRP decimals (before pool-capacity capping).
   */
  requestedSeize: bigint;

  /** cbXRP pool-aware config from `apps/config`. */
  config: CbXrpPoolAwareConfig;
}

/**
 * Returns the maximum safe seize amount (in cbXRP decimals) such that
 * post-trade slippage stays within `config.slippageBudgetBps`.
 *
 * Algorithm:
 *  1. Start from `requestedSeize` (the buffer-decreased collateral).
 *  2. Try the direct cbXRP/USDC pool first (`config.direct`).
 *     Cap = min(requestedSeize, directPoolMaxIn).
 *  3. If cap == 0 AND a fallback leg-1 estimate is provided AND
 *     fallbackLeg1MaxIn > 0, use fallbackLeg1MaxIn as the cap instead
 *     (two-hop route can absorb more depth).
 *  4. Never return a value larger than requestedSeize.
 *  5. All arithmetic uses bigint; no float.
 *
 * Returns 0n if neither route can absorb any amount within the budget.
 */
export function maxSafeSeize(params: PoolCapParams): bigint {
  const { directPoolMaxIn, fallbackLeg1MaxIn, requestedSeize, config } = params;

  if (requestedSeize === 0n) return 0n;

  // Direct route: cap to the pool's absorbable depth.
  const directCap = directPoolMaxIn < requestedSeize ? directPoolMaxIn : requestedSeize;

  if (directCap > 0n) {
    // Apply an additional slippage-budget safety margin:
    // scale by (BPS - slippageBudgetBps) / BPS to stay inside budget.
    const safetyBps = BigInt(BPS) - BigInt(config.slippageBudgetBps);
    return (directCap * safetyBps) / BPS;
  }

  // Direct route exhausted — try the fallback two-hop path.
  if (fallbackLeg1MaxIn !== null && fallbackLeg1MaxIn > 0n) {
    const fallbackCap = fallbackLeg1MaxIn < requestedSeize ? fallbackLeg1MaxIn : requestedSeize;
    const safetyBps = BigInt(BPS) - BigInt(config.slippageBudgetBps);
    return (fallbackCap * safetyBps) / BPS;
  }

  return 0n;
}

// Re-export CbXrpPoolAwareConfig so callers can import both from one place.
export type { CbXrpPoolAwareConfig };
