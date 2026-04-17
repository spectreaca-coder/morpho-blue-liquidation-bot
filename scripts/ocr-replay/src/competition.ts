/**
 * competition.ts
 *
 * Sprint 6.5 — Competition Analyzer for OCR Backrun Replay
 *
 * For the TOP 50 most profitable rows from replay_raw.csv (sorted by
 * netConservative desc), queries eth_getLogs for Swap events on those pools
 * in blocks [N, N+1, N+2] (where N = oracle block), decodes direction, and
 * determines whether a competitor captured the opportunity before we could.
 *
 * Outputs:
 *   output/competition_summary.json
 *   output/competition_top50.csv
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { base } from "viem/chains";

import { POOLS } from "./config.js";
import type { PoolConfig } from "./types.js";

// ─── RPC ─────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.BASE_ARCHIVE_RPC_URL;
if (!RPC_URL) {
  throw new Error(
    "BASE_ARCHIVE_RPC_URL is required. Set it in .env before running the competition analyzer.",
  );
}

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { timeout: 30_000 }),
});

// ─── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_DIR = "./output";
const RAW_CSV_PATH = `${OUTPUT_DIR}/replay_raw.csv`;
const COMPETITION_SUMMARY_PATH = `${OUTPUT_DIR}/competition_summary.json`;
const COMPETITION_TOP50_PATH = `${OUTPUT_DIR}/competition_top50.csv`;

/** How many top rows to analyze. */
const TOP_N = 50;

/** Blocks after oracle event to search for competitor Swap events. */
const SEARCH_WINDOW = 2; // N, N+1, N+2

/** Concurrency cap for getLogs calls. */
const CONCURRENCY = 10;

/**
 * Known 14-day total conservative profit from replay_summary.json.
 * Used to estimate realistic daily capture rate.
 */
const FULL_14D_CONSERVATIVE = 252.5095519787269;
const REPLAY_DAYS = 14;

// ─── Swap event ABI (identical for UniV3 + Aerodrome CL) ─────────────────────

const SWAP_ABI = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvRow {
  block: bigint;
  txHash: string;
  oracle: string;
  pool: string;
  deviationBps: number;
  /** Signed deviation bps (Finding 2). 0 when reading legacy CSV without this column. */
  deviationBpsSigned: number;
  netConservative: number;
  netOptimistic: number;
}

interface CompetitorSwap {
  txHash: string;
  sender: string;
  /** true = amount0 > 0 (sender sent token0, received token1) */
  token0In: boolean;
  tipWei: bigint;
  blockNumber: bigint;
}

interface AnalyzedRow {
  block: bigint;
  oracle: string;
  pool: string;
  devBps: number;
  netCons: number;
  hasCompetitor: boolean;
  competitorAddr: string;
  competitorTipGwei: number;
  /** True if no Swap event found at all in the window. */
  noSwapAtAll: boolean;
  arbDirectionToken0In: boolean;
}

interface CompetitionSummary {
  topRowsAnalyzed: number;
  rowsWithCompetitorSwap: number;
  captureRate: number;
  competitors: Record<string, { wins: number; avgTipGwei: number }>;
  missedOpportunities: number;
  ourRealisticEdge: string;
}

// ─── CSV loader ───────────────────────────────────────────────────────────────

async function loadTop50(): Promise<CsvRow[]> {
  if (!existsSync(RAW_CSV_PATH)) {
    throw new Error(`replay_raw.csv not found at ${RAW_CSV_PATH}. Run orchestrator.ts first.`);
  }

  const rows: CsvRow[] = [];

  const rl = createInterface({
    input: createReadStream(RAW_CSV_PATH),
    crlfDelay: Infinity,
  });

  let firstLine = true;
  for await (const line of rl) {
    if (firstLine) {
      firstLine = false;
      continue; // Skip header.
    }
    if (!line.trim()) continue;

    const parts = line.split(",");
    if (parts.length < 11) continue;

    const netConservative = parseFloat(parts[9]);
    // Only include rows that are actually profitable.
    if (netConservative <= 0) continue;

    // Column 11 (deviationBpsSigned) was appended in the Finding 2 fix. Older
    // CSVs without this column fall back to 0 → behavior matches pre-fix
    // (constant per-pool arbDir via getArbDirectionToken0In).
    const deviationBpsSigned = parts.length >= 12 ? parseFloat(parts[11]) : 0;

    rows.push({
      block: BigInt(parts[0]),
      txHash: parts[1],
      oracle: parts[2],
      pool: parts[3],
      deviationBps: parseFloat(parts[4]),
      deviationBpsSigned,
      netConservative,
      netOptimistic: parseFloat(parts[10]),
    });
  }

  // Sort descending by netConservative and take top N.
  rows.sort((a, b) => b.netConservative - a.netConservative);
  return rows.slice(0, TOP_N);
}

// ─── Pool config lookup ───────────────────────────────────────────────────────

function findPool(poolSymbol: string): PoolConfig | undefined {
  return POOLS.find((p) => p.symbol === poolSymbol);
}

// ─── Arb direction ────────────────────────────────────────────────────────────

/**
 * Determine whether the theoretical arb involves sending token0 INTO the pool.
 *
 * For pools where quoteIsToken0=false (e.g., WETH/USDC where oracle gives USD per ETH):
 *   Oracle price rise (ETH/USD up) means pool lags behind — pool WETH is cheap.
 *   Arb: send WETH (token0) to pool, receive USDC (token1) → amount0 > 0 → token0In=true.
 *
 * For pools where quoteIsToken0=true (e.g., USDC/cbBTC — oracle gives USDC per BTC):
 *   Oracle price rise means pool BTC is cheap in USDC terms.
 *   Arb: send USDC (token0) to pool, receive cbBTC (token1) → amount0 > 0 → token0In=true.
 *   However, quoteIsToken0=true means the oracle represents "token0 per token1", so
 *   when oracle rises, token1 value relative to token0 increases → sell token1 buy token0.
 *   → amount0 < 0 → token0In=false.
 */
function getArbDirectionToken0In(pool: PoolConfig, deviationBpsSigned = 0): boolean {
  // Finding 2 fix: arb direction depends on BOTH pool orientation AND the sign of
  // the oracle-vs-pool deviation. When deviation > 0 (oracle says the non-quote
  // asset is worth more than the pool), the arb buys from the pool; when < 0,
  // the arb sells to the pool — the opposite token0In.
  //
  // Truth table (verified against existing doc comments):
  //   quoteIsToken0=false, dev>0 → token0In=true  (send token0 in, receive token1)
  //   quoteIsToken0=false, dev<0 → token0In=false
  //   quoteIsToken0=true,  dev>0 → token0In=false
  //   quoteIsToken0=true,  dev<0 → token0In=true
  //
  // Equivalent: token0In = (dev > 0) !== quoteIsToken0
  // Fallback when deviationBpsSigned===0 (legacy CSV): assume dev>0 → original
  // constant `!quoteIsToken0` behavior preserved.
  const devPositive = deviationBpsSigned >= 0;
  return devPositive !== pool.quoteIsToken0;
}

// ─── getLogs with retry ───────────────────────────────────────────────────────

async function getSwapLogs(
  poolAddress: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<CompetitorSwap[]> {
  let attempts = 0;
  let lastErr: unknown;

  while (attempts < 5) {
    try {
      const logs = await client.getLogs({
        address: poolAddress,
        event: SWAP_ABI[0],
        fromBlock,
        toBlock,
      });

      const result: CompetitorSwap[] = [];
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: SWAP_ABI,
            data: log.data,
            topics: log.topics,
          });

          const args = decoded.args as {
            sender: `0x${string}`;
            recipient: `0x${string}`;
            amount0: bigint;
            amount1: bigint;
            sqrtPriceX96: bigint;
            liquidity: bigint;
            tick: number;
          };

          const token0In = args.amount0 > 0n;
          const tipWei = log.transactionHash ? await getTransactionTip(log.transactionHash) : 0n;

          result.push({
            txHash: log.transactionHash ?? "0x",
            sender: args.sender,
            token0In,
            tipWei,
            blockNumber: log.blockNumber ?? fromBlock,
          });
        } catch {
          // Skip individual decode failures silently.
        }
      }
      return result;
    } catch (e: unknown) {
      lastErr = e;
      const msg = String((e as Error).message ?? "");
      const isRateLimit =
        msg.includes("429") ||
        msg.includes("rate") ||
        msg.includes("too many") ||
        msg.includes("limit");
      const delayMs = isRateLimit ? 2000 * (attempts + 1) : 500 * (attempts + 1);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      attempts++;
    }
  }

  console.warn(
    `[WARN] getLogs failed after 5 attempts for ${poolAddress} blocks ${fromBlock}-${toBlock}: ` +
      String((lastErr as Error)?.message ?? lastErr).slice(0, 120),
  );
  return [];
}

// ─── Gas tip fetcher ──────────────────────────────────────────────────────────

/** Cache to avoid re-fetching gas price for the same transaction. */
const gasTipCache = new Map<string, bigint>();

async function getTransactionTip(txHash: `0x${string}`): Promise<bigint> {
  const cached = gasTipCache.get(txHash);
  if (cached !== undefined) return cached;

  try {
    const tx = await client.getTransaction({ hash: txHash });
    // Prefer maxPriorityFeePerGas (EIP-1559), fall back to gasPrice.
    const tip = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n;
    gasTipCache.set(txHash, tip);
    return tip;
  } catch {
    gasTipCache.set(txHash, 0n);
    return 0n;
  }
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onComplete: (result: T, index: number) => void,
): Promise<void> {
  let taskIndex = 0;

  async function worker(): Promise<void> {
    while (taskIndex < tasks.length) {
      const i = taskIndex++;
      const result = await tasks[i]();
      onComplete(result, i);
    }
  }

  const count = Math.min(concurrency, tasks.length);
  if (count === 0) return;
  await Promise.all(Array.from({ length: count }, () => worker()));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("=== OCR Backrun Competition Analyzer (Sprint 6.5) ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Analyzing top ${TOP_N} rows by netConservative from ${RAW_CSV_PATH}`);

  // 1. Load top 50 profitable rows.
  const topRows = await loadTop50();
  console.log(`\nLoaded ${topRows.length} profitable rows for competition analysis.`);

  if (topRows.length === 0) {
    console.error("No profitable rows found. Run orchestrator.ts first.");
    process.exit(1);
  }

  console.log(`\nQuerying Swap events in blocks [N, N+${SEARCH_WINDOW}] for each row...`);

  // 2. For each row, fetch Swap events and determine if a competitor captured it.
  const analyzedRows: AnalyzedRow[] = new Array(topRows.length);
  let completedCount = 0;

  const tasks = topRows.map((row, idx) => async (): Promise<AnalyzedRow> => {
    const pool = findPool(row.pool);

    if (!pool) {
      console.warn(`[WARN] Pool not found in config: ${row.pool}`);
      return {
        block: row.block,
        oracle: row.oracle,
        pool: row.pool,
        devBps: row.deviationBps,
        netCons: row.netConservative,
        hasCompetitor: false,
        competitorAddr: "",
        competitorTipGwei: 0,
        noSwapAtAll: true,
        arbDirectionToken0In: false,
      };
    }

    const fromBlock = row.block;
    const toBlock = row.block + BigInt(SEARCH_WINDOW);
    const swaps = await getSwapLogs(pool.address, fromBlock, toBlock);

    const arbDir = getArbDirectionToken0In(pool, row.deviationBpsSigned);
    const noSwapAtAll = swaps.length === 0;

    // Find competitor swaps: same arb direction within the window.
    // All non-zero senders are treated as potential competitors.
    const competitorSwaps = swaps.filter((s) => s.token0In === arbDir);

    // Pick the competitor with the highest gas tip (most aggressive).
    const topCompetitor =
      competitorSwaps.length > 0
        ? competitorSwaps.reduce((best, cur) => (cur.tipWei > best.tipWei ? cur : best))
        : null;

    const hasCompetitor = topCompetitor !== null;
    const tipGwei = topCompetitor ? Number(topCompetitor.tipWei) / 1e9 : 0;

    completedCount++;
    if (completedCount % 10 === 0 || completedCount === topRows.length) {
      console.log(
        `  [${completedCount}/${topRows.length}] analyzed — idx=${idx} block=${row.block}`,
      );
    }

    return {
      block: row.block,
      oracle: row.oracle,
      pool: row.pool,
      devBps: row.deviationBps,
      netCons: row.netConservative,
      hasCompetitor,
      competitorAddr: topCompetitor?.sender ?? "",
      competitorTipGwei: parseFloat(tipGwei.toFixed(4)),
      noSwapAtAll,
      arbDirectionToken0In: arbDir,
    };
  });

  await runWithConcurrency(tasks, CONCURRENCY, (result, idx) => {
    analyzedRows[idx] = result;
  });

  // 3. Aggregate results.
  const rowsWithCompetitorSwap = analyzedRows.filter((r) => r.hasCompetitor).length;
  const missedOpportunities = analyzedRows.filter((r) => r.noSwapAtAll).length;
  const captureRate = rowsWithCompetitorSwap / topRows.length;

  // Build competitor leaderboard.
  const competitorAccum = new Map<string, { wins: number; tipSum: number }>();
  for (const row of analyzedRows) {
    if (row.hasCompetitor && row.competitorAddr) {
      const addr = row.competitorAddr.toLowerCase();
      const entry = competitorAccum.get(addr) ?? { wins: 0, tipSum: 0 };
      entry.wins++;
      entry.tipSum += row.competitorTipGwei;
      competitorAccum.set(addr, entry);
    }
  }

  // Sort competitors by wins descending.
  const competitors: Record<string, { wins: number; avgTipGwei: number }> = {};
  for (const [addr, stats] of [...competitorAccum.entries()].sort(
    ([, a], [, b]) => b.wins - a.wins,
  )) {
    competitors[addr] = {
      wins: stats.wins,
      avgTipGwei: parseFloat((stats.tipSum / stats.wins).toFixed(4)),
    };
  }

  // Realistic daily edge: scale the "free" fraction against the full 14-day pool.
  const freeRows = analyzedRows.filter((r) => r.noSwapAtAll);
  const freeFraction = freeRows.length / topRows.length;
  const realisticDailyUsd = (FULL_14D_CONSERVATIVE * freeFraction) / REPLAY_DAYS;

  const summary: CompetitionSummary = {
    topRowsAnalyzed: topRows.length,
    rowsWithCompetitorSwap,
    captureRate: parseFloat(captureRate.toFixed(4)),
    competitors,
    missedOpportunities,
    ourRealisticEdge:
      `If we win all rows where no competitor swap exists (${freeRows.length}/${topRows.length} ` +
      `in top-${TOP_N}), our actual capture would be: $${realisticDailyUsd.toFixed(2)}/day`,
  };

  // 4. Write competition_summary.json.
  writeFileSync(COMPETITION_SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nWrote ${COMPETITION_SUMMARY_PATH}`);

  // 5. Write competition_top50.csv.
  const csvHeader =
    "block,oracle,pool,devBps,netCons,hasCompetitor,competitorAddr,competitorTipGwei";
  const csvLines = [
    csvHeader,
    ...analyzedRows.map((r) =>
      [
        r.block.toString(),
        r.oracle,
        `"${r.pool}"`,
        r.devBps.toFixed(2),
        r.netCons.toFixed(4),
        r.hasCompetitor ? "1" : "0",
        r.competitorAddr,
        r.competitorTipGwei.toFixed(4),
      ].join(","),
    ),
  ];
  writeFileSync(COMPETITION_TOP50_PATH, csvLines.join("\n") + "\n");
  console.log(`Wrote ${COMPETITION_TOP50_PATH}`);

  // 6. Print summary.
  console.log("\n=== COMPETITION ANALYSIS RESULTS ===");
  console.log(`Top ${topRows.length} rows analyzed`);
  console.log(
    `Rows with competitor swap (same direction): ${rowsWithCompetitorSwap}/${topRows.length}`,
  );
  console.log(`Competitor capture rate: ${(captureRate * 100).toFixed(1)}%`);
  console.log(
    `Missed opportunities (no swap at all in window): ${missedOpportunities}/${topRows.length}`,
  );
  console.log(`\n${summary.ourRealisticEdge}`);

  const topCompetitors = Object.entries(competitors).slice(0, 5);
  if (topCompetitors.length > 0) {
    console.log("\nTop competitors:");
    for (const [addr, stats] of topCompetitors) {
      console.log(`  ${addr}: ${stats.wins} wins, avg tip ${stats.avgTipGwei.toFixed(2)} gwei`);
    }
  }
}

main().catch((e: unknown) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
