/**
 * pool-state.ts
 *
 * Reads UniswapV3 / Aerodrome CL pool state (slot0 + liquidity) at any
 * historical block using an archive RPC.
 *
 * NOTE: slot0 ABI differs between pool types:
 *   UniswapV3:    (sqrtPriceX96, tick, obsIdx, obsCap, obsCapNext, feeProtocol, unlocked) — 7 fields
 *   Aerodrome CL: (sqrtPriceX96, tick, obsIdx, obsCap, obsCapNext, unlocked)              — 6 fields (no feeProtocol)
 *
 * The `liquidity()` ABI is identical for both.
 */

import { PublicClient, parseAbi } from "viem";

import { PoolConfig, PoolState } from "./types.js";

// ─── ABIs ────────────────────────────────────────────────────────────────────

/**
 * UniswapV3 slot0: 7 return values (includes feeProtocol at index 5).
 * Verified on Base mainnet against WETH/USDC 500, cbETH/WETH 500, etc.
 */
const UNIV3_SLOT0_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

/**
 * Aerodrome CL slot0: 6 return values (no feeProtocol field).
 * Verified on Base mainnet against WETH/USDC Aero CL 100 + USDC/cbBTC Aero CL 100.
 */
const AERODROME_SLOT0_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
]);

/** liquidity() ABI is identical for UniswapV3 and Aerodrome CL. */
const LIQUIDITY_ABI = parseAbi(["function liquidity() view returns (uint128)"]);

// ─── Price computation ────────────────────────────────────────────────────

/** 2^96 as a bigint constant — used in sqrtPriceX96 price calculation. */
const Q96 = 2n ** 96n;

/**
 * Converts sqrtPriceX96 + decimal info into an implied price (token1/token0
 * or token0/token1 if quoteIsToken0=true).
 *
 * Formula: (sqrtPriceX96 / 2^96)^2 * 10^(token0Decimals - token1Decimals)
 *
 * For pools where quoteIsToken0=true (e.g. USDC/cbBTC — token0=USDC, token1=cbBTC),
 * the raw formula gives cbBTC-per-USDC; we invert to get USDC-per-cbBTC (≈ BTC price).
 *
 * Intermediate arithmetic uses fixed-point bigint (scale=1e18) to avoid
 * precision loss before converting to Number per spec guidance.
 *
 * @param sqrtPriceX96 - Raw uint160 value from slot0()
 * @param token0Decimals - ERC-20 decimals of token0
 * @param token1Decimals - ERC-20 decimals of token1
 * @param quoteIsToken0 - If true, return inverted price (token0 per token1)
 * @returns Implied price as a JS number
 */
function computeImpliedPrice(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
  quoteIsToken0: boolean,
): number {
  // Scale factor for fixed-point intermediate arithmetic.
  const SCALE = 10n ** 18n;

  // (sqrtPriceX96 / Q96)^2 * SCALE = sqrtPriceX96^2 * SCALE / Q96^2
  const numerator = sqrtPriceX96 * sqrtPriceX96 * SCALE;
  const denominator = Q96 * Q96;

  // rawScaled = (token1/token0) in fixed-point (ignoring decimal adjustment)
  const rawScaled = numerator / denominator;

  // Convert to JS number and apply decimal adjustment
  const raw = Number(rawScaled) / 1e18;
  const decimalAdj = Math.pow(10, token0Decimals - token1Decimals);
  const implied = raw * decimalAdj;

  // quoteIsToken0: oracle price is expressed as token0-per-token1, so invert
  return quoteIsToken0 ? 1 / implied : implied;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Reads slot0 + liquidity for a pool at a given block number (archive RPC).
 *
 * Automatically selects the correct slot0 ABI based on pool.type:
 *   - "uniswapV3"   → 7-field slot0 (includes feeProtocol)
 *   - "aerodromeCL" → 6-field slot0 (no feeProtocol)
 *
 * @param pool   - Pool configuration from POOLS in config.ts
 * @param block  - Historical block number (requires archive RPC for old blocks)
 * @param client - viem PublicClient connected to an archive-capable endpoint
 * @returns PoolState with sqrtPriceX96, tick, liquidity, and implied price
 * @throws If the RPC call fails or sqrtPriceX96=0 (uninitialised pool)
 */
export async function readPoolState(
  pool: PoolConfig,
  block: bigint,
  client: PublicClient,
): Promise<PoolState> {
  // Select ABI based on pool type
  const slot0Abi = pool.type === "uniswapV3" ? UNIV3_SLOT0_ABI : AERODROME_SLOT0_ABI;

  const [slot0Result, liquidity] = await Promise.all([
    client.readContract({
      address: pool.address,
      abi: slot0Abi,
      functionName: "slot0",
      blockNumber: block,
    }),
    client.readContract({
      address: pool.address,
      abi: LIQUIDITY_ABI,
      functionName: "liquidity",
      blockNumber: block,
    }),
  ]);

  const sqrtPriceX96 = slot0Result[0];
  const tick = slot0Result[1];

  if (sqrtPriceX96 === 0n) {
    throw new Error(
      `Pool ${pool.symbol} (${pool.address}) returned sqrtPriceX96=0 at block ${block}. Pool may be uninitialised.`,
    );
  }

  const impliedPrice = computeImpliedPrice(
    sqrtPriceX96,
    pool.token0Decimals,
    pool.token1Decimals,
    pool.quoteIsToken0,
  );

  return {
    block,
    sqrtPriceX96,
    tick,
    liquidity,
    impliedPrice,
  };
}
