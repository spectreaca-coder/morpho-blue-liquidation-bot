/**
 * report.ts
 *
 * Sprint 6 — Markdown Report Generator for OCR Backrun Replay
 *
 * Reads:
 *   output/replay_raw.csv
 *   output/replay_summary.json
 *   output/competition_summary.json  (from competition.ts — Sprint 6.5)
 *
 * Produces:
 *   output/OCR_REPLAY_REPORT.md
 *
 * Sections:
 *   1. Executive Summary (GO/MARGINAL/DEAD verdict)
 *   2. Daily $ Summary Table (raw + competition-adjusted)
 *   3. Per-Oracle Breakdown
 *   4. Per-Pool Breakdown
 *   5. Top 10 Most Profitable Rows
 *   6. Profit Distribution Histogram
 *   7. Concentration (top 10% ratio)
 *   8. Competition Findings
 *   9. Known Issues
 *  10. Next Steps
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// ─── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_DIR = "./output";
const RAW_CSV_PATH = `${OUTPUT_DIR}/replay_raw.csv`;
const SUMMARY_PATH = `${OUTPUT_DIR}/replay_summary.json`;
const COMPETITION_PATH = `${OUTPUT_DIR}/competition_summary.json`;
const REPORT_PATH = `${OUTPUT_DIR}/OCR_REPLAY_REPORT.md`;

const REPLAY_DAYS = 14;

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface CompetitionSummary {
  topRowsAnalyzed: number;
  rowsWithCompetitorSwap: number;
  captureRate: number;
  competitors: Record<string, { wins: number; avgTipGwei: number }>;
  missedOpportunities: number;
  ourRealisticEdge: string;
}

interface CsvRow {
  block: string;
  txHash: string;
  oracle: string;
  pool: string;
  deviationBps: number;
  netConservative: number;
  netOptimistic: number;
}

// ─── CSV loader ───────────────────────────────────────────────────────────────

async function loadAllProfitableRows(): Promise<CsvRow[]> {
  if (!existsSync(RAW_CSV_PATH)) {
    throw new Error(`replay_raw.csv not found at ${RAW_CSV_PATH}.`);
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
      continue;
    }
    if (!line.trim()) continue;

    const parts = line.split(",");
    if (parts.length < 11) continue;

    const netConservative = parseFloat(parts[9]);
    if (netConservative <= 0) continue;

    rows.push({
      block: parts[0],
      txHash: parts[1],
      oracle: parts[2],
      pool: parts[3],
      deviationBps: parseFloat(parts[4]),
      netConservative,
      netOptimistic: parseFloat(parts[10]),
    });
  }

  return rows;
}

// ─── Verdict helper ───────────────────────────────────────────────────────────

function getVerdict(dailyConservative: number): "GO" | "MARGINAL" | "DEAD" {
  if (dailyConservative >= 30) return "GO";
  if (dailyConservative >= 10) return "MARGINAL";
  return "DEAD";
}

// ─── Table helpers ────────────────────────────────────────────────────────────

function pad(s: string, width: number, right = false): string {
  if (right) return s.padStart(width);
  return s.padEnd(width);
}

function mdTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const header = "| " + headers.map((h, i) => pad(h, colWidths[i])).join(" | ") + " |";
  const sep = "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const dataLines = rows.map(
    (r) => "| " + r.map((cell, i) => pad(cell ?? "", colWidths[i])).join(" | ") + " |",
  );

  return [header, sep, ...dataLines].join("\n");
}

// ─── Distribution histogram ───────────────────────────────────────────────────

interface HistBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

function buildHistogram(profitableRows: CsvRow[]): HistBucket[] {
  const buckets: HistBucket[] = [
    { label: "< $0.50", min: 0, max: 0.5, count: 0 },
    { label: "$0.50–$1", min: 0.5, max: 1, count: 0 },
    { label: "$1–$5", min: 1, max: 5, count: 0 },
    { label: "$5–$10", min: 5, max: 10, count: 0 },
    { label: "$10–$50", min: 10, max: 50, count: 0 },
    { label: "$50+", min: 50, max: Infinity, count: 0 },
  ];

  for (const row of profitableRows) {
    const v = row.netConservative;
    for (const b of buckets) {
      if (v >= b.min && v < b.max) {
        b.count++;
        break;
      }
    }
  }

  return buckets;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("=== OCR Backrun Report Generator (Sprint 6) ===");

  // 1. Load inputs.
  if (!existsSync(SUMMARY_PATH)) {
    throw new Error(`${SUMMARY_PATH} not found. Run orchestrator.ts first.`);
  }
  const summary: ReplaySummary = JSON.parse(readFileSync(SUMMARY_PATH, "utf-8")) as ReplaySummary;

  let competition: CompetitionSummary | null = null;
  if (existsSync(COMPETITION_PATH)) {
    competition = JSON.parse(readFileSync(COMPETITION_PATH, "utf-8")) as CompetitionSummary;
    console.log("Competition summary loaded.");
  } else {
    console.warn(
      "[WARN] competition_summary.json not found. Competition section will be placeholder. " +
        "Run competition.ts first for full report.",
    );
  }

  console.log("Loading profitable rows from replay_raw.csv...");
  const profitableRows = await loadAllProfitableRows();
  profitableRows.sort((a, b) => b.netConservative - a.netConservative);
  console.log(`Loaded ${profitableRows.length} profitable rows.`);

  // 2. Compute derived values.
  const rawVerdict = getVerdict(summary.dailyConservative);
  const topN = profitableRows.slice(0, 10);

  // Competition-adjusted daily estimate.
  let adjDailyConservative = summary.dailyConservative;
  let adjVerdict: "GO" | "MARGINAL" | "DEAD" = rawVerdict;
  if (competition) {
    // Fraction of opportunities NOT captured by competitors (based on noSwapAtAll proxy).
    const freeRate = competition.missedOpportunities / competition.topRowsAnalyzed;
    adjDailyConservative = summary.dailyConservative * freeRate;
    adjVerdict = getVerdict(adjDailyConservative);
  }

  // Concentration: top 10% of profitable rows vs total.
  const top10pct = profitableRows.slice(0, Math.ceil(profitableRows.length * 0.1));
  const top10pctSum = top10pct.reduce((s, r) => s + r.netConservative, 0);
  const totalProfitableSum = profitableRows.reduce((s, r) => s + r.netConservative, 0);
  const concentrationRatio = totalProfitableSum > 0 ? (top10pctSum / totalProfitableSum) * 100 : 0;

  const histogram = buildHistogram(profitableRows);

  // ─── Build report ─────────────────────────────────────────────────────────

  const lines: string[] = [];

  const ts = new Date().toISOString().split("T")[0];
  lines.push(`# OCR Backrun Replay — Analysis Report`);
  lines.push(`**Generated:** ${ts}  `);
  lines.push(`**Window:** 14 days  `);
  lines.push(`**Total oracle events:** ${summary.totalEvents}  `);
  lines.push(`**Total pool-event rows:** ${summary.totalRows}  `);
  lines.push(`**Profitable rows (netConservative > 0):** ${summary.profitableRows}`);
  lines.push("");

  // ─── Section 1: Executive Verdict ─────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 1. Executive Verdict");
  lines.push("");

  const verdictEmoji: Record<string, string> = { GO: "GO", MARGINAL: "MARGINAL", DEAD: "DEAD" };

  lines.push(
    `**Raw ceiling (no competition):** ${verdictEmoji[rawVerdict]} — ` +
      `$${summary.dailyConservative.toFixed(2)}/day conservative, ` +
      `$${summary.dailyOptimistic.toFixed(2)}/day optimistic`,
  );
  lines.push("");

  if (competition) {
    lines.push(
      `**Competition-adjusted estimate:** ${verdictEmoji[adjVerdict]} — ` +
        `$${adjDailyConservative.toFixed(2)}/day  `,
    );
    lines.push(
      `_(Based on ${competition.missedOpportunities}/${competition.topRowsAnalyzed} ` +
        `top-${competition.topRowsAnalyzed} rows with no competitor swap detected)_`,
    );
    lines.push("");
    lines.push(`**Final verdict: ${adjVerdict}**`);
  } else {
    lines.push(`**Final verdict (raw): ${rawVerdict}**  `);
    lines.push("_(Competition data unavailable — run competition.ts for adjusted verdict)_");
  }

  lines.push("");
  lines.push("**Verdict thresholds:** $30+/day = GO | $10–$30/day = MARGINAL | <$10/day = DEAD");
  lines.push("");

  // ─── Section 2: Daily $ Summary ───────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 2. Daily $ Summary");
  lines.push("");

  const summaryTableHeaders = ["Metric", "Conservative", "Optimistic"];
  const summaryTableRows: string[][] = [
    [
      "14-day total",
      `$${summary.totalNetConservative.toFixed(2)}`,
      `$${summary.totalNetOptimistic.toFixed(2)}`,
    ],
    [
      "Daily average (raw)",
      `$${summary.dailyConservative.toFixed(2)}`,
      `$${summary.dailyOptimistic.toFixed(2)}`,
    ],
  ];

  if (competition) {
    summaryTableRows.push([
      "Daily average (competition-adj)",
      `$${adjDailyConservative.toFixed(2)}`,
      `$${(summary.dailyOptimistic * (competition.missedOpportunities / competition.topRowsAnalyzed)).toFixed(2)}`,
    ]);
  }

  lines.push(mdTable(summaryTableHeaders, summaryTableRows));
  lines.push("");
  lines.push(
    `> Conservative = ×0.3 of gross profit. Optimistic = ×0.6. ` +
      `Reflects execution slippage, missed blocks, and partial fill uncertainty.`,
  );
  lines.push("");

  // ─── Section 3: Per-Oracle Breakdown ──────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 3. Per-Oracle Breakdown");
  lines.push("");

  const oracleHeaders = [
    "Oracle",
    "Total Rows",
    "Profitable",
    "Cons Total",
    "Opt Total",
    "Cons/Day",
  ];
  const oracleRows: string[][] = Object.entries(summary.byOracle).map(([oracle, stats]) => [
    oracle,
    stats.rows.toString(),
    stats.profitable.toString(),
    `$${stats.totalNetConservative.toFixed(2)}`,
    `$${stats.totalNetOptimistic.toFixed(2)}`,
    `$${(stats.totalNetConservative / REPLAY_DAYS).toFixed(2)}`,
  ]);

  lines.push(mdTable(oracleHeaders, oracleRows));
  lines.push("");

  // ─── Section 4: Per-Pool Breakdown ────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 4. Per-Pool Breakdown");
  lines.push("");

  const poolHeaders = [
    "Pool",
    "Total Rows",
    "Profitable",
    "Cons Total",
    "Opt Total",
    "Cons/Day",
    "% of Total",
  ];
  const allPoolsConsCons = summary.totalNetConservative;
  const poolRows: string[][] = Object.entries(summary.byPool)
    .sort(([, a], [, b]) => b.totalNetConservative - a.totalNetConservative)
    .map(([pool, stats]) => [
      pool,
      stats.rows.toString(),
      stats.profitable.toString(),
      `$${stats.totalNetConservative.toFixed(2)}`,
      `$${stats.totalNetOptimistic.toFixed(2)}`,
      `$${(stats.totalNetConservative / REPLAY_DAYS).toFixed(2)}`,
      allPoolsConsCons > 0
        ? `${((stats.totalNetConservative / allPoolsConsCons) * 100).toFixed(1)}%`
        : "0%",
    ]);

  lines.push(mdTable(poolHeaders, poolRows));
  lines.push("");

  // ─── Section 5: Top 10 Most Profitable Rows ───────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 5. Top 10 Most Profitable Rows");
  lines.push("");

  const top10Headers = ["Block", "Oracle", "Pool", "DevBps", "NetCons", "NetOpt"];
  const top10Rows: string[][] = topN.map((r) => [
    r.block,
    r.oracle,
    r.pool,
    r.deviationBps.toFixed(2),
    `$${r.netConservative.toFixed(4)}`,
    `$${r.netOptimistic.toFixed(4)}`,
  ]);

  lines.push(mdTable(top10Headers, top10Rows));
  lines.push("");

  // ─── Section 6: Profit Distribution Histogram ─────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 6. Profit Distribution Histogram (netConservative, profitable rows only)");
  lines.push("");

  const histHeaders = ["Bucket", "Count", "% of Profitable", "Bar"];
  const totalProfit = profitableRows.length;
  const histRows: string[][] = histogram.map((b) => {
    const pct = totalProfit > 0 ? (b.count / totalProfit) * 100 : 0;
    const bar = "#".repeat(Math.round(pct / 2));
    return [b.label, b.count.toString(), `${pct.toFixed(1)}%`, bar];
  });

  lines.push(mdTable(histHeaders, histRows));
  lines.push("");

  // ─── Section 7: Concentration Ratio ──────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 7. Concentration Analysis");
  lines.push("");
  lines.push(
    `**Top 10% rows (${top10pct.length} of ${profitableRows.length} profitable) ` +
      `contribute ${concentrationRatio.toFixed(1)}% of total conservative profit.**`,
  );
  lines.push("");
  if (concentrationRatio >= 70) {
    lines.push(
      "> WARNING: Distribution is highly lumpy — a few large events dominate. " +
        "Actual capture rate will vary heavily depending on whether these specific events recur.",
    );
  } else if (concentrationRatio >= 50) {
    lines.push(
      "> MODERATE concentration — top events are important but there is a meaningful long tail.",
    );
  } else {
    lines.push("> Distribution is relatively even — many small-to-medium events contribute.");
  }
  lines.push("");

  // ─── Section 8: Competition Findings ─────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 8. Competition Findings");
  lines.push("");

  if (competition) {
    lines.push(`Analyzed top **${competition.topRowsAnalyzed}** rows by netConservative.`);
    lines.push("");

    const competitionTableHeaders = ["Metric", "Value"];
    const competitionTableRows: string[][] = [
      [
        "Rows with competitor swap (same direction)",
        `${competition.rowsWithCompetitorSwap}/${competition.topRowsAnalyzed}`,
      ],
      ["Competitor capture rate", `${(competition.captureRate * 100).toFixed(1)}%`],
      [
        "Rows with NO swap at all (missed opportunities)",
        `${competition.missedOpportunities}/${competition.topRowsAnalyzed}`,
      ],
    ];
    lines.push(mdTable(competitionTableHeaders, competitionTableRows));
    lines.push("");

    lines.push(`**Realistic edge:** ${competition.ourRealisticEdge}`);
    lines.push("");

    const topCompetitors = Object.entries(competition.competitors).slice(0, 5);
    if (topCompetitors.length > 0) {
      lines.push("### Top Competitor Addresses");
      lines.push("");
      const compHeaders = ["Address", "Wins", "Avg Tip (gwei)"];
      const compRows: string[][] = topCompetitors.map(([addr, stats]) => [
        addr,
        stats.wins.toString(),
        stats.avgTipGwei.toFixed(2),
      ]);
      lines.push(mdTable(compHeaders, compRows));
      lines.push("");
    } else {
      lines.push("_No competitor addresses identified (no same-direction swaps in window)._");
      lines.push("");
    }
  } else {
    lines.push(
      "_Competition data unavailable. Run `pnpm tsx src/competition.ts` to generate " +
        "`output/competition_summary.json` and re-run this report._",
    );
    lines.push("");
  }

  // ─── Section 9: Known Issues ──────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 9. Known Issues");
  lines.push("");
  lines.push(
    "1. **cbBTC undersizing (active liquidity heuristic):** The cbBTC pools (USDC/cbBTC UniV3 500 " +
      "and USDC/cbBTC Aero CL 100) show zero profitable rows. The profit calculator uses the full " +
      "in-range liquidity but cbBTC pools have very concentrated liquidity — the actual active " +
      "liquidity at the current tick is much lower. The oracle deviation threshold (15bps) is also " +
      "larger relative to the pool fee (500 = 50bps), making the arb margin thin. Until the " +
      "liquidity heuristic is improved to use tick-level active liquidity instead of global " +
      "liquidity, cbBTC pool estimates remain unreliable.",
  );
  lines.push("");
  lines.push(
    "2. **cbETH/ETH oracle coverage:** cbETH/ETH shows zero profitable rows across 14 events. " +
      "The cbETH/WETH UniV3 500 pool appears insufficient in liquidity depth for profitable arbs " +
      "at the ~50bps deviation threshold.",
  );
  lines.push("");
  lines.push(
    "3. **wstETH/ETH capacity cap:** wstETH/ETH rows are capped at $500K swap size. Real " +
      "execution may be limited by pool depth for large moves. The $44.98 conservative 14-day " +
      "total from wstETH/ETH assumes this cap is achievable.",
  );
  lines.push("");
  lines.push(
    "4. **Competition analysis uses directional proxy:** The competition analyzer checks for " +
      "same-direction swaps in blocks [N, N+2]. This is a conservative proxy — it may " +
      "over-count competitors (any same-direction swap = competitor, including unrelated traders).",
  );
  lines.push("");

  // ─── Section 10: Next Steps ───────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## 10. Next Steps");
  lines.push("");

  if (adjVerdict === "GO") {
    lines.push("**Verdict: GO** — proceed to implementation.");
    lines.push("");
    lines.push("- Implement OCR backrun executor (monitor AnswerUpdated → swap in same block)");
    lines.push("- Target Aerodrome WETH/USDC CL100 and WETH/USDC UniV3 500 as primary venues");
    lines.push("- Set priority fee > competitor avg tip to win blocks");
    lines.push("- Deploy canary with $1K capital, validate on-chain vs replay estimates");
  } else if (adjVerdict === "MARGINAL") {
    lines.push("**Verdict: MARGINAL** — further validation required before committing to build.");
    lines.push("");
    lines.push(
      "- Validate competition analysis results manually on 3-5 of the top rows (check block explorer)",
    );
    lines.push("- Assess whether the `missedOpportunities` rows are genuinely uncontested");
    lines.push(
      "- If >40% of top rows are uncontested, the realistic edge may justify a lean implementation",
    );
    lines.push(
      "- Consider a 48h shadow mode (monitor but don't execute) to measure live competition",
    );
    lines.push("- Re-run replay over a 30-day window when more historical data is available");
  } else {
    lines.push("**Verdict: DEAD** — do not build.");
    lines.push("");
    lines.push("- Competition has captured nearly all available edge");
    lines.push(
      "- Redirect effort to primary Morpho liquidation bot (proven $5-12K/month base case)",
    );
    lines.push("- Re-evaluate if oracle update frequency or pool liquidity changes significantly");
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("_End of report._");

  // ─── Write output ──────────────────────────────────────────────────────────

  const reportContent = lines.join("\n") + "\n";
  writeFileSync(REPORT_PATH, reportContent);

  console.log(`\nWrote ${REPORT_PATH} (${reportContent.length} bytes, ${lines.length} lines)`);
  console.log(`\nFinal verdict: ${adjVerdict}`);
  console.log(`  Raw ceiling: $${summary.dailyConservative.toFixed(2)}/day conservative`);
  if (competition) {
    console.log(`  Competition-adjusted: $${adjDailyConservative.toFixed(2)}/day`);
    console.log(`  Competitor capture rate: ${(competition.captureRate * 100).toFixed(1)}%`);
  }
}

main().catch((e: unknown) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
