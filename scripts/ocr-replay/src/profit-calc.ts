/**
 * profit-calc.ts
 *
 * Pure function: takes oracle event + pool config + pool state + gas params
 * and returns a ProfitRow with theoretical arb profit after gas/fees.
 *
 * Sprint 4 — FULL tier. No I/O allowed in computeProfit().
 *
 * Model:
 *   - Linear price impact approximation (conservative for replay purposes)
 *   - Active liquidity = 10% of reported liquidity (CL pools have concentrated depth)
 *   - swapAmountUsd capped at $500k (prevent absurd outputs on extreme events)
 *   - Flashloan fee = 0 (Morpho Blue flash loans are free)
 *   - Gas = (baseFeeWei + 5_000_000 Wei tip) × GAS_LIMIT × ethPriceUsd
 *   - Discount: ×0.3 conservative, ×0.6 optimistic
 *
 * Price alignment (quoteIsToken0):
 *   pool-state.ts computes impliedPrice and ALREADY aligns it with the oracle
 *   direction using the quoteIsToken0 flag:
 *     quoteIsToken0=false → impliedPrice = token1/token0 (raw pool price)
 *     quoteIsToken0=true  → impliedPrice = 1/(token1/token0) = token0/token1 (inverted)
 *
 *   Oracle newPriceUsd is always in the SAME direction as impliedPrice for a
 *   correctly configured pool. profit-calc therefore compares them directly.
 *
 *   Example: WETH/wstETH (quoteIsToken0=true)
 *     pool-state.ts returns impliedPrice = 1/(wstETH/WETH) = WETH/wstETH ≈ 1.231
 *     Oracle wstETH/ETH = ETH per wstETH ≈ 1.24 (same units: WETH per wstETH)
 *     deviation = (1.24 - 1.231) / 1.231 ≈ +0.73% (+73 bps) → POSITIVE, pool underprices wstETH
 *
 *   Example: WETH/USDC (quoteIsToken0=false)
 *     pool-state.ts returns impliedPrice = USDC/WETH ≈ 2357 (USD per ETH)
 *     Oracle ETH/USD = 2357 (same units)
 *     deviation ≈ 0 when oracle and pool agree
 */

import { GAS_LIMIT_LIQUIDATION, CONSERVATIVE_DISCOUNT, OPTIMISTIC_DISCOUNT } from "./config.js";
import type { AnswerUpdatedEvent, PoolConfig, PoolState, ProfitRow } from "./types.js";

/** Priority tip added to baseFee: 0.005 gwei in Wei. */
const TIP_WEI = 5_000_000n;

/** Maximum swap size in USD to cap unrealistic outputs on extreme events. */
const MAX_SWAP_USD = 500_000;

/** Active liquidity fraction — conservative assumption for CL pools (only current tick depth). */
const ACTIVE_LIQUIDITY_FRACTION = 0.1;

/**
 * Compute theoretical backrun arb profit from an OCR AnswerUpdated event.
 *
 * Pure function — no I/O, no side effects.
 *
 * @param event       - The oracle AnswerUpdated event (event.newPriceUsd in oracle units)
 * @param pool        - Pool configuration (quoteIsToken0 determines price alignment in pool-state)
 * @param state       - Pool state at the block before the oracle update (impliedPrice already aligned)
 * @param baseFeeWei  - Block base fee in Wei (bigint)
 * @param ethPriceUsd - ETH price in USD (for gas cost calculation)
 * @returns ProfitRow with all intermediate values
 */
export function computeProfit(
  event: AnswerUpdatedEvent,
  pool: PoolConfig,
  state: PoolState,
  baseFeeWei: bigint,
  ethPriceUsd: number,
): ProfitRow {
  // ─── Edge case: zero liquidity → no depth to arb ──────────────────────────
  if (state.liquidity === 0n) {
    return buildZeroRow(event, pool, state, 0);
  }

  // ─── Edge case: guard against zero/invalid inputs ─────────────────────────
  const oraclePrice = event.newPriceUsd;
  const poolPrice = state.impliedPrice;

  if (
    !isFinite(oraclePrice) ||
    !isFinite(poolPrice) ||
    poolPrice === 0 ||
    oraclePrice === 0 ||
    ethPriceUsd === 0
  ) {
    return buildZeroRow(event, pool, state, 0);
  }

  // ─── Deviation calculation ─────────────────────────────────────────────────
  // Both oraclePrice and poolPrice (impliedPrice from pool-state.ts) are in the
  // same units — pool-state.ts handles alignment via quoteIsToken0. Compare directly.
  //
  // Positive deviation: oracle says asset is worth MORE than pool implies
  //   → buy from pool (pool is cheap), sell at oracle price
  // Negative deviation: oracle says asset is worth LESS than pool implies
  //   → sell to pool (pool is expensive), buy at oracle price
  const deviation = (oraclePrice - poolPrice) / poolPrice;
  const absDev = Math.abs(deviation);
  const deviationBps = absDev * 10_000;
  // Signed version preserves direction so competition.ts can pick per-row
  // arb direction via XOR(quoteIsToken0, deviationSign < 0) (Finding 2 fix).
  const deviationBpsSigned = deviation * 10_000;

  // ─── Threshold gate: must exceed 1.5× fee tier ────────────────────────────
  // Below this threshold, the round-trip fee would consume the entire profit.
  const feeFraction = pool.feePpm / 1_000_000;
  if (absDev < feeFraction * 1.5) {
    return buildZeroRow(event, pool, state, deviationBps, deviationBpsSigned);
  }

  // ─── Depth estimation ─────────────────────────────────────────────────────
  // liquidity (uint128) = sqrt(x * y) for UniV3/Aero CL.
  // Approximate USD depth:
  //   activeLiquidityUsd ≈ (liquidity / 1e12) × sqrt(poolPrice) × ACTIVE_FRACTION
  // The /1e12 scaling converts the large bigint to workable float range.
  // sqrt(poolPrice) gives a rough USD-denominated depth scaling.
  // ACTIVE_LIQUIDITY_FRACTION=0.10 is conservative: only current tick is immediately tradeable.
  const liquidityFloat = Number(state.liquidity) / 1e12;
  const activeLiquidityUsd = liquidityFloat * Math.sqrt(poolPrice) * ACTIVE_LIQUIDITY_FRACTION;

  // ─── Optimal swap size (linear impact model) ──────────────────────────────
  // For a constant-product AMM, optimal arb swap ≈ depth × |deviation| / 2
  // The "/2" accounts for price moving against the arber as they trade.
  // Cap at MAX_SWAP_USD to prevent absurd outputs from extreme events.
  const uncappedSwap = activeLiquidityUsd * absDev * 0.5;
  const swapAmountUsd = Math.min(uncappedSwap, MAX_SWAP_USD);

  if (!isFinite(swapAmountUsd) || swapAmountUsd <= 0) {
    return buildZeroRow(event, pool, state, deviationBps, deviationBpsSigned);
  }

  // ─── Gross profit = swap × deviation × 0.5 (midpoint price impact) ────────
  // Arber captures half the deviation as price moves halfway during the trade.
  const gross = swapAmountUsd * absDev * 0.5;

  if (!isFinite(gross)) {
    return buildZeroRow(event, pool, state, deviationBps, deviationBpsSigned);
  }

  // ─── Cost calculation ─────────────────────────────────────────────────────
  const flashloanFee = 0; // Morpho Blue flash loans are free

  // DEX fee: round-trip swap cost (one swap in the target pool)
  const dexFee = swapAmountUsd * feeFraction;

  // Gas: gasLimit × (baseFee + priority tip) Wei → ETH → USD
  const gasPriceWei = baseFeeWei + TIP_WEI;
  const gasEth = Number(GAS_LIMIT_LIQUIDATION * gasPriceWei) / 1e18;
  const gasUsd = gasEth * ethPriceUsd;

  // ─── Net profit with discounts ────────────────────────────────────────────
  // Conservative (×0.3): accounts for execution risk, competition, slippage
  // Optimistic (×0.6): best-case execution with limited competition
  const afterCosts = gross - flashloanFee - dexFee - gasUsd;

  return {
    event,
    pool,
    stateBefore: state,
    deviationBps,
    deviationBpsSigned,
    swapAmountUsd,
    gross,
    flashloanFee,
    dexFee,
    gasUsd,
    netConservative: afterCosts * CONSERVATIVE_DISCOUNT,
    netOptimistic: afterCosts * OPTIMISTIC_DISCOUNT,
  };
}

// ─── Internal helper ─────────────────────────────────────────────────────────

/**
 * Builds a zero-profit row for cases where arb is not viable.
 *
 * @param event        - Oracle event
 * @param pool         - Pool config
 * @param state        - Pool state
 * @param deviationBps - Computed deviation in bps (for logging; 0 if below threshold)
 */
function buildZeroRow(
  event: AnswerUpdatedEvent,
  pool: PoolConfig,
  state: PoolState,
  deviationBps: number,
  deviationBpsSigned = 0,
): ProfitRow {
  return {
    event,
    pool,
    stateBefore: state,
    deviationBps,
    deviationBpsSigned,
    swapAmountUsd: 0,
    gross: 0,
    flashloanFee: 0,
    dexFee: 0,
    gasUsd: 0,
    netConservative: 0,
    netOptimistic: 0,
  };
}
