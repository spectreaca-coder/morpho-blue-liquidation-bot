/**
 * Flashblock Oracle Watcher — detects Chainlink oracle price updates on Base L2.
 *
 * Monitors Flashblock WebSocket (200ms sub-blocks) for Chainlink OCR transmit
 * transactions. Uses two detection patterns:
 *
 * OCR2: TX with selector 0x6fadcf72 (AuthorizedForwarder.forward) where
 *        calldata bytes 34-74 contain a known aggregator address.
 * OCR1: TX with selector 0xc9807539 (direct transmit) targeting a known aggregator.
 *
 * This replaces the previous approach of monitoring hardcoded transmitter addresses,
 * which was incorrect (those were Chainlink Automation, not price feeds).
 */

import { brotliDecompressSync } from "zlib";

type WSConstructor = new (url: string) => {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  send: (data: string) => void;
  close: () => void;
};
let WS: WSConstructor;
const wsReady = import("ws").then((mod) => {
  WS = mod.default as unknown as WSConstructor;
});

const FLASHBLOCK_WS_URL = "wss://mainnet.flashblocks.base.org/ws";
const ALCHEMY_WS_URL = process.env.WS_URL_8453 || "";

// Chainlink function selectors
const FORWARD_SELECTOR = "6fadcf72"; // AuthorizedForwarder.forward(address,bytes)
const TRANSMIT_SELECTOR = "c9807539"; // OCR1 transmit(bytes,bytes32[],bytes32[],bytes32)

export interface OracleUpdateEvent {
  source?: string;
  /** Aggregator address that was updated (lowercase with 0x prefix) */
  aggregatorAddress: string;
  /** Block number from flashblock metadata */
  blockNumber: number;
  /** Flashblock index within the 2-second block (0-9) */
  flashblockIndex: number;
  /** ISO timestamp when we detected this */
  detectedAt: string;
  /** Raw TX hex for potential price extraction */
  rawTx: string;
  /**
   * Median price extracted from the OCR2 transmit report, in Chainlink's
   * native 8-decimal format (e.g. BTC at $84,000 → 8400000000000n).
   * Undefined if extraction failed or TX is not OCR2 format.
   */
  extractedPrice?: bigint;
}

export type OracleUpdateCallback = (event: OracleUpdateEvent) => void;

export class FlashblockWatcher {
  private ws: InstanceType<typeof WS> | null = null;
  /** Known aggregator addresses (lowercase, without 0x prefix) */
  private aggregators: Set<string>;
  private onOracleUpdate: OracleUpdateCallback;
  private logTag: string;
  private isRunning = false;
  private msgCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private alchemyWs: InstanceType<typeof WS> | null = null;
  private alchemyReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last message from the **primary flashblock WS** only. Heartbeat watches this so
   *  Alchemy traffic cannot mask a dead flashblock stream. */
  private lastFlashblockMessageMs: number = Date.now();
  /** Last message from the Alchemy fallback WS. Kept for observability/debugging. */
  private lastAlchemyMessageMs: number = Date.now();

  constructor(logTag: string, aggregatorAddresses: string[], onOracleUpdate: OracleUpdateCallback) {
    this.logTag = logTag;
    this.aggregators = new Set(aggregatorAddresses.map((a) => a.toLowerCase().replace("0x", "")));
    this.onOracleUpdate = onOracleUpdate;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    wsReady
      .then(() => {
        this.connect();
        this.connectAlchemy();
      })
      .catch((e: unknown) => {
        console.error(`${this.logTag}FlashblockWatcher: failed to load ws:`, e);
      });
  }

  stop(): void {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors during shutdown.
      }
      this.ws = null;
    }
    if (this.alchemyReconnectTimer) {
      clearTimeout(this.alchemyReconnectTimer);
      this.alchemyReconnectTimer = null;
    }
    if (this.alchemyWs) {
      try {
        this.alchemyWs.close();
      } catch {
        // Ignore close errors during shutdown.
      }
      this.alchemyWs = null;
    }
  }

  private connect(): void {
    if (!this.isRunning) return;

    console.log(`${this.logTag}FlashblockWatcher: connecting to ${FLASHBLOCK_WS_URL}`);

    this.ws = new WS(FLASHBLOCK_WS_URL);

    this.ws.on("open", () => {
      console.log(`${this.logTag}FlashblockWatcher: connected`);
      try {
        const healthState = (globalThis as { __healthState?: { flashblockConnected?: boolean } })
          .__healthState;
        if (healthState) healthState.flashblockConnected = true;
      } catch {
        // Ignore health-state wiring failures.
      }
      // Reset on open so a stale timestamp from a previous socket doesn't trigger an immediate kill.
      this.lastFlashblockMessageMs = Date.now();
      // H5: 60s heartbeat — force-reconnect if no flashblock messages arrive for 60s.
      // Zombie WS connections can report "connected" but stop delivering data; this catches them.
      // IMPORTANT: this checks the **primary flashblock WS only**. Alchemy traffic uses its own
      // timestamp so a dead flashblock stream can't be masked by a healthy Alchemy stream.
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
      }
      this.heartbeatTimer = setInterval(() => {
        const gapMs = Date.now() - this.lastFlashblockMessageMs;
        if (gapMs > 60_000) {
          console.warn(
            `${this.logTag}FlashblockWatcher: heartbeat stale (${Math.round(gapMs / 1000)}s) — ` +
              `forcing reconnect`,
          );
          try {
            const healthState = (
              globalThis as { __healthState?: { flashblockConnected?: boolean } }
            ).__healthState;
            if (healthState) healthState.flashblockConnected = false;
          } catch {
            // Ignore health-state wiring failures.
          }
          try {
            this.ws?.close();
          } catch {
            // Ignore forced-close errors during reconnect.
          }
        }
      }, 15_000);
    });

    this.ws.on("message", (data: Buffer, isBinary: boolean) => {
      this.msgCount++;
      this.lastFlashblockMessageMs = Date.now();
      try {
        const json = isBinary ? brotliDecompressSync(data).toString() : data.toString();

        const parsed = JSON.parse(json) as {
          diff?: { transactions?: string[] };
          index?: number;
          metadata?: { block_number?: number };
        };

        const rawTxs = parsed.diff?.transactions ?? [];
        const blockNumber = parsed.metadata?.block_number ?? 0;
        const flashblockIndex = parsed.index ?? 0;

        for (const rawTx of rawTxs) {
          const txLower = rawTx.toLowerCase();
          const aggregator = this.detectOracleUpdate(txLower);
          if (aggregator) {
            // Try OCR2 first; if it returns garbage (outside Chainlink 8-dec range), fall back to OCR1.
            // ADA aggregator wraps OCR1 report inside a forward() call — OCR2 parser reads garbage,
            // preventing the OCR1 fallback from ever running.
            // Sanity bounds: 8-dec USD feeds ($0.01–$10M) + 18-dec exchange rate feeds (0.5–2.0)
            const PRICE_SANITY_MIN = 1_000_000n; // $0.01 in 8-dec
            const PRICE_SANITY_MAX = 2_000_000_000_000_000_000n; // 2.0 in 18-dec (covers wrsETH≈1.069, wstETH≈1.18)
            const ocr2Price = this.extractPriceFromCalldata(txLower);
            const ocr2Ok =
              ocr2Price !== null && ocr2Price >= PRICE_SANITY_MIN && ocr2Price <= PRICE_SANITY_MAX;
            let extractedPrice: bigint | undefined = ocr2Ok ? ocr2Price : undefined;
            if (extractedPrice === undefined) {
              // C2: sanity-check the OCR1 fallback the same way we do OCR2.
              // Without this, a parser glitch on an OCR1 feed leaks garbage into
              // the HF math downstream.
              const ocr1Price = this.extractPriceOCR1(txLower);
              if (
                ocr1Price !== null &&
                ocr1Price >= PRICE_SANITY_MIN &&
                ocr1Price <= PRICE_SANITY_MAX
              ) {
                extractedPrice = ocr1Price;
              }
            }
            if (extractedPrice !== undefined) {
              const source = ocr2Ok ? "OCR2" : "OCR1";
              console.log(
                `${this.logTag}FlashblockWatcher: aggregator ${aggregator.slice(0, 10)}... ` +
                  `extracted ${source} price = ${extractedPrice} (8-dec Chainlink format)`,
              );
            }
            this.onOracleUpdate({
              aggregatorAddress: "0x" + aggregator,
              blockNumber,
              flashblockIndex,
              detectedAt: new Date().toISOString(),
              rawTx,
              extractedPrice,
            });
          }
        }
      } catch (err) {
        if (this.msgCount % 500 === 0) {
          console.warn(
            `${this.logTag}FlashblockWatcher parse error (sample):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    });

    this.ws.on("close", () => {
      console.log(`${this.logTag}FlashblockWatcher: disconnected`);
      try {
        const healthState = (globalThis as { __healthState?: { flashblockConnected?: boolean } })
          .__healthState;
        if (healthState) healthState.flashblockConnected = false;
      } catch {
        // Ignore health-state wiring failures.
      }
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error(`${this.logTag}FlashblockWatcher: error:`, err.message);
      this.ws?.close();
    });
  }

  /**
   * Detect if a raw TX hex string is a Chainlink oracle price update.
   * Returns the aggregator address (without 0x) if detected, null otherwise.
   *
   * Detection strategy:
   *   OCR2: AuthorizedForwarder.forward(address,bytes) — selector 6fadcf72.
   *         The first ABI parameter is the aggregator address, zero-padded to
   *         32 bytes. In hex chars: selector(8) + zero-padding(24) + address(40).
   *         We extract the address from the EXACT ABI position to avoid false
   *         positives caused by the aggregator bytes appearing elsewhere in the TX.
   *
   *   OCR1: Direct transmit(bytes,bytes32[],bytes32[],bytes32) — selector c9807539.
   *         Here the `to` field of the TX is the aggregator. Extracting `to` from
   *         RLP-encoded data is complex, so we keep the substring fallback for OCR1
   *         only (these are far rarer on Base than OCR2).
   */
  private detectOracleUpdate(txHex: string): string | null {
    // Pattern 1: OCR2 via AuthorizedForwarder — precise address extraction
    // ABI layout after the forward() selector:
    //   selector  : 4 bytes  = 8 hex chars
    //   padding   : 12 bytes = 24 hex chars  (zero-pads address to 32 bytes)
    //   address   : 20 bytes = 40 hex chars
    if (txHex.includes(FORWARD_SELECTOR)) {
      const fwdIdx = txHex.indexOf(FORWARD_SELECTOR);
      const addrStart = fwdIdx + 8 + 24; // skip selector(8) + zero-padding(24)
      const addrEnd = addrStart + 40; // 20-byte address = 40 hex chars
      if (addrEnd <= txHex.length) {
        const addr = txHex.slice(addrStart, addrEnd);
        if (this.aggregators.has(addr)) return addr;
      }
    }

    // Pattern 2: OCR1 direct transmit to aggregator (substring fallback — OCR1 only)
    // transmit(bytes,bytes32[],bytes32[],bytes32) — selector 0xc9807539
    if (txHex.includes(TRANSMIT_SELECTOR)) {
      for (const agg of this.aggregators) {
        if (txHex.includes(agg)) return agg;
      }
    }

    return null;
  }

  /**
   * Extract the OCR2 median price observation from a raw TX hex string.
   *
   * Parses the calldata of an AuthorizedForwarder.forward() call that wraps
   * a Chainlink OCR2 transmit() call, extracts the sorted observations array
   * from the embedded report, and returns the median value as a bigint in
   * Chainlink's native 8-decimal format.
   *
   * Calldata layout (all offsets are in bytes from the start of input data,
   * after stripping the leading "0x" and the outer TX envelope):
   *
   *   forward() input data:
   *     [0..3]   selector = 6fadcf72
   *     [4..35]  padded address (target aggregator)
   *     [36..67] bytes offset (= 0x40 = 64, pointing past the two params)
   *     [68..99] bytes length
   *     [100..]  bytes data = transmit() input data:
   *       [0..3]   selector = b1dc65a4
   *       [4..99]  reportContext (3 × 32 bytes)
   *       [100..131] report ABI offset (relative to start of transmit args)
   *       [132..163] rs ABI offset
   *       [164..195] ss ABI offset
   *       [196..227] rawVs (bytes32)
   *       at report offset (from start of transmit args = transmit byte 4):
   *         [+0..+31]  report length (bytes)
   *         [+32..]    report data = abi.encode(bytes32, bytes32, int192, int192[]):
   *           Word 0 (byte  0): rawReporters (last 4 bytes = timestamp)
   *           Word 1 (byte 32): rawObservers (observer indices)
   *           Word 2 (byte 64): observations array offset (0x80 = 128)
   *           Word 3 (byte 96): juelsPerFeeCoin
   *           Word 4 (byte128): N (observations count)
   *           Word 5+ (byte160): N × int192 (32-byte padded, sorted)
   *           median = observations[floor(N/2)]
   *
   * @param txHex - Lowercase raw TX hex string (may include leading "0x" and
   *                RLP envelope; we search for the forward selector within it).
   * @returns Median observation as bigint (8-decimal Chainlink format), or
   *          null if the calldata is absent, too short, or otherwise malformed.
   */
  private extractPriceFromCalldata(txHex: string): bigint | null {
    try {
      // Strip leading "0x" if present and work with plain hex chars (2 per byte)
      const hex = txHex.startsWith("0x") ? txHex.slice(2) : txHex;

      // Locate the forward() selector within the hex string.
      // The selector is 4 bytes = 8 hex chars.
      const fwdIdx = hex.indexOf(FORWARD_SELECTOR);
      if (fwdIdx === -1) return null;

      // Input data starts at the selector position.
      // fwdIdx is in hex chars; each byte = 2 chars.
      const inputStart = fwdIdx; // hex char offset

      // Helper: read 32-byte word at byte offset `byteOff` from inputStart,
      // returning as a bigint.
      const readWord = (byteOff: number): bigint => {
        const charOff = inputStart + byteOff * 2;
        const slice = hex.slice(charOff, charOff + 64);
        if (slice.length < 64) throw new Error("short calldata");
        return BigInt("0x" + slice);
      };

      // forward() input layout (byte offsets from inputStart):
      //   0..3   selector (6fadcf72)
      //   4..35  padded address
      //   36..67 bytes ABI offset (should be 0x40 = 64)
      //   68..99 bytes length
      //   100..  bytes data (transmit calldata)

      // Verify the bytes ABI offset is 0x40 (64), as expected for standard ABI encoding.
      // forward(address, bytes) ABI layout:
      //   bytes 0-3:   selector
      //   bytes 4-35:  padded address (first param)
      //   bytes 36-67: ABI offset for bytes param (second param) — expected = 0x40 = 64
      //   bytes 68-99: length of bytes data
      //   bytes 100+:  bytes data content (transmit calldata)
      // If the offset is something other than 64, the layout differs and we bail safely.
      const bytesAbiOffset = readWord(36); // word at byte 36 (second param = bytes offset)
      if (bytesAbiOffset !== 64n) {
        // Debug: log why extraction failed (temporary)
        console.log(
          `${this.logTag}FlashblockWatcher: price extract debug — ` +
            `fwdIdx=${fwdIdx}, bytesAbiOffset=${bytesAbiOffset} (expected 64), ` +
            `hex around selector: ...${hex.slice(fwdIdx, fwdIdx + 160)}...`,
        );
        return null;
      }

      // transmit() calldata starts at byte 100 from inputStart (4 selector + 32 addr + 32 offset + 32 len).
      const transmitStart = 100; // byte offset from inputStart

      // transmit() input layout (byte offsets from transmitStart):
      //   0..3   selector (b1dc65a4)
      //   4..99  reportContext (3 × 32 bytes)
      //   100..131 report ABI offset (relative to byte 4 of transmit data, i.e. after selector)
      //   ... more offsets follow

      // The report ABI offset is at transmit byte 100 (4 selector + 96 reportContext).
      // It is relative to the start of the ABI-encoded arguments (byte 4 of transmit data).
      const reportAbiOffset = readWord(transmitStart + 100);

      // Absolute byte offset of the report length word within transmit data.
      // The ABI offset is relative to the start of arguments (transmit byte 4).
      const reportLenByteOff = transmitStart + 4 + Number(reportAbiOffset);

      // Read the report length (bytes).
      const reportLen = readWord(reportLenByteOff);
      // Minimum viable report: 1 byte (N) + at least 1 observation (24 bytes) = 25 bytes
      if (reportLen < 25n) return null;

      // Report data starts immediately after the 32-byte length word.
      const reportDataByteOff = reportLenByteOff + 32;

      // -----------------------------------------------------------------------
      // OCR2 Median report is ABI-encoded as:
      //   abi.encode(bytes32 rawReporters, bytes32 rawObservers, int192 juelsPerFeeCoin, int192[] observations)
      //
      // Verified by capturing real Flashblock TXs:
      //   Word 0 (byte  0): rawReporters (last 4 bytes = observationsTimestamp)
      //   Word 1 (byte 32): rawObservers (observer indices, e.g. 08,02,07,00,01,...)
      //   Word 2 (byte 64): observations array offset = 0x80 (128)
      //   Word 3 (byte 96): juelsPerFeeCoin (int192, usually 0)
      //   Word 4 (byte128): N (observations count, e.g. 10)
      //   Word 5+ (byte160): N × int192 values (each padded to 32 bytes, sorted)
      //   Median = observations[floor(N/2)]
      // -----------------------------------------------------------------------

      // Read observations array offset (word 2 of report, at report byte 64)
      const obsArrayOffset = readWord(reportDataByteOff + 64);
      if (obsArrayOffset === 0n || obsArrayOffset > 1024n) return null; // sanity

      // Observations array location: reportDataByteOff + Number(obsArrayOffset)
      const obsArrayByteOff = reportDataByteOff + Number(obsArrayOffset);

      // N (observations count)
      const nWord = readWord(obsArrayByteOff);
      const n = Number(nWord);
      if (n === 0 || n > 255) return null;

      // Validate report length: 4 head words (128) + N*32 observations + length word (32)
      if (reportLen < BigInt(128 + 32 + n * 32)) return null;

      // Median observation: observations[floor(N/2)]
      const medianIdx = Math.floor(n / 2);
      const medianByteOff = obsArrayByteOff + 32 + medianIdx * 32; // +32 skips length word
      const medianWord = readWord(medianByteOff);

      // int192: mask to 192 bits and guard against negative
      const INT192_MAX = (1n << 191n) - 1n;
      const medianValue = medianWord & ((1n << 192n) - 1n);
      if (medianValue > INT192_MAX) return null;

      return medianValue;
    } catch (err) {
      // Log first few failures to diagnose extraction issues
      console.warn(
        `${this.logTag}FlashblockWatcher: price extract failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Extract the median price from an OCR1 transmit() call.
   *
   * OCR1 transmit(bytes _report, bytes32[] _rs, bytes32[] _ss, bytes32 _rawVs)
   * Selector: c9807539
   *
   * The _report bytes contain:
   *   ABI-encoded: offset(32) + length(32) + data
   *   data = observationsTimestamp(4 bytes) + rawObservers(1 byte per observer)
   *          + int192[] observations (each 24 bytes, packed)
   *
   * Simpler approach: the report's first ABI param is a bytes array.
   * After the ABI header, report data starts. We look for the observations
   * by reading the report length and computing N from it.
   */
  private extractPriceOCR1(txHex: string): bigint | null {
    try {
      const hex = txHex.startsWith("0x") ? txHex.slice(2) : txHex;
      const txIdx = hex.indexOf(TRANSMIT_SELECTOR);
      if (txIdx === -1) return null;

      const inputStart = txIdx;

      const readWord = (byteOff: number): bigint => {
        const charOff = inputStart + byteOff * 2;
        const slice = hex.slice(charOff, charOff + 64);
        if (slice.length < 64) throw new Error("short calldata");
        return BigInt("0x" + slice);
      };

      // transmit() ABI layout:
      //   bytes 0-3:    selector (c9807539)
      //   bytes 4-35:   _report offset
      //   bytes 36-67:  _rs offset
      //   bytes 68-99:  _ss offset
      //   bytes 100-131: _rawVs (bytes32)
      const reportOffset = readWord(4); // offset to _report bytes
      const reportLenByteOff = 4 + Number(reportOffset);
      const reportLen = Number(readWord(reportLenByteOff));
      if (reportLen < 1 || reportLen > 10000) return null;

      const reportDataByteOff = reportLenByteOff + 32;

      // OCR1 report format (packed):
      //   4 bytes: observationsTimestamp
      //   variable: rawObservers (length derived from report size)
      //   N × 24 bytes: int192 observations (packed, NOT padded to 32)
      //
      // The number of observations N can be inferred:
      //   reportLen = 4 (timestamp) + N (observer indices, 1 byte each) + N × 24 (observations)
      //   reportLen = 4 + N + 24N = 4 + 25N
      //   N = (reportLen - 4) / 25
      const n = Math.floor((reportLen - 4) / 25);
      if (n <= 0 || n > 255) return null;

      // Observations start at: reportData + 4 (timestamp) + N (observer bytes)
      const obsStartByteOff = reportDataByteOff + 4 + n;

      // Each observation is 24 bytes (int192, packed, no padding)
      const medianIdx = Math.floor(n / 2);
      const medianCharOff = inputStart + obsStartByteOff * 2 + medianIdx * 48; // 24 bytes = 48 hex chars
      const medianHex = hex.slice(medianCharOff, medianCharOff + 48);
      if (medianHex.length < 48) return null;

      const medianValue = BigInt("0x" + medianHex);
      const INT192_MAX = (1n << 191n) - 1n;
      if (medianValue > INT192_MAX) return null;

      return medianValue;
    } catch {
      return null;
    }
  }

  private connectAlchemy(): void {
    if (!this.isRunning || !ALCHEMY_WS_URL) return;
    const aggregatorAddrs = Array.from(this.aggregators).map((a) => "0x" + a);
    console.log(`${this.logTag}AlchemyWatcher: connecting (${aggregatorAddrs.length} aggregators)`);
    this.alchemyWs = new WS(ALCHEMY_WS_URL);
    this.alchemyWs.on("open", () => {
      console.log(`${this.logTag}AlchemyWatcher: connected`);
      const sub = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["alchemy_pendingTransactions", { toAddress: aggregatorAddrs, hashesOnly: false }],
      });
      this.alchemyWs!.send(sub);
    });
    this.alchemyWs.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1 && msg.result) {
          console.log(`${this.logTag}AlchemyWatcher: subscribed`);
          return;
        }
        const tx = msg.params?.result;
        if (!tx?.input || !tx?.to) return;
        const aggAddr = tx.to.toLowerCase().replace("0x", "");
        if (!this.aggregators.has(aggAddr)) return;
        const detected = this.detectOracleUpdate(tx.input);
        if (!detected) return;
        this.onOracleUpdate({
          aggregatorAddress: ("0x" + detected) as `0x${string}`,
          blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : 0,
          flashblockIndex: 0,
          detectedAt: new Date().toISOString(),
          rawTx: tx.input,
          extractedPrice: undefined,
        });
        // Do NOT touch lastFlashblockMessageMs here — a healthy Alchemy stream must not
        // mask a dead primary flashblock stream from the heartbeat.
        this.lastAlchemyMessageMs = Date.now();
      } catch {
        // Ignore malformed Alchemy messages.
      }
    });
    this.alchemyWs.on("close", () => {
      console.log(`${this.logTag}AlchemyWatcher: disconnected`);
      if (!this.isRunning || this.alchemyReconnectTimer) return;
      this.alchemyReconnectTimer = setTimeout(() => {
        this.alchemyReconnectTimer = null;
        this.connectAlchemy();
      }, 5000);
    });
    this.alchemyWs.on("error", (err: Error) => {
      console.error(`${this.logTag}AlchemyWatcher: error`, err.message);
      this.alchemyWs?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

/**
 * Known Chainlink aggregator addresses for Base Morpho markets.
 * These are the actual OCR2/OCR1 aggregator contracts that receive
 * transmit() calls and emit AnswerUpdated events.
 */
export const BASE_AGGREGATORS = [
  "0x0e3dc8a6a86d2f6f5f67b373a047c267fb1fc3e6", // BTC/USD (OCR2)
  "0x1e0b2c3896338fbb201c4f0a27c6904801dca06b", // ETH/USD (OCR2)
  "0x0ee7145e1370653533e2f2e824424be2aa95a4aa", // USDC/USD (OCR1)
  "0x51ce3091cf646587e02cad83b580992f8723e718", // CBBTC/USD (OCR2)
  "0x92a7c3a57e17aff701c159c5480073b095100b62", // XRP/USD (OCR2) — cbXRP/USDC market (29% of liquidations)
  "0x91e936921df850cc8714527ebe6c45ecbd2cad31", // ADA/USD (OCR2) — cbADA/USDC market
  "0x5bf848b4ef13bd590ea41ad664ff45b155d1c582", // LTC/USD (OCR2) — cbLTC/USDC market
  "0x925861a08cc74d210a8691593f1c2aefebf2d10e", // wrsETH/ETH exchange rate (OCR1) - wrsETH/WETH market (most active)
  "0x1e536d8f053feab16c65861b7a3462b5b5acd3a2", // wstETH/stETH exchange rate (OCR1) - wstETH/WETH market (100 at-risk)
  "0x53fdcab0650570d07e2770004979ef10a86df559", // cbETH/ETH exchange rate (OCR2) - cbETH/USDC market ($2.9K/30d)
];
