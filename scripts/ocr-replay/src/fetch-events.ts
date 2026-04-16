import { writeFileSync, mkdirSync } from "node:fs";

import { createPublicClient, http, parseAbiItem, parseAbi } from "viem";
import { base } from "viem/chains";

import { BASE_RPC_URL, FEEDS, REPLAY_DAYS } from "./config.js";
import { AnswerUpdatedEvent, OracleFeed } from "./types.js";

// AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)
const ANSWER_UPDATED_EVENT = parseAbiItem(
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
);

// Chainlink proxy exposes aggregator() pointing to the current OCR2 implementation.
// AnswerUpdated events are emitted by the implementation, not the proxy.
const PROXY_ABI = parseAbi(["function aggregator() view returns (address)"]);

/** Blocks per chunk — stay under drpc.org's 10k eth_getLogs limit. */
const LOGS_CHUNK_BLOCKS = 9_000n;

/** Base L2 average block time (seconds). Used to estimate block from timestamp. */
const BASE_BLOCK_TIME_SEC = 2n;

// ---------------------------------------------------------------------------
// Shared retry utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * Only re-throws immediately on non-transient errors (invalid params, reverts,
 * unsupported range). All other failures are treated as transient.
 *
 * @param fn - The function to attempt.
 * @param maxAttempts - Maximum number of attempts (default 6).
 * @param baseDelayMs - Base delay in milliseconds (default 1000).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 6,
  baseDelayMs = 1_000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = String((e as Error).message ?? "");
      // Re-throw immediately on non-transient errors.
      if (
        msg.includes("ranges over") ||
        msg.includes("invalid argument") ||
        msg.includes("execution reverted") ||
        msg.includes("not supported on freetier")
      ) {
        throw e;
      }
      // All other errors are transient — retry with backoff.
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Resolve actual OCR2 aggregator from Chainlink proxy
// ---------------------------------------------------------------------------

/**
 * Chainlink price feed proxies delegate to an internal OCR2 aggregator.
 * The proxy itself never emits AnswerUpdated — only the current aggregator does.
 *
 * This function calls `aggregator()` on the proxy to get the real address.
 * Note: if Chainlink rotates to a new phase during the 14-day window, older
 * events from the previous aggregator are not captured. Acceptable for replay.
 *
 * @param proxyAddress - The Chainlink proxy address from config.
 * @param client - A viem public client.
 * @returns The current OCR2 aggregator address.
 */
async function resolveAggregator(
  proxyAddress: `0x${string}`,
  client: ReturnType<typeof createPublicClient>,
): Promise<`0x${string}`> {
  return withRetry(() =>
    client.readContract({
      address: proxyAddress,
      abi: PROXY_ABI,
      functionName: "aggregator",
    }),
  );
}

// ---------------------------------------------------------------------------
// Block timestamp cache (per fetch call)
// ---------------------------------------------------------------------------

type BlockCache = Map<bigint, bigint>;

/**
 * Fetch block timestamp with caching to avoid duplicate RPC calls.
 * Many events in the same block (unlikely but possible) share a timestamp.
 */
async function getBlockTimestamp(
  blockNumber: bigint,
  cache: BlockCache,
  client: ReturnType<typeof createPublicClient>,
): Promise<bigint> {
  const cached = cache.get(blockNumber);
  if (cached !== undefined) return cached;
  const blockData = await withRetry(() => client.getBlock({ blockNumber }));
  cache.set(blockNumber, blockData.timestamp);
  return blockData.timestamp;
}

// ---------------------------------------------------------------------------
// Core fetch function
// ---------------------------------------------------------------------------

/**
 * Fetch all AnswerUpdated events for a single Chainlink feed
 * within [fromTimestamp, toTimestamp] (Unix seconds, inclusive).
 *
 * Strategy:
 *  1. Resolve the proxy → actual OCR2 aggregator address.
 *  2. Fetch latest block + timestamp to anchor timestamp → block mapping.
 *  3. Estimate fromBlock/toBlock via linear approximation (padded ±100 blocks).
 *  4. Iterate in 9k-block chunks, fetching logs with strict=true.
 *  5. Resolve each log's block timestamp (cached) and apply strict timestamp filter.
 *
 * @param feed - The oracle feed to query (proxy address in config).
 * @param fromTimestamp - Start of window (Unix seconds, bigint).
 * @param toTimestamp - End of window (Unix seconds, bigint).
 * @returns Array of decoded AnswerUpdatedEvent, sorted by block ascending.
 */
export async function fetchAnswerUpdatedEvents(
  feed: OracleFeed,
  fromTimestamp: bigint,
  toTimestamp: bigint,
): Promise<AnswerUpdatedEvent[]> {
  const client = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });

  // Resolve actual aggregator (Chainlink proxy pattern).
  const actualAggregator = await resolveAggregator(feed.aggregator, client);

  // Anchor: latest block number + timestamp.
  const latestBlockNumber = await withRetry(() => client.getBlockNumber());
  const latestBlockData = await withRetry(() =>
    client.getBlock({ blockNumber: latestBlockNumber }),
  );
  const latestTs = latestBlockData.timestamp;

  // Estimate block numbers from timestamps (linear approximation).
  // Pad by an extra 100 blocks on each side to account for block-time variance.
  const PADDING = 100n;
  const fromBlock = latestBlockNumber - (latestTs - fromTimestamp) / BASE_BLOCK_TIME_SEC - PADDING;
  const safeFromBlock = fromBlock < 0n ? 0n : fromBlock;
  const toBlock = latestBlockNumber - (latestTs - toTimestamp) / BASE_BLOCK_TIME_SEC + PADDING;
  const safeToBlock = toBlock > latestBlockNumber ? latestBlockNumber : toBlock;

  const blockCache: BlockCache = new Map();
  // Seed the cache with the latest block we already fetched.
  blockCache.set(latestBlockNumber, latestTs);

  const events: AnswerUpdatedEvent[] = [];

  for (let chunkStart = safeFromBlock; chunkStart <= safeToBlock; chunkStart += LOGS_CHUNK_BLOCKS) {
    const chunkEnd =
      chunkStart + LOGS_CHUNK_BLOCKS - 1n > safeToBlock
        ? safeToBlock
        : chunkStart + LOGS_CHUNK_BLOCKS - 1n;

    const logs = await withRetry(() =>
      client.getLogs({
        address: actualAggregator,
        event: ANSWER_UPDATED_EVENT,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
        strict: true,
      }),
    );

    for (const log of logs) {
      const blockNum = log.blockNumber;

      // Use updatedAt from the event args as the primary timestamp source.
      // This avoids a getBlock() RPC call per event and matches the oracle's
      // recorded update time. Falls back to getBlock() if updatedAt is 0.
      let blockTs: bigint;
      const updatedAt = log.args.updatedAt ?? 0n;
      if (updatedAt > 0n) {
        blockTs = updatedAt;
        // Also cache so future getBlockTimestamp calls are free.
        blockCache.set(blockNum, blockTs);
      } else {
        blockTs = await getBlockTimestamp(blockNum, blockCache, client);
      }

      // Filter strictly by timestamp (block estimate can over-reach).
      if (blockTs < fromTimestamp || blockTs > toTimestamp) {
        continue;
      }

      const rawPrice = log.args.current;
      const newPriceUsd = Number(rawPrice) / 10 ** feed.decimals;

      events.push({
        block: blockNum,
        txHash: log.transactionHash,
        timestamp: blockTs,
        oracleSymbol: feed.symbol,
        roundId: log.args.roundId,
        newPrice: rawPrice,
        newPriceUsd,
      });
    }

    // Brief pause between chunks to respect public RPC rate limits.
    await sleep(100);
  }

  // Sort ascending by block number.
  events.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  return events;
}

// ---------------------------------------------------------------------------
// CLI entry-point: fetch all 4 feeds × 14 days → output/events.jsonl
// ---------------------------------------------------------------------------

/**
 * Fetch AnswerUpdated events for all configured feeds over REPLAY_DAYS days
 * and persist as JSONL at ./output/events.jsonl (BigInts serialised as strings).
 */
export async function fetchAll14Days(): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const since = now - BigInt(REPLAY_DAYS) * 86_400n;

  mkdirSync("./output", { recursive: true });

  let totalEvents = 0;
  const startTime = Date.now();
  const lines: string[] = [];

  for (const feed of FEEDS) {
    console.log(`Fetching ${feed.symbol} (last ${REPLAY_DAYS} days)...`);
    const feedStart = Date.now();

    const events = await fetchAnswerUpdatedEvents(feed, since, now);

    const elapsedSec = ((Date.now() - feedStart) / 1000).toFixed(1);
    console.log(`  ${events.length} events in ${elapsedSec}s`);
    totalEvents += events.length;

    for (const e of events) {
      lines.push(
        JSON.stringify({
          block: e.block.toString(),
          txHash: e.txHash,
          timestamp: e.timestamp.toString(),
          oracleSymbol: e.oracleSymbol,
          roundId: e.roundId.toString(),
          newPrice: e.newPrice.toString(),
          newPriceUsd: e.newPriceUsd,
        }),
      );
    }

    // Pause between feeds to reduce burst pressure on free RPC.
    await sleep(1_000);
  }

  writeFileSync("./output/events.jsonl", lines.join("\n") + "\n");

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = (totalEvents / Number(totalSec)).toFixed(1);
  console.log(`\nDone. Total: ${totalEvents} events in ${totalSec}s (${rate} events/s)`);
  console.log(`Output: ./output/events.jsonl`);
}

// Allow direct invocation: pnpm tsx src/fetch-events.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchAll14Days().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
