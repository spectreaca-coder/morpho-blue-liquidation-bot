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

// Pools are finalised in Task 4. Empty for now.
export const POOLS: PoolConfig[] = [];

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
