/**
 * orchestrator.ts
 *
 * Sprint 5 — Pipeline runner for the 14-day OCR backrun replay.
 *
 * Flow:
 *   1. Load events from output/events.jsonl
 *   2. Resume from output/replay_partial.jsonl if it exists (skip processed events)
 *   3. For each event, find matching pool(s) by feedSymbol == oracleSymbol
 *   4. Read pool state at event.block - 1n (state BEFORE oracle update)
 *   5. Read block baseFeePerGas and ETH/USD price at event.block (cached per block)
 *   6. computeProfit() → ProfitRow
 *   7. Checkpoint every 100 events to output/replay_partial.jsonl
 *   8. Write output/replay_raw.csv and output/replay_summary.json
 *
 * Performance:
 *   - Concurrency = 20 (drpc.org safe limit; falls back to 10 on rate limit)
 *   - Per-block cache for baseFee + ETH price
 *   - Progress log every 100 events with rate + ETA
 *
 * ETH/USD price source: latestAnswer() on the ETH/USD Chainlink aggregator at
 * the specific block. We use a separate historical read rather than the
 * AnswerUpdated event because some replay events ARE the ETH/USD oracle update
 * — we need the price AT that block, not the new price being set.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

import { BASE_RPC_URL, FEEDS, POOLS, REPLAY_DAYS } from "./config.js";
import { readPoolState } from "./pool-state.js";
import { computeProfit } from "./profit-calc.js";
import type { AnswerUpdatedEvent, PoolState, ProfitRow } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Target parallel concurrency.
 * drpc.org free tier handles ~5 archive eth_call/s reliably.
 * Each event triggers 2 pool × (slot0 + liquidity) + block + ETH price = ~6-10 calls.
 * Concurrency=5 → ~30-50 calls/s (safe for drpc archive).
 */
const CONCURRENCY = 5;

/** Checkpoint interval (events processed). */
const CHECKPOINT_EVERY = 100;

/** Output directory (relative to cwd where the script is run). */
const OUTPUT_DIR = "./output";

/** Path to the pre-fetched events. */
const EVENTS_PATH = `${OUTPUT_DIR}/events.jsonl`;

/** Checkpoint path for resume support. */
const PARTIAL_PATH = `${OUTPUT_DIR}/replay_partial.jsonl`;

/** Final CSV output. */
const RAW_CSV_PATH = `${OUTPUT_DIR}/replay_raw.csv`;

/** Final summary JSON. */
const SUMMARY_PATH = `${OUTPUT_DIR}/replay_summary.json`;

// ─── ETH/USD aggregator latestAnswer ABI ─────────────────────────────────────

/**
 * latestAnswer() on the Chainlink aggregator returns the raw int256 price
 * without any round data. We call it at a specific historical block to get
 * the ETH/USD price at that exact point in time.
 */
const LATEST_ANSWER_ABI = parseAbi(["function latestAnswer() view returns (int256)"]);

/** ETH/USD Chainlink aggregator address on Base (from config FEEDS). */
const ETH_USD_FEED = FEEDS.find((f) => f.symbol === "ETH/USD");
if (!ETH_USD_FEED) {
  throw new Error("ETH/USD feed not found in config");
}
const ETH_USD_AGGREGATOR = ETH_USD_FEED.aggregator;
const ETH_USD_DECIMALS = ETH_USD_FEED.decimals;

// ─── Viem client ─────────────────────────────────────────────────────────────

type PublicClientType = ReturnType<typeof createPublicClient>;

function createClient(rpcUrl: string): PublicClientType {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 30_000 }),
  });
}

// ─── Local retry with generous backoff for archive RPC rate limits ────────────

/**
 * Retry an async function with exponential backoff, treating ALL errors as
 * transient (including "Too many request" rate-limit responses from drpc.org).
 *
 * More generous than fetch-events.ts withRetry — 10 attempts, up to 32s backoff.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 10,
  baseDelayMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff capped at 32s: 500ms, 1s, 2s, 4s, 8s, 16s, 32s...
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 32_000);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = String((e as Error).message ?? "");
      // Immediately abort on protocol errors (not transient).
      if (msg.includes("execution reverted") || msg.includes("invalid argument")) {
        throw e;
      }
      // All other errors (rate limit, timeout, network) are retried.
    }
  }
  throw lastError;
}

// ─── Per-block cache ──────────────────────────────────────────────────────────

/** Cache: blockNumber → { baseFeeWei, ethPriceUsd } */
interface BlockMeta {
  baseFeeWei: bigint;
  ethPriceUsd: number;
}

const blockMetaCache = new Map<bigint, BlockMeta>();

/**
 * Fetch (and cache) baseFeePerGas + ETH/USD price for a given block.
 *
 * Uses retryWithBackoff for resilient RPC calls (handles drpc rate limits).
 */
async function getBlockMeta(block: bigint, client: PublicClientType): Promise<BlockMeta> {
  const cached = blockMetaCache.get(block);
  if (cached !== undefined) return cached;

  // Fetch block header and ETH price sequentially to reduce burst pressure.
  const blockData = await retryWithBackoff(() => client.getBlock({ blockNumber: block }));
  const rawEthPrice = await retryWithBackoff(() =>
    client.readContract({
      address: ETH_USD_AGGREGATOR,
      abi: LATEST_ANSWER_ABI,
      functionName: "latestAnswer",
      blockNumber: block,
    }),
  );

  const baseFeeWei = blockData.baseFeePerGas ?? 0n;
  const ethPriceUsd = Number(rawEthPrice) / Math.pow(10, ETH_USD_DECIMALS);

  const meta: BlockMeta = { baseFeeWei, ethPriceUsd };
  blockMetaCache.set(block, meta);
  return meta;
}

// ─── Event loading ────────────────────────────────────────────────────────────

/**
 * Parse a single JSONL line back to AnswerUpdatedEvent.
 * BigInt fields are serialised as strings in the JSONL file.
 */
function parseEventLine(line: string): AnswerUpdatedEvent {
  const raw = JSON.parse(line) as {
    block: string;
    txHash: `0x${string}`;
    timestamp: string;
    oracleSymbol: string;
    roundId: string;
    newPrice: string;
    newPriceUsd: number;
  };

  return {
    block: BigInt(raw.block),
    txHash: raw.txHash,
    timestamp: BigInt(raw.timestamp),
    oracleSymbol: raw.oracleSymbol,
    roundId: BigInt(raw.roundId),
    newPrice: BigInt(raw.newPrice),
    newPriceUsd: raw.newPriceUsd,
  };
}

/**
 * Load all events from events.jsonl in order.
 */
async function loadEvents(): Promise<AnswerUpdatedEvent[]> {
  if (!existsSync(EVENTS_PATH)) {
    throw new Error(`Events file not found: ${EVENTS_PATH}\nRun fetch-events.ts first.`);
  }

  const events: AnswerUpdatedEvent[] = [];
  const rl = createInterface({
    input: createReadStream(EVENTS_PATH),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      events.push(parseEventLine(line));
    }
  }

  return events;
}

// ─── Checkpoint / resume ──────────────────────────────────────────────────────

interface SerializedRow {
  block: string;
  txHash: string;
  timestamp: string;
  oracleSymbol: string;
  roundId: string;
  newPrice: string;
  newPriceUsd: number;
  poolSymbol: string;
  stateBlock: string;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  impliedPrice: number;
  deviationBps: number;
  deviationBpsSigned?: number;
  swapAmountUsd: number;
  gross: number;
  flashloanFee: number;
  dexFee: number;
  gasUsd: number;
  netConservative: number;
  netOptimistic: number;
}

function serializeRow(row: ProfitRow): SerializedRow {
  return {
    block: row.event.block.toString(),
    txHash: row.event.txHash,
    timestamp: row.event.timestamp.toString(),
    oracleSymbol: row.event.oracleSymbol,
    roundId: row.event.roundId.toString(),
    newPrice: row.event.newPrice.toString(),
    newPriceUsd: row.event.newPriceUsd,
    poolSymbol: row.pool.symbol,
    stateBlock: row.stateBefore.block.toString(),
    sqrtPriceX96: row.stateBefore.sqrtPriceX96.toString(),
    tick: row.stateBefore.tick,
    liquidity: row.stateBefore.liquidity.toString(),
    impliedPrice: row.stateBefore.impliedPrice,
    deviationBps: row.deviationBps,
    deviationBpsSigned: row.deviationBpsSigned,
    swapAmountUsd: row.swapAmountUsd,
    gross: row.gross,
    flashloanFee: row.flashloanFee,
    dexFee: row.dexFee,
    gasUsd: row.gasUsd,
    netConservative: row.netConservative,
    netOptimistic: row.netOptimistic,
  };
}

function deserializeRow(s: SerializedRow): ProfitRow {
  const poolConfig = POOLS.find((p) => p.symbol === s.poolSymbol);
  if (!poolConfig) {
    throw new Error(`Unknown pool symbol in partial: ${s.poolSymbol}`);
  }
  return {
    event: {
      block: BigInt(s.block),
      txHash: s.txHash as `0x${string}`,
      timestamp: BigInt(s.timestamp),
      oracleSymbol: s.oracleSymbol,
      roundId: BigInt(s.roundId),
      newPrice: BigInt(s.newPrice),
      newPriceUsd: s.newPriceUsd,
    },
    pool: poolConfig,
    stateBefore: {
      block: BigInt(s.stateBlock),
      sqrtPriceX96: BigInt(s.sqrtPriceX96),
      tick: s.tick,
      liquidity: BigInt(s.liquidity),
      impliedPrice: s.impliedPrice,
    },
    deviationBps: s.deviationBps,
    // Legacy checkpoint files may not have deviationBpsSigned; default 0.
    deviationBpsSigned: s.deviationBpsSigned ?? 0,
    swapAmountUsd: s.swapAmountUsd,
    gross: s.gross,
    flashloanFee: s.flashloanFee,
    dexFee: s.dexFee,
    gasUsd: s.gasUsd,
    netConservative: s.netConservative,
    netOptimistic: s.netOptimistic,
  };
}

interface PartialCheckpoint {
  processedCount: number;
  rows: ProfitRow[];
}

/**
 * Load already-processed rows from replay_partial.jsonl.
 * Returns the count of processed events and the accumulated ProfitRows.
 */
async function loadPartial(): Promise<PartialCheckpoint> {
  if (!existsSync(PARTIAL_PATH)) {
    return { processedCount: 0, rows: [] };
  }

  const rows: ProfitRow[] = [];
  let maxEventIndex = -1;

  const rl = createInterface({
    input: createReadStream(PARTIAL_PATH),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { eventIndex: number; row: SerializedRow };
      if (obj.eventIndex > maxEventIndex) maxEventIndex = obj.eventIndex;
      rows.push(deserializeRow(obj.row));
    } catch {
      // Corrupt last line from interrupted write — skip silently.
    }
  }

  return { processedCount: maxEventIndex + 1, rows };
}

// ─── CSV serialization ────────────────────────────────────────────────────────

// NOTE: appended deviationBpsSigned at the end to preserve column indices for
// existing readers (competition.ts / report.ts parse by index). Finding 2 fix.
const CSV_HEADER =
  "block,txHash,oracle,pool,deviationBps,swapUsd,gross,dexFee,gasUsd,netConservative,netOptimistic,deviationBpsSigned";

function rowToCsv(row: ProfitRow): string {
  const e = row.event;
  const p = row.pool;
  return [
    e.block.toString(),
    e.txHash,
    e.oracleSymbol,
    p.symbol,
    row.deviationBps.toFixed(2),
    row.swapAmountUsd.toFixed(4),
    row.gross.toFixed(4),
    row.dexFee.toFixed(4),
    row.gasUsd.toFixed(4),
    row.netConservative.toFixed(4),
    row.netOptimistic.toFixed(4),
    row.deviationBpsSigned.toFixed(2),
  ].join(",");
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

/**
 * Run async tasks with limited concurrency.
 *
 * @param tasks - Array of async factory functions (each returns T)
 * @param concurrency - Maximum parallel workers
 * @param onComplete - Callback after each task completes (result, originalIndex)
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onComplete: (result: T, index: number) => void,
): Promise<void> {
  let taskIndex = 0;

  async function worker(): Promise<void> {
    while (taskIndex < tasks.length) {
      const currentIndex = taskIndex++;
      const result = await tasks[currentIndex]();
      onComplete(result, currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  if (workerCount === 0) return;

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// ─── Single event processor ───────────────────────────────────────────────────

/**
 * Process one AnswerUpdatedEvent:
 *   1. Find matching pools (feedSymbol == oracleSymbol)
 *   2. Read pool state at event.block - 1n (state BEFORE oracle update)
 *   3. Get block meta (baseFee + ETH price)
 *   4. computeProfit() for each matching pool
 *
 * Returns an array of ProfitRows (one per matching pool, typically 1-2).
 */
async function processEvent(
  event: AnswerUpdatedEvent,
  client: PublicClientType,
): Promise<ProfitRow[]> {
  const matchingPools = POOLS.filter((p) => p.feedSymbol === event.oracleSymbol);
  if (matchingPools.length === 0) return [];

  // State is read at the block BEFORE the oracle update (arb opportunity window).
  const stateBlock = event.block - 1n;

  // Fetch block meta first (sequentially to reduce burst pressure).
  const meta = await getBlockMeta(event.block, client);

  // Then fetch pool states sequentially (each pool = 2 eth_call).
  const rows: ProfitRow[] = [];
  for (const pool of matchingPools) {
    let state: PoolState | null = null;
    try {
      state = await retryWithBackoff(() => readPoolState(pool, stateBlock, client));
    } catch (e: unknown) {
      // After exhausting retries, log a warning and skip this pool/event pair.
      const shortMsg = String((e as Error).message ?? "")
        .split("\n")[0]
        .slice(0, 120);
      console.warn(
        `[WARN] readPoolState failed after retries: ${pool.symbol} block ${stateBlock}: ${shortMsg}`,
      );
    }
    if (state !== null) {
      rows.push(computeProfit(event, pool, state, meta.baseFeeWei, meta.ethPriceUsd));
    }
  }

  return rows;
}

// ─── Summary computation ──────────────────────────────────────────────────────

interface BucketStats {
  rows: number;
  profitable: number;
  totalNetConservative: number;
  totalNetOptimistic: number;
}

interface ReplaySummary {
  totalEvents: number;
  totalRows: number;
  profitableRows: number;
  totalNetConservative: number;
  totalNetOptimistic: number;
  dailyConservative: number;
  dailyOptimistic: number;
  byOracle: Record<string, BucketStats>;
  byPool: Record<string, BucketStats>;
}

function computeSummary(rows: ProfitRow[], totalEvents: number): ReplaySummary {
  const byOracle: Record<string, BucketStats> = {};
  const byPool: Record<string, BucketStats> = {};

  let profitableRows = 0;
  let totalNetConservative = 0;
  let totalNetOptimistic = 0;

  for (const row of rows) {
    const oKey = row.event.oracleSymbol;
    const pKey = row.pool.symbol;

    if (!byOracle[oKey]) {
      byOracle[oKey] = { rows: 0, profitable: 0, totalNetConservative: 0, totalNetOptimistic: 0 };
    }
    if (!byPool[pKey]) {
      byPool[pKey] = { rows: 0, profitable: 0, totalNetConservative: 0, totalNetOptimistic: 0 };
    }

    byOracle[oKey].rows++;
    byPool[pKey].rows++;

    // Only count positive profit contributions (floor at 0 per row).
    const clamped = Math.max(0, row.netConservative);
    const clampedOpt = Math.max(0, row.netOptimistic);

    totalNetConservative += clamped;
    totalNetOptimistic += clampedOpt;

    byOracle[oKey].totalNetConservative += clamped;
    byOracle[oKey].totalNetOptimistic += clampedOpt;
    byPool[pKey].totalNetConservative += clamped;
    byPool[pKey].totalNetOptimistic += clampedOpt;

    if (row.netConservative > 0) {
      profitableRows++;
      byOracle[oKey].profitable++;
      byPool[pKey].profitable++;
    }
  }

  return {
    totalEvents,
    totalRows: rows.length,
    profitableRows,
    totalNetConservative,
    totalNetOptimistic,
    dailyConservative: totalNetConservative / REPLAY_DAYS,
    dailyOptimistic: totalNetOptimistic / REPLAY_DAYS,
    byOracle,
    byPool,
  };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wallClockStart = Date.now();

  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("=== OCR Backrun Replay — Sprint 5 Orchestrator ===");
  console.log(`RPC: ${BASE_RPC_URL}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Events file: ${EVENTS_PATH}`);

  // 1. Load all events.
  console.log("\n[1/5] Loading events...");
  const allEvents = await loadEvents();
  console.log(`  Loaded ${allEvents.length} events.`);

  // 2. Resume support: load partial checkpoint.
  console.log("[2/5] Checking for partial checkpoint...");
  const { processedCount, rows: partialRows } = await loadPartial();
  const allRows: ProfitRow[] = [...partialRows];
  const startIndex = processedCount;

  if (startIndex > 0) {
    console.log(
      `  Resuming from event ${startIndex} (${partialRows.length} rows already computed).`,
    );
  } else {
    console.log("  No checkpoint found, starting from scratch.");
  }

  // Open partial file for append (or create fresh).
  const partialStream = createWriteStream(PARTIAL_PATH, {
    flags: startIndex > 0 ? "a" : "w",
  });

  // 3. Build task list for remaining events.
  const remainingEvents = allEvents.slice(startIndex);
  console.log(`[3/5] Processing ${remainingEvents.length} remaining events...`);

  const client = createClient(BASE_RPC_URL);

  let doneCount = 0;
  let lastLogAt = 0;
  const progressStart = Date.now();

  // Build tasks array: each task processes one event and returns its rows.
  const tasks = remainingEvents.map((event, relIdx) => async (): Promise<ProfitRow[]> => {
    const absoluteIndex = startIndex + relIdx;

    try {
      return await processEvent(event, client);
    } catch (e) {
      const msg = String((e as Error).message ?? "");

      if (
        msg.includes("rate") ||
        msg.includes("429") ||
        msg.includes("too many") ||
        msg.includes("limit exceeded")
      ) {
        // Rate limit — wait 5 seconds and retry once.
        console.warn(`[RATE-LIMIT] event ${absoluteIndex}, waiting 5s...`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        return processEvent(event, client);
      }

      // Other errors — log and continue (don't crash the pipeline).
      console.error(
        `[ERROR] event ${absoluteIndex} (${event.oracleSymbol} block ${event.block}): ${msg}`,
      );
      return [];
    }
  });

  // Run with concurrency limit.
  await runWithConcurrency(tasks, CONCURRENCY, (rows, relIdx) => {
    const absoluteIndex = startIndex + relIdx;

    for (const row of rows) {
      allRows.push(row);
      partialStream.write(
        JSON.stringify({ eventIndex: absoluteIndex, row: serializeRow(row) }) + "\n",
      );
    }

    doneCount++;

    // Progress log every CHECKPOINT_EVERY events.
    if (doneCount - lastLogAt >= CHECKPOINT_EVERY || doneCount === remainingEvents.length) {
      lastLogAt = doneCount;
      const elapsedSec = (Date.now() - progressStart) / 1000;
      const rate = doneCount / Math.max(elapsedSec, 0.001);
      const remaining = remainingEvents.length - doneCount;
      const etaMin = remaining / rate / 60;
      const totalDone = startIndex + doneCount;

      console.log(
        `  [progress] ${totalDone}/${allEvents.length} events | ` +
          `${rate.toFixed(1)} ev/s | ETA ~${etaMin.toFixed(1)} min | ` +
          `rows so far: ${allRows.length}`,
      );
    }
  });

  // Flush and close the partial stream.
  await new Promise<void>((resolve, reject) => {
    partialStream.end((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });

  console.log(`\n[4/5] Writing output files...`);

  // 4. Write replay_raw.csv.
  const csvLines = [CSV_HEADER, ...allRows.map(rowToCsv)];
  writeFileSync(RAW_CSV_PATH, csvLines.join("\n") + "\n");
  console.log(`  Wrote ${allRows.length} rows to ${RAW_CSV_PATH}`);

  // 5. Compute and write replay_summary.json.
  const summary = computeSummary(allRows, allEvents.length);
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");
  console.log(`  Wrote ${SUMMARY_PATH}`);

  // ─── Final report ────────────────────────────────────────────────────────────

  const wallClockSec = ((Date.now() - wallClockStart) / 1000).toFixed(1);

  console.log("\n=== REPLAY COMPLETE ===");
  console.log(`Wall clock: ${wallClockSec}s`);
  console.log(`Total events: ${summary.totalEvents}`);
  console.log(`Total rows: ${summary.totalRows}`);
  console.log(`Profitable rows: ${summary.profitableRows}`);
  console.log(`\n--- DAILY ESTIMATES (${REPLAY_DAYS}d window) ---`);
  console.log(`  Conservative (×0.3): $${summary.dailyConservative.toFixed(2)}/day`);
  console.log(`  Optimistic   (×0.6): $${summary.dailyOptimistic.toFixed(2)}/day`);

  console.log("\n--- By Oracle ---");
  for (const [oracle, stats] of Object.entries(summary.byOracle)) {
    console.log(
      `  ${oracle}: ${stats.rows} rows, ${stats.profitable} profitable, ` +
        `cons=$${stats.totalNetConservative.toFixed(2)}, ` +
        `opt=$${stats.totalNetOptimistic.toFixed(2)}`,
    );
  }

  console.log("\n--- By Pool ---");
  for (const [pool, stats] of Object.entries(summary.byPool)) {
    console.log(
      `  ${pool}: ${stats.rows} rows, ${stats.profitable} profitable, ` +
        `cons=$${stats.totalNetConservative.toFixed(2)}, ` +
        `opt=$${stats.totalNetOptimistic.toFixed(2)}`,
    );
  }

  // Top-5 profitable rows by netConservative.
  const top5 = [...allRows]
    .filter((r) => r.netConservative > 0)
    .sort((a, b) => b.netConservative - a.netConservative)
    .slice(0, 5);

  if (top5.length > 0) {
    console.log("\n--- Top 5 Rows (by netConservative) ---");
    for (const row of top5) {
      console.log(
        `  block=${row.event.block} oracle=${row.event.oracleSymbol} ` +
          `pool=${row.pool.symbol} devBps=${row.deviationBps.toFixed(2)} ` +
          `netCons=$${row.netConservative.toFixed(4)}`,
      );
    }
  }

  // Verdict.
  console.log(`\nVERDICT:`);
  if (summary.dailyConservative >= 30) {
    console.log(`  GO — Conservative $/day ($${summary.dailyConservative.toFixed(2)}) >= $30`);
  } else if (summary.dailyConservative >= 10) {
    console.log(
      `  MARGINAL — Conservative $/day ($${summary.dailyConservative.toFixed(2)}) ` +
        `is $10-$30. Inspect distribution.`,
    );
  } else {
    console.log(
      `  DEAD — Conservative $/day ($${summary.dailyConservative.toFixed(2)}) < $10. Pivot.`,
    );
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch((e: unknown) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
