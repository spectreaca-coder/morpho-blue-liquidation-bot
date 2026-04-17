export interface OracleFeed {
  symbol: string; // "cbBTC/USD"
  aggregator: `0x${string}`; // Chainlink aggregator on Base
  decimals: number; // price decimals (usually 8)
  heartbeatSec: number; // max update interval
  deviationBps: number; // trigger threshold
}

export interface PoolConfig {
  symbol: string; // "WETH/USDC UniV3 500"
  address: `0x${string}`;
  type: "uniswapV3" | "aerodromeCL";
  token0: `0x${string}`;
  token1: `0x${string}`;
  token0Decimals: number;
  token1Decimals: number;
  feePpm: number; // 500 = 0.05%
  feedSymbol: string; // connected oracle symbol
  quoteIsToken0: boolean; // whether oracle price is token0-based
}

export interface AnswerUpdatedEvent {
  block: bigint;
  txHash: `0x${string}`;
  timestamp: bigint;
  oracleSymbol: string;
  roundId: bigint;
  newPrice: bigint; // raw int256
  newPriceUsd: number; // decoded with decimals
}

export interface PoolState {
  block: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  impliedPrice: number; // token1/token0 price
}

export interface ProfitRow {
  event: AnswerUpdatedEvent;
  pool: PoolConfig;
  stateBefore: PoolState;
  deviationBps: number;
  /**
   * Signed deviation in bps (positive = oracle > pool → buy FROM pool;
   * negative = oracle < pool → sell TO pool). Used by the competition
   * analyzer to pick the correct per-row arb direction (reviewer Finding 2).
   */
  deviationBpsSigned: number;
  swapAmountUsd: number;
  gross: number;
  flashloanFee: number;
  dexFee: number;
  gasUsd: number;
  netConservative: number; // ×0.3
  netOptimistic: number; // ×0.6
}
