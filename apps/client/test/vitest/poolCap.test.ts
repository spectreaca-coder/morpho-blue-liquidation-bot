/**
 * Unit tests for poolCap.maxSafeSeize.
 *
 * All tests are pure (no RPC, no mocks needed) because maxSafeSeize
 * operates only on the pre-computed pool depth estimates that the caller
 * already obtained from estimateUniswapV3MaxSwapIn.
 */

import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { CbXrpPoolAwareConfig } from "../../src/poolCap.js";
import { maxSafeSeize } from "../../src/poolCap.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const DIRECT_POOL = "0x3733cbB1402C788900A0A152e61c9aA31888FB95" as Address;
const CBXRP_WETH_POOL = "0x6ceFe2a691b1734042c10958B8E0EC19D81b2850" as Address;
const WETH_USDC_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as Address;
const CBXRP_MARKET_ID = "0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109" as Hex;

/** slippageBudgetBps = 100 (1%) matches production config */
const CONFIG: CbXrpPoolAwareConfig = {
  marketId: CBXRP_MARKET_ID,
  slippageBudgetBps: 100,
  router: ROUTER,
  direct: { pool: DIRECT_POOL, fee: 10_000 },
  fallback: {
    cbXrpToWeth: { pool: CBXRP_WETH_POOL, fee: 10_000 },
    wethToUsdc: { pool: WETH_USDC_POOL, fee: 500 },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("maxSafeSeize", () => {
  it("caps to directPoolMaxIn when pool depth is the binding constraint", () => {
    // Pool can absorb 5_000 cbXRP; we want to seize 10_000 cbXRP.
    // Expected: cap = 5_000, then apply 1% safety → 4_950
    const result = maxSafeSeize({
      directPoolMaxIn: 5_000n,
      fallbackLeg1MaxIn: null,
      requestedSeize: 10_000n,
      config: CONFIG,
    });

    expect(result).toBeLessThanOrEqual(5_000n);
    // safety margin applied: 5000 * (10000 - 100) / 10000 = 4950
    expect(result).toBe(4_950n);
  });

  it("returns requestedSeize (safety-scaled) when pool has ample depth", () => {
    // Pool can absorb 100_000; we only want 8_000.
    // Cap = 8_000, safety → 8_000 * 9_900 / 10_000 = 7_920
    const result = maxSafeSeize({
      directPoolMaxIn: 100_000n,
      fallbackLeg1MaxIn: null,
      requestedSeize: 8_000n,
      config: CONFIG,
    });

    expect(result).toBe(7_920n);
  });

  it("falls back to fallbackLeg1MaxIn when direct pool is exhausted", () => {
    // Direct pool cannot absorb anything; fallback leg-1 has 6_000 capacity.
    const result = maxSafeSeize({
      directPoolMaxIn: 0n,
      fallbackLeg1MaxIn: 6_000n,
      requestedSeize: 10_000n,
      config: CONFIG,
    });

    // fallback cap = min(6000, 10000) = 6000; safety → 5940
    expect(result).toBe(5_940n);
  });

  it("returns 0n when both routes are exhausted", () => {
    const result = maxSafeSeize({
      directPoolMaxIn: 0n,
      fallbackLeg1MaxIn: 0n,
      requestedSeize: 10_000n,
      config: CONFIG,
    });

    expect(result).toBe(0n);
  });

  it("returns 0n when requestedSeize is 0", () => {
    const result = maxSafeSeize({
      directPoolMaxIn: 100_000n,
      fallbackLeg1MaxIn: 50_000n,
      requestedSeize: 0n,
      config: CONFIG,
    });

    expect(result).toBe(0n);
  });

  it("never returns more than requestedSeize", () => {
    const result = maxSafeSeize({
      directPoolMaxIn: 999_999_999n, // enormous pool
      fallbackLeg1MaxIn: null,
      requestedSeize: 1_000n,
      config: CONFIG,
    });

    expect(result).toBeLessThanOrEqual(1_000n);
  });
});
