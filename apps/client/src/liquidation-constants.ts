/**
 * Liquidation constants shared across the fast-path pipeline.
 *
 * Extracted from index.ts to keep the orchestration file focused on wiring
 * and avoid duplicating these values in multiple modules.
 */

/**
 * Maps Chainlink aggregator addresses to the collateral symbol patterns
 * they affect. When an aggregator price update is detected, we filter
 * the PositionCache by these symbols instead of by oracle address.
 *
 * This avoids the complex aggregator → Chainlink proxy → Morpho oracle
 * address chain and is more robust against oracle contract upgrades.
 */
export const AGGREGATOR_TO_COLLATERAL_SYMBOLS: Record<string, string[]> = {
  "0x0e3dc8a6a86d2f6f5f67b373a047c267fb1fc3e6": ["btc", "wbtc"], // BTC/USD → cbBTC, WBTC positions
  "0x1e0b2c3896338fbb201c4f0a27c6904801dca06b": ["weth"], // ETH/USD → WETH only. "eth" would substring-match "cbETH"/"wstETH" (separate oracle feeds).
  "0x0ee7145e1370653533e2f2e824424be2aa95a4aa": ["usdc"], // USDC/USD → USDC-as-collateral markets (USDC/DEGEN, USDC/WETH). Precision path won't work (oracle gives USDC/USD not pair price), so fallback threshold 1.01 is used.
  "0x51ce3091cf646587e02cad83b580992f8723e718": ["btc", "cbbtc"], // CBBTC/USD → cbBTC positions
  "0x92a7c3a57e17aff701c159c5480073b095100b62": ["cbxrp", "xrp"], // XRP/USD → cbXRP/USDC (29% of liquidations)
  "0x91e936921df850cc8714527ebe6c45ecbd2cad31": ["cbada", "ada"], // ADA/USD → cbADA/USDC
  "0x5bf848b4ef13bd590ea41ad664ff45b155d1c582": ["cbltc", "ltc"], // LTC/USD → cbLTC/USDC
  "0x925861a08cc74d210a8691593f1c2aefebf2d10e": ["wrseth"], // wrsETH/ETH rate - wrsETH/WETH market (most active)
  "0x1e536d8f053feab16c65861b7a3462b5b5acd3a2": ["wsteth"], // wstETH/stETH rate - wstETH/WETH market
  "0x53fdcab0650570d07e2770004979ef10a86df559": ["cbeth"], // cbETH/ETH rate - cbETH/USDC market
};

/**
 * Aggregators that publish an **exchange-rate** (e.g. wrsETH/ETH ≈ 1.069e18),
 * not an 8-decimal USD feed. PositionCache.findLiquidatableByPrice() assumes
 * the 8-dec USD scale, so feeding a rate price through the precision path
 * inflates the Morpho oracle price and returns zero candidates. For these
 * feeds we must fall through to the symbol-based fallback path instead.
 */
export const RATE_FEED_AGGREGATORS = new Set<string>([
  "0x925861a08cc74d210a8691593f1c2aefebf2d10e", // wrsETH/ETH rate
  "0x1e536d8f053feab16c65861b7a3462b5b5acd3a2", // wstETH/stETH rate
  "0x53fdcab0650570d07e2770004979ef10a86df559", // cbETH/ETH rate
]);

/**
 * Collateral symbols to skip in profitability filtering.
 * These tokens have no viable swap route and would waste gas.
 */
export const SKIP_SYMBOLS = new Set(["mbasis", "wbcoin"]);

/**
 * Minimum borrow size for USDC-denominated (6-decimal) loans.
 * Liquidation incentive ~5% of borrow. Base gas+swap cost ~$0.50-$2.
 * $10 borrow → ~$0.50 profit margin.
 * 10 USDC = 10_000_000 (6 decimals).
 */
export const MIN_BORROW_USDC_6DEC = 10_000_000n;

/**
 * Minimum borrow size for WETH-denominated (18-decimal) loans.
 * 0.005 WETH ≈ $10 at ~$2000/ETH = 5_000_000_000_000_000 (18 decimals).
 */
export const MIN_BORROW_WETH_18DEC = 5_000_000_000_000_000n;

/**
 * Minimum valid Chainlink 8-decimal price ($0.01).
 * Anything below this is considered extraction noise.
 */
export const PRICE_MIN = 1_000_000n;

/**
 * Maximum valid Chainlink 8-decimal price ($10M).
 * Anything above this is considered extraction noise.
 */
// Max: covers 8-dec USD (M = 10^15) and 18-dec exchange rates (2.0 = 2×10^18)
export const PRICE_MAX = 2_000_000_000_000_000_000n;
