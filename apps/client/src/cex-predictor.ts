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
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  send: (data: string) => void;
  close: () => void;
};
let WS: WSConstructor;
const wsReady = import("ws").then((mod) => {
  WS = mod.default as unknown as WSConstructor;
});

// Coinbase WS (US-accessible, Coinbase blocked from US IPs)
const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";

// Map MorphoChainlinkOracleV2 instance addresses to Coinbase trading pairs.
// Keys MUST be the per-market `oracleAddress` returned by the Morpho Blue API
// (lowercased), NOT the inner Chainlink BASE_FEED_1. Lookup site:
// `index.ts` does `ORACLE_TO_CEX_MAP[item.market.oracleAddress.toLowerCase()]`.
// Verified 2026-05-04 via blue-api.morpho.org GraphQL `markets(uniqueKey_in: ...)`.
// Stable-loan markets only (loan = USDC/USDT) — ratio markets like wrsETH/WETH
// are skipped because their oracle does not reflect a USD price.
export const ORACLE_TO_CEX_MAP: Record<string, { pair: string; symbol: string }> = {
  // === Base (chainId 8453) — verified 2026-05-04 ===
  // cbBTC/USDC (uniqueKey 0x9103c3b4...)
  "0x663becd10dae6c4a3dcd89f1d76c1174199639b9": { pair: "BTC-USD", symbol: "BTC" },
  // WETH/USDC (uniqueKey 0x8793cf30...)
  "0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4": { pair: "ETH-USD", symbol: "ETH" },
  // cbXRP/USDC (uniqueKey 0xd4a903dc...)
  "0x031b2efc8d70042ac8d9f5c793c4149ec4b60fde": { pair: "XRP-USD", symbol: "XRP" },
  // cbADA/USDC (uniqueKey 0xd7520ad1...)
  "0x35d87a743d1f2f7cafb42d855dc1c5df857ce45f": { pair: "ADA-USD", symbol: "ADA" },
  // cbLTC/USDC (uniqueKey 0x9125d0fa...)
  "0x47f961e6653423a77b1ef8fb680ee53bf7d8a00d": { pair: "LTC-USD", symbol: "LTC" },
  // cbETH/USDC primary (uniqueKey 0x1c21c59d...)
  "0xb40d93f44411d8c09ad17d7f88195ef9b05ccd96": { pair: "ETH-USD", symbol: "ETH" },
  // cbETH/USDC alt (uniqueKey 0x0ca10126...)
  "0x97ff9cbd7e77348b2b8ffbb883bf29452ad18295": { pair: "ETH-USD", symbol: "ETH" },

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
      this.ws?.send(subscribeMsg);
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

    this.ws.on("error", (err: unknown) => {
      console.error(
        `${this.logTag}CEX Predictor: WS error: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  const ORACLE_PRICE_SCALE = WAD * WAD;

  if (collateral === 0n || lltv === 0n) {
    return { triggerOraclePrice: 0n, triggerCexPrice: 0 };
  }

  // triggerOraclePrice = borrowAssets * WAD / (collateral * LLTV / WAD)
  // Simplified with Morpho's 1e36 oracle scale: borrowAssets * scale * WAD / (collateral * LLTV)
  // Sanity check: 30,000 USDC borrow, 1 cbBTC collateral, 86% LLTV => triggerCexPrice ~= $34,883.
  const scale = oracleScaleFactor === 0n ? ORACLE_PRICE_SCALE : oracleScaleFactor;
  const triggerOraclePrice = (borrowAssets * scale * WAD) / (collateral * lltv);

  // Convert oracle price to CEX USD price
  // Oracle price is in 36-decimal format: price * 10^(36 + loanDecimals - collateralDecimals)
  // CEX price is simple USD float
  // triggerCexPrice = triggerOraclePrice / 10^(36 + loanDecimals - collateralDecimals)
  const scaleDigits = scale.toString().length - 1;
  const decimalShift = scaleDigits + loanDecimals - collateralDecimals;

  const triggerCexPrice = Number(triggerOraclePrice) / 10 ** decimalShift;

  return { triggerOraclePrice, triggerCexPrice };
}
