import { OracleFeed, PoolConfig } from "./types.js";

// Base mainnet Chainlink aggregator addresses.
// Verified against Base mainnet RPC via description() + decimals() calls.
export const FEEDS: OracleFeed[] = [
  {
    symbol: "ETH/USD",
    aggregator: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    decimals: 8,
    heartbeatSec: 1200,
    deviationBps: 15,
  },
  {
    symbol: "cbBTC/USD",
    // Verified: description() returns "cbBTC / USD"
    aggregator: "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D",
    decimals: 8,
    heartbeatSec: 1200,
    deviationBps: 15,
  },
  {
    symbol: "wstETH/ETH",
    // Verified: description() returns "wstETH-stETH Exchange Rate", decimals=18
    aggregator: "0xB88BAc61a4Ca37C43a3725912B1f472c9A5bc061",
    decimals: 18,
    heartbeatSec: 86400,
    deviationBps: 50,
  },
  {
    symbol: "cbETH/ETH",
    // Corrected from plan: 0x868a501e68F3D1E89CfC0D13d0BeE80Ab7d88B90 returns empty.
    // 0x806b4Ac04501c29769051e42783cF04dCE41440b returns "CBETH / ETH", decimals=18
    aggregator: "0x806b4Ac04501c29769051e42783cF04dCE41440b",
    decimals: 18,
    heartbeatSec: 86400,
    deviationBps: 50,
  },
];

// Base mainnet token addresses (verified on-chain).
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const cbBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const wstETH = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
const cbETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";

/**
 * 6 Base mainnet pool configs.
 *
 * Verification method per pool:
 *   UniswapV3: token0()/token1()/fee() on-chain via UniV3 Factory getPool()
 *   Aerodrome CL: factory getPool(tokenA,tokenB,tickSpacing), picked highest TVL
 *
 * Pool 1 — WETH/USDC UniV3 500
 *   Verified: token0=WETH, token1=USDC, fee=500 (on-chain confirmed)
 *
 * Pool 2 — USDC/cbBTC UniV3 500
 *   Plan address had wrong checksum + wrong fee (3000).
 *   Factory getPool(cbBTC,USDC,500) → 0xfBB6...
 *   Verified: token0=USDC, token1=cbBTC, fee=500
 *
 * Pool 3 — WETH/wstETH UniV3 100
 *   Plan address was correct but fee was wrong (plan said 500, actual=100).
 *   Factory getPool(wstETH,WETH,100) → 0x20E0...
 *   Verified: token0=WETH, token1=wstETH, fee=100
 *
 * Pool 4 — cbETH/WETH UniV3 500
 *   Verified: token0=cbETH, token1=WETH, fee=500 (on-chain confirmed)
 *
 * Pool 5 — WETH/USDC Aerodrome CL tickSpacing=100
 *   Factory tickSpacing 50/100/200 checked. tickSpacing=100 → highest liquidity
 *   (15709785883215190645 vs 10337973387059 for ts=200; ts=50 liq=0)
 *
 * Pool 6 — USDC/cbBTC Aerodrome CL tickSpacing=100
 *   Factory tickSpacing 50/200 → NOT FOUND. Only ts=100 exists.
 */
export const POOLS: PoolConfig[] = [
  // ─── UniswapV3 ───────────────────────────────────────────────────────────
  {
    symbol: "WETH/USDC UniV3 500",
    address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    type: "uniswapV3",
    token0: WETH,
    token1: USDC,
    token0Decimals: 18,
    token1Decimals: 6,
    feePpm: 500,
    feedSymbol: "ETH/USD",
    // price = sqrtPrice^2 * 1e18 / 1e6 → token1(USDC) per token0(WETH) = ETH price in USD
    quoteIsToken0: false,
  },
  {
    // Note: token0 = USDC (lower address), token1 = cbBTC
    symbol: "USDC/cbBTC UniV3 500",
    address: "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef",
    type: "uniswapV3",
    token0: USDC,
    token1: cbBTC,
    token0Decimals: 6,
    token1Decimals: 8,
    feePpm: 500,
    feedSymbol: "cbBTC/USD",
    // price = sqrtPrice^2 * 1e6 / 1e8 → token1(cbBTC) per token0(USDC)
    // impliedPrice = USDC per cbBTC = 1 / (sqrtPrice^2 * 1e6 / 1e8)
    quoteIsToken0: true,
  },
  {
    // Note: token0 = WETH (lower address), token1 = wstETH
    symbol: "WETH/wstETH UniV3 100",
    address: "0x20E068D76f9E90b90604500B84c7e19dCB923e7e",
    type: "uniswapV3",
    token0: WETH,
    token1: wstETH,
    token0Decimals: 18,
    token1Decimals: 18,
    feePpm: 100,
    feedSymbol: "wstETH/ETH",
    // price = sqrtPrice^2 → token1(wstETH) per token0(WETH) ≈ ~1.16
    quoteIsToken0: false,
  },
  {
    symbol: "cbETH/WETH UniV3 500",
    address: "0x10648BA41B8565907Cfa1496765fA4D95390aa0d",
    type: "uniswapV3",
    token0: cbETH,
    token1: WETH,
    token0Decimals: 18,
    token1Decimals: 18,
    feePpm: 500,
    feedSymbol: "cbETH/ETH",
    // price = sqrtPrice^2 → token1(WETH) per token0(cbETH) ≈ ~1.05
    quoteIsToken0: false,
  },

  // ─── Aerodrome CL ────────────────────────────────────────────────────────
  {
    symbol: "WETH/USDC Aero CL 100",
    address: "0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59",
    type: "aerodromeCL",
    token0: WETH,
    token1: USDC,
    token0Decimals: 18,
    token1Decimals: 6,
    feePpm: 100, // Aerodrome CL tickSpacing=100 corresponds to ~0.01% fee tier
    feedSymbol: "ETH/USD",
    quoteIsToken0: false,
  },
  {
    // Note: token0 = USDC (lower address), token1 = cbBTC
    symbol: "USDC/cbBTC Aero CL 100",
    address: "0x4e962BB3889Bf030368F56810A9c96B83CB3E778",
    type: "aerodromeCL",
    token0: USDC,
    token1: cbBTC,
    token0Decimals: 6,
    token1Decimals: 8,
    feePpm: 100,
    feedSymbol: "cbBTC/USD",
    quoteIsToken0: true,
  },
];

const _rpcUrl =
  process.env.BASE_ARCHIVE_RPC_URL ?? process.env.BASE_RPC_URL_HTTP ?? "https://base.drpc.org";

if (!_rpcUrl) {
  throw new Error(
    "BASE_RPC_URL is empty after all fallbacks (BASE_ARCHIVE_RPC_URL, BASE_RPC_URL_HTTP, drpc.org)",
  );
}

export const BASE_RPC_URL = _rpcUrl;
export const REPLAY_DAYS = 14;
export const GAS_LIMIT_LIQUIDATION = 250_000n;
export const MIN_PROFIT_USD = 0.5;
export const CONSERVATIVE_DISCOUNT = 0.3;
export const OPTIMISTIC_DISCOUNT = 0.6;
