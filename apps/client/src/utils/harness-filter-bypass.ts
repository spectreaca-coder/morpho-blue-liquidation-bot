/**
 * Harness filter bypass — TESTING/HARNESS ONLY.
 *
 * When HARNESS_BYPASS_FILTERS="1" AND chainId === 8453 (Base), the three
 * production filters (MIN_BORROW size gate, profit gate, position-cache HF
 * floor) are disabled so the test harness can drive the bot with tiny
 * synthetic positions.
 *
 * Chain gate is a HARD safety firewall: bypass NEVER activates on mainnet (1)
 * or Arbitrum (42161), only on Base (8453).
 *
 * Production default: env unset → all filters behave identically to before.
 */

const BASE_CHAIN_ID = 8453;

/**
 * Returns true only when HARNESS_BYPASS_FILTERS is EXACTLY "1" and the chain
 * is Base (8453). Strict string comparison — "0", "false", "true" all return
 * false.
 *
 * @param chainId - The numeric chain ID of the current bot instance.
 */
export function isHarnessBypassActive(chainId: number): boolean {
  return chainId === BASE_CHAIN_ID && process.env.HARNESS_BYPASS_FILTERS === "1";
}

/**
 * Returns the effective MIN_BORROW threshold (6-decimal USDC units).
 * When bypass is active on Base: 0n (no minimum).
 * Otherwise: defaultValue (production constant).
 *
 * @param chainId      - The numeric chain ID of the current bot instance.
 * @param defaultValue - The production constant (e.g. MIN_BORROW_USDC_6DEC).
 */
export function getMinBorrowUsdc6Dec(chainId: number, defaultValue: bigint): bigint {
  return isHarnessBypassActive(chainId) ? 0n : defaultValue;
}

/**
 * Returns the effective profit gate floor in USD.
 * When bypass is active on Base: -1 (so `usd < -1` never triggers).
 * Otherwise: defaultValue (production constant, typically 1).
 *
 * @param chainId      - The numeric chain ID of the current bot instance.
 * @param defaultValue - The production floor value (e.g. 1).
 */
export function getProfitGateUsd(chainId: number, defaultValue: number): number {
  return isHarnessBypassActive(chainId) ? -1 : defaultValue;
}

/**
 * Returns the effective healthFactor_gte floor for the position-cache GraphQL
 * query. When bypass is active on Base: 0 (fetch all positions regardless of
 * HF). Otherwise: defaultValue (production constant, typically 0.5).
 *
 * @param chainId      - The numeric chain ID of the current bot instance.
 * @param defaultValue - The production floor value (e.g. 0.5).
 */
export function getPositionCacheHfFloor(chainId: number, defaultValue: number): number {
  return isHarnessBypassActive(chainId) ? 0 : defaultValue;
}
