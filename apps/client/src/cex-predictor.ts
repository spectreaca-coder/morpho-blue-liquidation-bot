/**
 * CEX Price Predictor for Morpho Blue Liquidation Bot
 *
 * Monitors Coinbase WebSocket price feeds and detects when CEX prices
 * cross liquidation thresholds BEFORE the on-chain oracle updates.
 * This gives a 5-15 second head start over competitors who wait for
 * on-chain Chainlink AnswerUpdated events.
 *
 * Architecture:
 * - Coinbase WS → real-time price ticks
 * - Threshold table: {borrower → triggerPrice} pre-computed from on-chain data
 * - When CEX price crosses threshold → callback fires → bot can pre-build and submit TX
 */

import { type Address, type Hex } from "viem";

// WebSocket constructor type (resolved at runtime via dynamic import)
type WSConstructor = new (url: string) => {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  send: (data: string) => void;
  close: () => void;
};
let WS: WSConstructor;
const wsReady = import("ws").then((mod) => {
  WS = mod.default as unknown as WSConstructor;
});

// Coinbase WS (US-accessible, Coinbase blocked from US IPs)
const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";

// Map Chainlink feed addresses on Base to Coinbase trading pairs
// These are the BASE_FEED_1 addresses from MorphoChainlinkOracleV2
export const ORACLE_TO_CEX_MAP: Record<string, { pair: string; symbol: string }> = {
  // cbBTC/USDC market — BASE_FEED_1 = BTC/USD Chainlink
  "0x64c911996d3c6ac71f9b455b1e8e7266bcbd848f": { pair: "BTC-USD", symbol: "BTC" },
  // cbXRP/USDC market — BASE_FEED_1 = XRP/USD Chainlink
  "0x9f0c1dd78c4cbdf5b9cf923a549a201edc676d34": { pair: "XRP-USD", symbol: "XRP" },
  // WETH/USDC market — BASE_FEED_1 = ETH/USD Chainlink
  "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70": { pair: "ETH-USD", symbol: "ETH" },
  // cbADA/USDC market — BASE_FEED_1 = ADA/USD Chainlink
  "0x34cd971a092d5411bd69c10a5f0a7eef72c69041": { pair: "ADA-USD", symbol: "ADA" },
  // cbLTC/USDC market — BASE_FEED_1 = LTC/USD Chainlink
  "0x206a34e47093125fbf4c75b7c7e88b84c6a77a69": { pair: "LTC-USD", symbol: "LTC" },
  // cbETH/USDC market — BASE_FEED_1 = ETH/USD (cbETH tracks ETH)
  "0x806b4ac04501c29769051e42783cf04dce41440b": { pair: "ETH-USD", symbol: "ETH" },

  // === ETH Mainnet oracle addresses ===
  // WBTC/USDC, WBTC/USDT, WBTC/EURC, WBTC/WETH — BTC price driven
  "0xdddd770badd886df3864029e4b377b5f6a2b6b83": { pair: "BTC-USD", symbol: "BTC" },
  "0x008bf4b1cda0cc9f0e882e0697f036667652e1ef": { pair: "BTC-USD", symbol: "BTC" },
  "0x9cb3f4276bcd149b3668e1a645a964bc12877b89": { pair: "BTC-USD", symbol: "BTC" },
  "0xc29b3bc033640bae31ca53f8a0eb892adf68e663": { pair: "BTC-USD", symbol: "BTC" },
  // cbBTC/USDC, cbBTC/USDT — also BTC price driven
  "0xa6d6950c9f177f1de7f7757fb33539e3ec60182a": { pair: "BTC-USD", symbol: "BTC" },
  "0x0e053750dfa4e809e5f7b119832c799c2aa138ac": { pair: "BTC-USD", symbol: "BTC" },
  // wstETH/USDC, wstETH/USDT, wstETH/EURC — ETH price driven
  "0x48f7e36eb6b826b2df4b2e630b62cd25e89e40e2": { pair: "ETH-USD", symbol: "ETH" },
  "0x95db30fab9a3754e42423000df27732cb2396992": { pair: "ETH-USD", symbol: "ETH" },
  "0x6eb9f4128cebc8b885a4d8562db1addf097f7348": { pair: "ETH-USD", symbol: "ETH" },
  // XAUt/USDT — Gold price (no Coinbase pair, skip)
  // PAXG/USDC — Gold price (no Coinbase pair, skip)
};

// All unique Coinbase pairs we need to subscribe to
const COINBASE_PAIRS = [...new Set(Object.values(ORACLE_TO_CEX_MAP).map((v) => v.pair))];

export interface LiquidationThreshold {
  borrower: Address;
  marketId: Hex;
  /** The oracle price (in 36-decimal Morpho format) at which HF = 1.0 */
  triggerOraclePrice: bigint;
  /** Equivalent CEX price in USD (float) for quick comparison */
  triggerCexPrice: number;
  /** Collateral token symbol for logging */
  collateralSymbol: string;
  /** The Coinbase pair to watch */
  cexPair: string;
  /** Seizable collateral amount */
  seizableCollateral: bigint;
  /** Borrow assets amount */
  borrowAssets: bigint;
  /** Market LLTV */
  lltv: bigint;
}

export interface CexPriceEvent {
  pair: string;
  price: number;
  timestamp: number;
}

export interface ThresholdCrossing {
  threshold: LiquidationThreshold;
  currentCexPrice: number;
  /** How far below the trigger (percentage) */
  dropPercent: number;
}

type ThresholdCrossingCallback = (crossings: ThresholdCrossing[]) => void;

export class CexPredictor {
  private ws: InstanceType<typeof WS> | null = null;
  private prices = new Map<string, number>();
  private thresholds: LiquidationThreshold[] = [];
  private onCrossing: ThresholdCrossingCallback;
  private logTag: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;

  constructor(logTag: string, onCrossing: ThresholdCrossingCallback) {
    this.logTag = logTag;
    this.onCrossing = onCrossing;
  }

  /**
   * Update the threshold table with new position data.
   * Called periodically as positions change on-chain.
   */
  updateThresholds(thresholds: LiquidationThreshold[]): void {
    this.thresholds = thresholds;
    console.log(`${this.logTag}CEX Predictor: updated ${thresholds.length} thresholds`);
  }

  /**
   * Start the Coinbase WebSocket connection.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    wsReady
      .then(() => {
        this.connect();
      })
      .catch((e: unknown) => {
        console.error(`${this.logTag}CEX Predictor: failed to load ws module:`, e);
      });
  }

  /**
   * Stop the WebSocket connection.
   */
  stop(): void {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Get current CEX price for a pair */
  getPrice(pair: string): number | undefined {
    return this.prices.get(pair);
  }

  private connect(): void {
    if (!this.isRunning) return;

    console.log(
      `${this.logTag}CEX Predictor: connecting to Coinbase WS (${COINBASE_PAIRS.join(", ")})`,
    );

    this.ws = new WS(COINBASE_WS_URL);

    this.ws.on("open", () => {
      console.log(`${this.logTag}CEX Predictor: Coinbase WS connected`);
      try {
        const healthState = (globalThis as { __healthState?: { cexPredictorConnected?: boolean } })
          .__healthState;
        if (healthState) healthState.cexPredictorConnected = true;
      } catch {
        // Ignore health-state wiring failures.
      }
      // Subscribe to ticker channel for all pairs
      const subscribeMsg = JSON.stringify({
        type: "subscribe",
        product_ids: COINBASE_PAIRS,
        channels: ["ticker"],
      });
      this.ws.send(subscribeMsg);
    });

    this.ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          product_id?: string;
          price?: string;
        };
        // Coinbase ticker format: { type: "ticker", product_id: "BTC-USD", price: "84000.00", ... }
        if (msg.type === "ticker" && msg.product_id && msg.price) {
          const pair = msg.product_id;
          const price = parseFloat(msg.price);
          this.prices.set(pair, price);
          this.checkThresholds(pair, price);
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on("close", () => {
      console.log(`${this.logTag}CEX Predictor: Coinbase WS disconnected`);
      try {
        const healthState = (globalThis as { __healthState?: { cexPredictorConnected?: boolean } })
          .__healthState;
        if (healthState) healthState.cexPredictorConnected = false;
      } catch {
        // Ignore health-state wiring failures.
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error(`${this.logTag}CEX Predictor: WS error: ${err.message}`);
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  private checkThresholds(pair: string, cexPrice: number): void {
    const crossings: ThresholdCrossing[] = [];

    for (const threshold of this.thresholds) {
      if (threshold.cexPair !== pair) continue;

      // Price dropped below liquidation trigger
      if (cexPrice <= threshold.triggerCexPrice) {
        const dropPercent =
          ((threshold.triggerCexPrice - cexPrice) / threshold.triggerCexPrice) * 100;
        crossings.push({ threshold, currentCexPrice: cexPrice, dropPercent });
      }
    }

    if (crossings.length > 0) {
      // Sort by largest drop first (most profitable)
      crossings.sort((a, b) => b.dropPercent - a.dropPercent);
      this.onCrossing(crossings);
    }
  }
}

/**
 * Calculate the CEX price at which a borrower's health factor drops to 1.0
 *
 * Morpho HF formula:
 *   HF = (collateral * oraclePrice * LLTV) / (borrowAssets * WAD)
 *
 * At HF = 1.0:
 *   oraclePrice = (borrowAssets * WAD) / (collateral * LLTV / WAD)
 *
 * Then convert oracle price (36-decimal) to CEX USD price based on
 * the oracle's scale factor and feed configuration.
 */
export function calculateTriggerPrice(
  collateral: bigint,
  borrowAssets: bigint,
  lltv: bigint,
  oracleScaleFactor: bigint,
  collateralDecimals: number,
  loanDecimals: number,
): { triggerOraclePrice: bigint; triggerCexPrice: number } {
  const WAD = 10n ** 18n;

  if (collateral === 0n || lltv === 0n) {
    return { triggerOraclePrice: 0n, triggerCexPrice: 0 };
  }

  // triggerOraclePrice = borrowAssets * WAD / (collateral * LLTV / WAD)
  // Simplified: triggerOraclePrice = borrowAssets * WAD * WAD / (collateral * LLTV)
  const triggerOraclePrice = (borrowAssets * WAD * WAD) / (collateral * lltv);

  // Convert oracle price to CEX USD price
  // Oracle price is in 36-decimal format: price * 10^(36 + loanDecimals - collateralDecimals)
  // CEX price is simple USD float
  // triggerCexPrice = triggerOraclePrice / 10^(36 + loanDecimals - collateralDecimals)
  const decimalShift = 36 + loanDecimals - collateralDecimals;

  // oracleScaleFactor is accepted for future use (e.g. non-standard oracle configurations)
  void oracleScaleFactor;

  const triggerCexPrice = Number(triggerOraclePrice) / 10 ** decimalShift;

  return { triggerOraclePrice, triggerCexPrice };
}
