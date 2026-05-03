/**
 * shadow-benchmark.test.ts
 *
 * Sprint 51c — Unit tests for scripts/shadow-benchmark.ts
 * Uses synthetic JSONL fixtures in a tmpdir.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyOutcome,
  computePathStats,
  correlate,
  findCompetitorMatch,
  indexCompetitorEvents,
  loadJsonl,
  renderMarkdown,
  type BenchmarkReport,
  type CompetitorIntelRecord,
  type ShadowTimingRow,
} from "../../../../scripts/shadow-benchmark.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "shadow-bench-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeTimingRow(overrides: Partial<ShadowTimingRow> = {}): ShadowTimingRow {
  return {
    eventId: "event-1",
    path: "flashblock",
    oracleAddress: "0xoracle",
    oracleBlockNumber: 100,
    cexPair: null,
    cexPrice: null,
    triggerReceiveAt: 1_713_654_321_000, // ms
    handlerDispatchAt: 1_713_654_321_010,
    candidateRef: {
      borrower: "0xBorrower01",
      marketId: "0xMarket001",
      collateralSymbol: "cbBTC",
    },
    calldataReadyAt: 1_713_654_321_050,
    signCompleteAt: 1_713_654_321_070,
    wouldSubmitAt: 1_713_654_321_080,
    cacheHit: true,
    skippedReason: null,
    ...overrides,
  };
}

function makeCompetitorRecord(
  overrides: Partial<CompetitorIntelRecord> = {},
): CompetitorIntelRecord {
  return {
    ts: Date.now(),
    blockNumber: "44905915",
    blockTimestamp: "1713654321", // seconds
    txHash: "0xtx01",
    winner: "0xwinner",
    marketId: "0xMarket001",
    borrower: "0xBorrower01",
    repaidShares: "1000",
    seizedAssets: "1100",
    gasUsed: "288000",
    effectiveGasPriceWei: "1000000",
    baseFeePerGasWei: "100000",
    tipPaidWei: "900000",
    maxPriorityFeePerGasWei: "900000",
    maxFeePerGasWei: "2000000",
    calldataLen: 228,
    selector: "0x1234abcd",
    nonce: 42,
    status: "success",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. loadJsonl — ENOENT returns []
// ---------------------------------------------------------------------------

describe("loadJsonl", () => {
  it("returns [] on ENOENT", async () => {
    const result = await loadJsonl<unknown>(join(tmpDir, "does-not-exist.jsonl"));
    expect(result).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 2. loadJsonl — skips malformed line, parses valid lines, warns to stderr
  // ---------------------------------------------------------------------------
  it("skips malformed line and parses valid lines, warns to stderr", async () => {
    const filePath = join(tmpDir, "mixed.jsonl");
    const lines = [
      JSON.stringify({ a: 1 }),
      "THIS IS NOT JSON {{{",
      JSON.stringify({ b: 2 }),
      "",
      JSON.stringify({ c: 3 }),
    ].join("\n");

    await writeFile(filePath, lines, "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await loadJsonl<{ a?: number; b?: number; c?: number }>(filePath);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ a: 1 });
    expect(result[1]).toEqual({ b: 2 });
    expect(result[2]).toEqual({ c: 3 });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));

    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. indexCompetitorEvents — groups and sorts by blockTimestamp
// ---------------------------------------------------------------------------

describe("indexCompetitorEvents", () => {
  it("groups records and sorts by blockTimestamp ascending", () => {
    const r1 = makeCompetitorRecord({ blockTimestamp: "1000", txHash: "0xtx1" });
    const r2 = makeCompetitorRecord({ blockTimestamp: "500", txHash: "0xtx2" });
    const r3 = makeCompetitorRecord({
      marketId: "0xOtherMarket",
      borrower: "0xOtherBorrower",
      blockTimestamp: "200",
      txHash: "0xtx3",
    });

    const index = indexCompetitorEvents([r1, r2, r3]);

    const key = "0xmarket001:0xborrower01";
    const bucket = index.get(key);
    expect(bucket).toHaveLength(2);
    expect(bucket?.[0]?.txHash).toBe("0xtx2"); // 500 < 1000
    expect(bucket?.[1]?.txHash).toBe("0xtx1");
  });
});

// ---------------------------------------------------------------------------
// 4. findCompetitorMatch — finds match inside window
// ---------------------------------------------------------------------------

describe("findCompetitorMatch", () => {
  it("finds a match within the window", () => {
    const competitor = makeCompetitorRecord({
      blockTimestamp: "1713654321", // seconds → ms = 1713654321000
    });
    const index = indexCompetitorEvents([competitor]);

    const row = makeTimingRow({ triggerReceiveAt: 1_713_654_321_000 }); // exact match
    const match = findCompetitorMatch(row, index, 30_000);
    expect(match).not.toBeNull();
    expect(match?.txHash).toBe(competitor.txHash);
  });

  // ---------------------------------------------------------------------------
  // 5. findCompetitorMatch — returns null outside window
  // ---------------------------------------------------------------------------
  it("returns null when outside window", () => {
    const competitor = makeCompetitorRecord({
      blockTimestamp: "1713654321",
    });
    const index = indexCompetitorEvents([competitor]);

    // triggerReceiveAt is 100 seconds (100000ms) away from competitor
    const row = makeTimingRow({
      triggerReceiveAt: 1_713_654_321_000 + 100_000,
    });
    const match = findCompetitorMatch(row, index, 30_000);
    expect(match).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 6. findCompetitorMatch — returns null when candidateRef is null
  // ---------------------------------------------------------------------------
  it("returns null when candidateRef is null", () => {
    const competitor = makeCompetitorRecord();
    const index = indexCompetitorEvents([competitor]);
    const row = makeTimingRow({ candidateRef: null });
    expect(findCompetitorMatch(row, index, 30_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. classifyOutcome — NO_SUBMIT when wouldSubmitAt is null
// ---------------------------------------------------------------------------

describe("classifyOutcome", () => {
  const competitor = makeCompetitorRecord({ blockTimestamp: "1713654321" }); // ms = 1713654321000

  it("returns NO_SUBMIT when wouldSubmitAt is null", () => {
    const row = makeTimingRow({ wouldSubmitAt: null });
    expect(classifyOutcome(row, competitor, 250, 50)).toBe("NO_SUBMIT");
  });

  // ---------------------------------------------------------------------------
  // 8. classifyOutcome — WIN when counterfactual faster than competitor by > tieWindow
  // ---------------------------------------------------------------------------
  it("returns WIN when counterfactual is faster by more than tieWindowMs", () => {
    // competitor at 1713654321000 ms
    // wouldSubmitAt such that counterfactual = wouldSubmitAt + 250 = 1713654320000 - 51 = way before
    // delta = counterfactual - competitorMs < -50
    const row = makeTimingRow({
      wouldSubmitAt: 1_713_654_321_000 - 400, // counterfactual = 1713654320850 → delta = -150 < -50
    });
    expect(classifyOutcome(row, competitor, 250, 50)).toBe("WIN");
  });

  // ---------------------------------------------------------------------------
  // 9. classifyOutcome — TIE inside tieWindow
  // ---------------------------------------------------------------------------
  it("returns TIE when within tieWindowMs", () => {
    // counterfactual = wouldSubmitAt + 250
    // competitorMs = 1713654321000
    // delta = 0 → TIE
    const row = makeTimingRow({
      wouldSubmitAt: 1_713_654_321_000 - 250, // counterfactual = exactly competitorMs
    });
    expect(classifyOutcome(row, competitor, 250, 50)).toBe("TIE");
  });

  // ---------------------------------------------------------------------------
  // 10. classifyOutcome — LOSE when counterfactual slower
  // ---------------------------------------------------------------------------
  it("returns LOSE when counterfactual is slower by more than tieWindowMs", () => {
    // delta > +50
    const row = makeTimingRow({
      wouldSubmitAt: 1_713_654_321_000, // counterfactual = 1713654321250 → delta = +250 > 50
    });
    expect(classifyOutcome(row, competitor, 250, 50)).toBe("LOSE");
  });
});

// ---------------------------------------------------------------------------
// 11. computePathStats — handles empty path (n=0, latency=null)
// ---------------------------------------------------------------------------

describe("computePathStats", () => {
  it("returns n=0 and null latency for an empty path", () => {
    const rows = [makeTimingRow({ path: "poll" })];
    const stats = computePathStats(rows);

    // flashblock has 0 rows (we gave only poll)
    const flashStats = stats.flashblock;
    expect(flashStats.n).toBe(0);
    expect(flashStats.cacheHitRatio).toBeNull();
    expect(flashStats.skippedCount).toBe(0);
    expect(flashStats.latency.total).toBeNull();
    expect(flashStats.latency.triggerToDispatch).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 12. computePathStats — p50/p90/p99 on known distribution
  // ---------------------------------------------------------------------------
  it("computes correct p50/p90/p99 on known distribution", () => {
    // Create 10 flashblock rows with total latency = index * 10ms
    const baseTime = 1_713_654_321_000;
    const rows: ShadowTimingRow[] = Array.from({ length: 10 }, (_, i) => {
      const offset = (i + 1) * 10;
      return makeTimingRow({
        path: "flashblock",
        eventId: `event-${i}`,
        triggerReceiveAt: baseTime,
        handlerDispatchAt: baseTime + 1,
        calldataReadyAt: baseTime + 2,
        signCompleteAt: baseTime + 3,
        wouldSubmitAt: baseTime + offset, // total = offset ms
        cacheHit: i % 2 === 0 ? true : false,
      });
    });

    const stats = computePathStats(rows);
    const fb = stats.flashblock;
    expect(fb.n).toBe(10);

    // Sorted total values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    // Nearest-rank: p50 = ceil(50/100*10)=5 → sorted[4]=50
    expect(fb.latency.total?.p50).toBe(50);
    // p90 = ceil(90/100*10)=9 → sorted[8]=90
    expect(fb.latency.total?.p90).toBe(90);
    // p99 = ceil(99/100*10)=10 → sorted[9]=100
    expect(fb.latency.total?.p99).toBe(100);

    // cacheHitRatio: 5 true, 5 false → 0.5
    expect(fb.cacheHitRatio).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// 13. correlate — end-to-end with small synthetic fixtures (fan-out: 1 event with 3 candidates)
// ---------------------------------------------------------------------------

describe("correlate", () => {
  it("end-to-end with WIN + LOSE + TIE + NO_SUBMIT + unmatched and fan-out", () => {
    const competitorMs = 1_713_654_321_000;
    const competitorSec = "1713654321";

    const competitors: CompetitorIntelRecord[] = [
      makeCompetitorRecord({
        blockTimestamp: competitorSec,
        txHash: "0xtxA",
        marketId: "0xMarket001",
        borrower: "0xBorrower01",
      }),
      makeCompetitorRecord({
        blockTimestamp: competitorSec,
        txHash: "0xtxB",
        marketId: "0xMarket002",
        borrower: "0xBorrower02",
      }),
      makeCompetitorRecord({
        blockTimestamp: competitorSec,
        txHash: "0xtxC",
        marketId: "0xMarket003",
        borrower: "0xBorrower03",
      }),
      makeCompetitorRecord({
        blockTimestamp: competitorSec,
        txHash: "0xtxD",
        marketId: "0xMarket004",
        borrower: "0xBorrower04",
      }),
    ];

    const timingRows: ShadowTimingRow[] = [
      // WIN: counterfactual = (competitorMs - 400) + 250 = competitorMs - 150 → delta=-150 < -50
      makeTimingRow({
        eventId: "e1",
        candidateRef: {
          borrower: "0xBorrower01",
          marketId: "0xMarket001",
          collateralSymbol: "cbBTC",
        },
        triggerReceiveAt: competitorMs,
        wouldSubmitAt: competitorMs - 400,
      }),
      // LOSE: wouldSubmitAt + 250 = competitorMs + 250 → delta=+250 > 50
      makeTimingRow({
        eventId: "e2",
        candidateRef: {
          borrower: "0xBorrower02",
          marketId: "0xMarket002",
          collateralSymbol: "WETH",
        },
        triggerReceiveAt: competitorMs,
        wouldSubmitAt: competitorMs,
      }),
      // TIE: wouldSubmitAt + 250 = competitorMs → delta=0
      makeTimingRow({
        eventId: "e3",
        candidateRef: {
          borrower: "0xBorrower03",
          marketId: "0xMarket003",
          collateralSymbol: "cbETH",
        },
        triggerReceiveAt: competitorMs,
        wouldSubmitAt: competitorMs - 250,
      }),
      // NO_SUBMIT
      makeTimingRow({
        eventId: "e4",
        candidateRef: {
          borrower: "0xBorrower04",
          marketId: "0xMarket004",
          collateralSymbol: "cbBTC",
        },
        triggerReceiveAt: competitorMs,
        wouldSubmitAt: null,
      }),
      // unmatched (no competitor for this market/borrower combo)
      makeTimingRow({
        eventId: "e5",
        candidateRef: {
          borrower: "0xBorrower99",
          marketId: "0xMarket999",
          collateralSymbol: "cbBTC",
        },
        triggerReceiveAt: competitorMs,
        wouldSubmitAt: competitorMs - 400,
      }),
    ];

    const report = correlate({
      timing: timingRows,
      competitor: competitors,
      intents: [],
      submitToIncludeMs: 250,
      matchWindowMs: 30_000,
      tieWindowMs: 50,
    });

    expect(report.outcomes.WIN).toBe(1);
    expect(report.outcomes.LOSE).toBe(1);
    expect(report.outcomes.TIE).toBe(1);
    expect(report.outcomes.NO_SUBMIT).toBe(1);
    expect(report.outcomes.unmatched).toBe(1);
    expect(report.totals.timingRows).toBe(5);
    expect(report.totals.competitorEvents).toBe(4);
    expect(report.totals.joinable).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 14. renderMarkdown — smoke test
// ---------------------------------------------------------------------------

describe("renderMarkdown", () => {
  it("contains all 5 path names and WIN/LOSE in output", () => {
    const emptyPathStats = computePathStats([]);
    const report: BenchmarkReport = {
      pathStats: emptyPathStats,
      outcomes: { WIN: 3, LOSE: 2, TIE: 1, NO_SUBMIT: 0, unmatched: 4 },
      totals: { timingRows: 10, competitorEvents: 8, intents: 5, joinable: 6 },
      config: { submitToIncludeMs: 250, matchWindowMs: 30_000, tieWindowMs: 50 },
    };

    const md = renderMarkdown(report);

    expect(md).toContain("flashblock");
    expect(md).toContain("poll");
    expect(md).toContain("pending-prewarm");
    expect(md).toContain("cex-presign");
    expect(md).toContain("cex-direct");
    expect(md).toContain("WIN");
    expect(md).toContain("LOSE");
    expect(md).toContain("3"); // WIN count
    expect(md).toContain("4"); // unmatched count
  });
});
