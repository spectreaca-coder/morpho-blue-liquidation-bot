import { describe, expect, it } from "vitest";

import {
  buildSummary,
  classifyOutcome,
  computePerMarketStats,
  computePerModeStats,
  computePerRegimeStats,
  joinCandidatesWithReplays,
} from "../../../../scripts/time-trial/correlate.js";
import type { ReplayEvent, ReplayResult } from "../../../../scripts/time-trial/replay-types.js";

function candidate(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return {
    type: "time_trial_candidate",
    eventId: "evt-1",
    scope: "primary_whitelist",
    marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    marketLabel: "cbBTC",
    borrower: "0x72be381236f3B2BE44Fb2ab81B67ea603F2eDd56",
    winnerTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    winnerBlockNumber: "102",
    winnerTxIndex: 8,
    winnerBlockTimestamp: "1005",
    oracleProxy: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9",
    oracleType: "direct_chainlink",
    aggregatorLegs: ["0x852ae0b1af1aaedb0fc4428b4b24420780976ca8"],
    triggerTxHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    triggerBlockNumber: "100",
    triggerTxIndex: 3,
    triggerBlockTimestamp: "1000",
    triggerAggregator: "0x852ae0b1af1aaedb0fc4428b4b24420780976ca8",
    triggerLegLabel: "cbBTC/USD",
    attributionBucket: "immediate_raceable_oracle",
    attributionValidated: null,
    regimeBucket: "cascade",
    notes: [],
    ...overrides,
  };
}

function replay(overrides: Partial<ReplayResult> = {}): ReplayResult {
  return {
    type: "time_trial_replay",
    eventId: "evt-1",
    workerId: 0,
    port: 8545,
    mode: "warm_sign_required",
    path: "flashblock",
    forkBlockNumber: "99",
    anvilResetMs: 10,
    warmupMs: 20,
    oraclePatchMethod: "chainlink_storage_patch",
    oraclePatchValidated: true,
    triggerReceiveAt: 1777000000000,
    handlerDispatchAt: 1777000000001,
    candidateRef: {
      borrower: "0x72be381236f3B2BE44Fb2ab81B67ea603F2eDd56",
      marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
      collateralSymbol: "cbBTC",
    },
    calldataReadyAt: 1777000000002,
    signCompleteAt: 1777000000003,
    wouldSubmitAt: 1777000000004,
    cacheHit: false,
    skippedReason: null,
    wouldSubmitMs: 100,
    selectedBorrowerMatchesHistorical: true,
    replayError: null,
    ...overrides,
  };
}

describe("time-trial correlator", () => {
  it("classifies a clear win when our expected inclusion is earlier", () => {
    const row = classifyOutcome(candidate(), replay(), 250, 200, 2000);
    expect(row.verdict).toBe("win_clear");
    expect(row.marginMs).toBe(-4650);
  });

  it("classifies a clear loss when our expected inclusion is later", () => {
    const row = classifyOutcome(
      candidate({ winnerBlockTimestamp: "1000" }),
      replay({ wouldSubmitMs: 600 }),
      250,
      200,
      2000,
    );
    expect(row.verdict).toBe("loss_clear");
    expect(row.marginMs).toBe(850);
  });

  it("treats the tie window as inclusive", () => {
    const row = classifyOutcome(
      candidate({ winnerBlockTimestamp: "1000" }),
      replay({ wouldSubmitMs: 0 }),
      200,
      200,
      2000,
    );
    expect(row.verdict).toBe("tie_window");
    expect(row.marginMs).toBe(200);
  });

  it("classifies same-block cases as probable order-unknown wins", () => {
    const row = classifyOutcome(
      candidate({ winnerBlockNumber: "100", winnerBlockTimestamp: "1000" }),
      replay({ wouldSubmitMs: 900 }),
      250,
      200,
      2000,
    );
    expect(row.verdict).toBe("win_probable_order_unknown");
    expect(row.sameBlockAsWinner).toBe(true);
    expect(row.notes).toContain("same_block_order_only");
  });

  it("skips rows with replay errors", () => {
    const row = classifyOutcome(
      candidate(),
      replay({ replayError: "boom", wouldSubmitMs: null }),
      250,
      200,
      2000,
    );
    expect(row.verdict).toBe("skipped");
    expect(row.reason).toBe("replay_error");
  });

  it("skips borrower mismatches", () => {
    const row = classifyOutcome(
      candidate(),
      replay({ selectedBorrowerMatchesHistorical: false }),
      250,
      200,
      2000,
    );
    expect(row.verdict).toBe("skipped");
    expect(row.reason).toBe("borrower_mismatch");
  });

  it("skips stale oracle candidates", () => {
    const row = classifyOutcome(
      candidate({ attributionBucket: "stale_oracle_possible" }),
      replay(),
      250,
      200,
      2000,
    );
    expect(row.verdict).toBe("skipped");
    expect(row.reason).toBe("stale_oracle_possible");
  });

  it("marks missing candidates explicitly", () => {
    const row = classifyOutcome(null, replay(), 250, 200, 2000);
    expect(row.verdict).toBe("skipped");
    expect(row.reason).toBe("candidate_not_found");
    expect(row.marketLabel).toBe("cbBTC");
  });

  it("keeps warm modes separate in aggregation", () => {
    const rows = [
      classifyOutcome(
        candidate({ eventId: "evt-1" }),
        replay({ eventId: "evt-1", mode: "warm_sign_required" }),
        250,
        200,
        2000,
      ),
      classifyOutcome(
        candidate({ eventId: "evt-2" }),
        replay({ eventId: "evt-2", mode: "warm_presign_ready" }),
        250,
        200,
        2000,
      ),
    ];
    const stats = computePerModeStats(rows);
    expect(Object.keys(stats)).toEqual(["warm_presign_ready", "warm_sign_required"]);
    expect(stats.warm_sign_required?.total).toBe(1);
    expect(stats.warm_presign_ready?.total).toBe(1);
  });

  it("aggregates by market", () => {
    const rows = [
      classifyOutcome(
        candidate({ marketLabel: "cbBTC" }),
        replay({ eventId: "evt-1" }),
        250,
        200,
        2000,
      ),
      classifyOutcome(
        candidate({ eventId: "evt-2", marketLabel: "WETH" }),
        replay({ eventId: "evt-2" }),
        250,
        200,
        2000,
      ),
    ];
    const stats = computePerMarketStats(rows);
    expect(stats.cbBTC?.total).toBe(1);
    expect(stats.WETH?.total).toBe(1);
  });

  it("aggregates by regime", () => {
    const rows = [
      classifyOutcome(
        candidate({ regimeBucket: "active" }),
        replay({ eventId: "evt-1" }),
        250,
        200,
        2000,
      ),
      classifyOutcome(
        candidate({ eventId: "evt-2", regimeBucket: "cascade" }),
        replay({ eventId: "evt-2" }),
        250,
        200,
        2000,
      ),
    ];
    const stats = computePerRegimeStats(rows);
    expect(stats.active?.total).toBe(1);
    expect(stats.cascade?.total).toBe(1);
  });

  it("respects submit-to-include sensitivity", () => {
    const fast = classifyOutcome(candidate(), replay({ wouldSubmitMs: 100 }), 50, 200, 2000);
    const slow = classifyOutcome(candidate(), replay({ wouldSubmitMs: 100 }), 5201, 200, 2000);
    expect(fast.verdict).toBe("win_clear");
    expect(slow.verdict).toBe("loss_clear");
  });

  it("joins and de-duplicates replay rows by eventId and mode", () => {
    const joined = joinCandidatesWithReplays(
      [candidate({ eventId: "evt-1" }), candidate({ eventId: "evt-2" })],
      [
        replay({ eventId: "evt-2", mode: "warm_presign_ready", wouldSubmitMs: 999 }),
        replay({ eventId: "evt-1", mode: "warm_sign_required", wouldSubmitMs: 1 }),
        replay({ eventId: "evt-2", mode: "warm_presign_ready", wouldSubmitMs: 2 }),
      ],
    );
    expect(joined.map((row) => `${row.eventId}:${row.mode}`)).toEqual([
      "evt-1:warm_sign_required",
      "evt-2:warm_presign_ready",
    ]);
    expect(joined[1]?.replay.wouldSubmitMs).toBe(2);
  });

  it("produces deterministic ordering in the summary builder", () => {
    const rows = [
      classifyOutcome(
        candidate({ eventId: "evt-b" }),
        replay({ eventId: "evt-b", mode: "warm_presign_ready" }),
        250,
        200,
        2000,
      ),
      classifyOutcome(
        candidate({ eventId: "evt-a" }),
        replay({ eventId: "evt-a", mode: "warm_sign_required" }),
        250,
        200,
        2000,
      ),
    ];
    const summary = buildSummary(rows, {
      submitToIncludeMs: 250,
      matchWindowMs: 2000,
      tieWindowMs: 200,
    });
    expect(Object.keys(summary.byMode)).toEqual(["warm_presign_ready", "warm_sign_required"]);
  });
});
