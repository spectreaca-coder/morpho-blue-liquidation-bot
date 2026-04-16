/**
 * profit-calc.test.ts
 *
 * TDD tests for computeProfit() — Sprint 4 FULL tier.
 *
 * Key invariants under test:
 *   1. No arb when deviation < 1.5× fee tier
 *   2. Positive profit for large deviation + deep liquidity
 *   3. Conservative discount ×0.3, optimistic ×0.6
 *   4. Gas cost scales with baseFee and ETH price
 *   5. Zero profit when liquidity = 0
 *   6. CRITICAL: wstETH/WETH sign correctness (pool-state inverts; profit-calc compares directly)
 *   7. Profit > 0 only when |deviation| > 1.5× fee tier
 *
 * Price alignment design:
 *   pool-state.ts returns impliedPrice already aligned with oracle direction:
 *     quoteIsToken0=false → impliedPrice = token1/token0 (raw)
 *     quoteIsToken0=true  → impliedPrice = 1/(token1/token0) (inverted, matches oracle)
 *   profit-calc compares oracle vs impliedPrice DIRECTLY (no additional inversion).
 */

import { describe, it, expect } from "vitest";

import { computeProfit } from "../src/profit-calc.js";
import type { AnswerUpdatedEvent, PoolConfig, PoolState } from "../src/types.js";

// ─── Mock helpers ────────────────────────────────────────────────────────────

/**
 * Generic mock pool: WETH/USDC-like.
 * quoteIsToken0=false: pool-state returns USDC/WETH (token1/token0).
 * Oracle ETH/USD = USDC/WETH. Same direction. Direct comparison.
 */
const mockPool: PoolConfig = {
  symbol: "WETH/USDC mock",
  address: "0x0000000000000000000000000000000000000001",
  type: "uniswapV3",
  token0: "0x0000000000000000000000000000000000000002",
  token1: "0x0000000000000000000000000000000000000003",
  token0Decimals: 18,
  token1Decimals: 6,
  feePpm: 500, // 0.05%
  feedSymbol: "ETH/USD",
  quoteIsToken0: false,
};

function makeEvent(oraclePriceUsd: number, symbol = "ETH/USD"): AnswerUpdatedEvent {
  return {
    block: 1n,
    txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    timestamp: 0n,
    oracleSymbol: symbol,
    roundId: 1n,
    newPrice: BigInt(Math.round(oraclePriceUsd * 1e8)),
    newPriceUsd: oraclePriceUsd,
  };
}

function makeState(impliedPrice: number, liquidityBigint = 10n ** 24n): PoolState {
  return {
    block: 1n,
    sqrtPriceX96: 0n, // not used by profit-calc (pure; uses impliedPrice directly)
    tick: 0,
    liquidity: liquidityBigint,
    impliedPrice,
  };
}

/** 1 gwei baseFee */
const BASE_FEE_LOW = 1_000_000_000n;
const ETH_PRICE = 2_350;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("profit calc", () => {
  // ─── Test 1: No arb below 1.5× fee threshold ──────────────────────────────
  it("returns 0 net when deviation < 1.5x fee tier", () => {
    // feePpm=500 → fee=0.05%. Threshold = 1.5× = 0.075%.
    // Oracle=3000, pool=3000.05 → deviation=0.0017% << 0.075%. No arb.
    const event = makeEvent(3000);
    const state = makeState(3000.05);

    const r = computeProfit(event, mockPool, state, BASE_FEE_LOW, ETH_PRICE);

    expect(r.gross).toBeLessThanOrEqual(0);
    expect(r.netConservative).toBeLessThanOrEqual(0);
    expect(r.netOptimistic).toBeLessThanOrEqual(0);
    expect(r.deviationBps).toBeGreaterThanOrEqual(0);
  });

  // ─── Test 2: Positive profit for 1% deviation on deep pool ───────────────
  it("returns positive net for 1% dev on $100M depth pool", () => {
    // Oracle +1%: 3000 → 3030. Pool at 3000. 100 bps >> 0.075% threshold.
    const event = makeEvent(3030);
    const state = makeState(3000, 10n ** 24n);

    const r = computeProfit(event, mockPool, state, BASE_FEE_LOW, ETH_PRICE);

    expect(r.gross).toBeGreaterThan(0);
    expect(r.netConservative).toBeGreaterThan(0);
    expect(r.netOptimistic).toBeGreaterThan(r.netConservative);
    expect(r.deviationBps).toBeCloseTo(100, 0); // ~100 bps = 1%
  });

  // ─── Test 3: Discount factor correctness ──────────────────────────────────
  it("conservative net = afterCosts × 0.3, optimistic × 0.6", () => {
    const event = makeEvent(3030);
    const state = makeState(3000, 10n ** 24n);

    const r = computeProfit(event, mockPool, state, BASE_FEE_LOW, ETH_PRICE);

    const afterCosts = r.gross - r.flashloanFee - r.dexFee - r.gasUsd;
    expect(r.netConservative).toBeCloseTo(afterCosts * 0.3, 6);
    expect(r.netOptimistic).toBeCloseTo(afterCosts * 0.6, 6);
  });

  // ─── Test 4: Gas scales with baseFee and ETH price ────────────────────────
  it("gas cost scales with baseFee and ETH price", () => {
    // pool > oracle: pool=3030, oracle=3000 → pool overpriced, arb exists
    const event = makeEvent(3000);
    const state = makeState(3030, 10n ** 24n);

    const rHigh = computeProfit(event, mockPool, state, 10_000_000_000n, ETH_PRICE); // 10 gwei
    const rLow = computeProfit(event, mockPool, state, 1_000_000_000n, ETH_PRICE); // 1 gwei
    expect(rHigh.gasUsd).toBeGreaterThan(rLow.gasUsd);

    // Higher ETH price → higher gasUsd (same baseFee)
    const rHighEth = computeProfit(event, mockPool, state, 1_000_000_000n, 4_000);
    expect(rHighEth.gasUsd).toBeGreaterThan(rLow.gasUsd);
  });

  // ─── Test 5: Zero liquidity → zero gross ──────────────────────────────────
  it("returns 0 gross when liquidity is 0", () => {
    const event = makeEvent(3030);
    const state = makeState(3000, 0n);

    const r = computeProfit(event, mockPool, state, BASE_FEE_LOW, ETH_PRICE);

    expect(r.gross).toBe(0);
    expect(r.swapAmountUsd).toBe(0);
    expect(r.netConservative).toBe(0);
    expect(r.netOptimistic).toBe(0);
  });

  // ─── Test 6: CRITICAL — wstETH/WETH sign correctness ─────────────────────
  it("CRITICAL: wstETH/WETH (quoteIsToken0=true) deviation has correct SIGN when oracle moves up", () => {
    /**
     * Pool: WETH/wstETH UniV3 100 (real config in config.ts)
     *   token0 = WETH, token1 = wstETH
     *   quoteIsToken0=true: pool-state.ts inverts raw price
     *   Raw pool: wstETH/WETH ≈ 0.812 (1 WETH buys 0.812 wstETH)
     *   pool-state.ts impliedPrice = 1/0.812 ≈ 1.231 (WETH per wstETH)
     *
     * Oracle wstETH/ETH = 1.24 (ETH per wstETH = WETH per wstETH)
     * Both impliedPrice and oracle are now in WETH-per-wstETH. Direct compare.
     *
     * Oracle 1.24 > pool 1.231 → +73 bps deviation
     * Pool underprices wstETH → buy wstETH from pool → POSITIVE profit
     *
     * Production safety gate: if sign were wrong, bot would arb in losing direction.
     */
    const wstEthPool: PoolConfig = {
      symbol: "WETH/wstETH UniV3 100",
      address: "0x20E068D76f9E90b90604500B84c7e19dCB923e7e",
      type: "uniswapV3",
      token0: "0x4200000000000000000000000000000000000006", // WETH
      token1: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
      token0Decimals: 18,
      token1Decimals: 18,
      feePpm: 100, // 0.01%
      feedSymbol: "wstETH/ETH",
      // quoteIsToken0=true: pool-state.ts inverted raw wstETH/WETH → impliedPrice = WETH/wstETH
      quoteIsToken0: true,
    };

    // Oracle: wstETH/ETH = 1.24 (ETH per wstETH = WETH per wstETH)
    const event: AnswerUpdatedEvent = {
      block: 1n,
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      timestamp: 0n,
      oracleSymbol: "wstETH/ETH",
      roundId: 1n,
      newPrice: BigInt(Math.round(1.24 * 1e18)),
      newPriceUsd: 1.24, // ETH per wstETH ratio
    };

    // pool-state.ts returns impliedPrice = 1/0.812 = 1.231 (WETH per wstETH)
    // Oracle 1.24 vs pool 1.231 → deviation = (1.24 - 1.231) / 1.231 ≈ +73 bps
    const state: PoolState = {
      block: 1n,
      sqrtPriceX96: 0n,
      tick: 0,
      liquidity: 10n ** 24n, // large enough for positive net after gas
      impliedPrice: 1.231, // pool-state output after quoteIsToken0=true inversion: 1/0.812
    };

    const r = computeProfit(event, wstEthPool, state, BASE_FEE_LOW, ETH_PRICE);

    // Deviation: (1.24 - 1.231) / 1.231 × 10000 ≈ 73.1 bps
    expect(r.deviationBps).toBeGreaterThan(0);
    expect(r.deviationBps).toBeCloseTo(73.1, 0);

    // Profit MUST be positive — negative = wrong arb direction = lose money
    expect(r.netConservative).toBeGreaterThan(0);
    expect(r.netOptimistic).toBeGreaterThan(0);
  });

  // ─── Test 7: Threshold gate ────────────────────────────────────────────────
  it("CRITICAL: profit > 0 only when |deviation| > fee + flashloan + gas-as-pct", () => {
    // feePpm=500 → 0.05%. Threshold = 1.5× = 0.075%.
    const event = makeEvent(3000);
    const poolFee500 = { ...mockPool, feePpm: 500 };

    // Just below threshold: deviation = 0.06% → pool = 3001.8
    const stateBelowThreshold = makeState(3001.8);
    const rBelow = computeProfit(event, poolFee500, stateBelowThreshold, BASE_FEE_LOW, ETH_PRICE);
    expect(rBelow.gross).toBeLessThanOrEqual(0);

    // Comfortably above threshold: deviation = 0.2% → pool = 3006
    const stateAboveThreshold = makeState(3006);
    const rAbove = computeProfit(event, poolFee500, stateAboveThreshold, BASE_FEE_LOW, ETH_PRICE);
    expect(rAbove.gross).toBeGreaterThan(0);
  });
});
