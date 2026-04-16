import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { describe, it, expect } from "vitest";

import { POOLS, BASE_RPC_URL } from "../src/config.js";
import { readPoolState } from "../src/pool-state.js";

/**
 * Sprint 3: pool-state tests.
 *
 * Reads WETH/USDC UniV3 500 at two historical blocks (current + current-100_000)
 * to verify archive RPC reads work and return sane values.
 */
describe("pool-state", () => {
  const client = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });

  it("WETH/USDC UniV3 500: non-zero sqrtPriceX96 + liquidity at current block", async () => {
    const pool = POOLS.find((p) => p.symbol === "WETH/USDC UniV3 500");
    if (!pool) throw new Error("WETH/USDC UniV3 500 not found in POOLS");

    const latestBlock = await client.getBlockNumber();
    const state = await readPoolState(pool, latestBlock, client);

    // sqrtPriceX96 must be non-zero
    expect(state.sqrtPriceX96).toBeGreaterThan(0n);
    // liquidity must be non-zero (active pool)
    expect(state.liquidity).toBeGreaterThan(0n);
    // block must match requested
    expect(state.block).toBe(latestBlock);
    // Implied price: USDC per WETH = ETH price in USD, expect $1000–$10000
    expect(state.impliedPrice).toBeGreaterThan(1_000);
    expect(state.impliedPrice).toBeLessThan(10_000);

    console.log(
      `[current] WETH/USDC sqrtPriceX96=${state.sqrtPriceX96} impliedPrice=${state.impliedPrice.toFixed(2)} liq=${state.liquidity}`,
    );
  }, 60_000);

  it("WETH/USDC UniV3 500: non-zero sqrtPriceX96 + liquidity at (latest - 100_000)", async () => {
    const pool = POOLS.find((p) => p.symbol === "WETH/USDC UniV3 500");
    if (!pool) throw new Error("WETH/USDC UniV3 500 not found in POOLS");

    const latestBlock = await client.getBlockNumber();
    const historicalBlock = latestBlock - 100_000n;

    const state = await readPoolState(pool, historicalBlock, client);

    // sqrtPriceX96 must be non-zero
    expect(state.sqrtPriceX96).toBeGreaterThan(0n);
    // liquidity must be non-zero
    expect(state.liquidity).toBeGreaterThan(0n);
    // block must match requested
    expect(state.block).toBe(historicalBlock);
    // Implied price sanity (historical ETH still in $1000–$10000 range)
    expect(state.impliedPrice).toBeGreaterThan(1_000);
    expect(state.impliedPrice).toBeLessThan(10_000);

    console.log(
      `[historical -100k] WETH/USDC sqrtPriceX96=${state.sqrtPriceX96} impliedPrice=${state.impliedPrice.toFixed(2)} liq=${state.liquidity}`,
    );
  }, 60_000);

  it("POOLS array has 5-6 entries", () => {
    expect(POOLS.length).toBeGreaterThanOrEqual(5);
    expect(POOLS.length).toBeLessThanOrEqual(6);
  });

  it("every pool has required fields set", () => {
    for (const p of POOLS) {
      expect(p.symbol, `${p.symbol} missing symbol`).toBeTruthy();
      expect(p.address, `${p.symbol} missing address`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(["uniswapV3", "aerodromeCL"]).toContain(p.type);
      expect(p.token0, `${p.symbol} token0`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(p.token1, `${p.symbol} token1`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(p.token0Decimals, `${p.symbol} token0Decimals`).toBeGreaterThan(0);
      expect(p.token1Decimals, `${p.symbol} token1Decimals`).toBeGreaterThan(0);
      expect(p.feePpm, `${p.symbol} feePpm`).toBeGreaterThan(0);
      expect(p.feedSymbol, `${p.symbol} feedSymbol`).toBeTruthy();
    }
  });
});
