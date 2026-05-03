import { describe, expect, it } from "vitest";

import type { ReplayEvent, ReplayResult } from "../../../../scripts/time-trial/replay-types.js";
import {
  assignPorts,
  expandReplayTasks,
  filterPendingTasks,
  isTerminalReplayResult,
  isReplayableCandidate,
  loadCompletedTaskKeys,
  parseModes,
  summarizeResults,
} from "../../../../scripts/time-trial/run-time-trial.js";

function candidate(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return {
    type: "time_trial_candidate",
    eventId: "evt-1",
    scope: "primary_whitelist",
    marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    marketLabel: "cbBTC",
    borrower: "0x72be381236f3B2BE44Fb2ab81B67ea603F2eDd56",
    winnerTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    winnerBlockNumber: "100",
    winnerTxIndex: 2,
    winnerBlockTimestamp: "1000",
    oracleProxy: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9",
    oracleType: "direct_chainlink",
    aggregatorLegs: ["0x852ae0b1af1aaedb0fc4428b4b24420780976ca8"],
    triggerTxHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    triggerBlockNumber: "99",
    triggerTxIndex: 1,
    triggerBlockTimestamp: "999",
    triggerAggregator: "0x852ae0b1af1aaedb0fc4428b4b24420780976ca8",
    triggerLegLabel: "cbBTC/USD",
    attributionBucket: "immediate_raceable_oracle",
    attributionValidated: null,
    regimeBucket: "active",
    notes: [],
    ...overrides,
  };
}

function result(overrides: Partial<ReplayResult> = {}): ReplayResult {
  return {
    type: "time_trial_replay",
    eventId: "evt-1",
    workerId: 0,
    port: 8545,
    mode: "warm_sign_required",
    path: "flashblock",
    forkBlockNumber: "98",
    anvilResetMs: 1,
    warmupMs: 2,
    oraclePatchMethod: "chainlink_storage_patch",
    oraclePatchValidated: true,
    triggerReceiveAt: 100,
    handlerDispatchAt: 101,
    candidateRef: {
      borrower: "0x72be381236f3B2BE44Fb2ab81B67ea603F2eDd56",
      marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
      collateralSymbol: "cbBTC",
    },
    calldataReadyAt: 120,
    signCompleteAt: 130,
    wouldSubmitAt: 140,
    cacheHit: false,
    skippedReason: null,
    wouldSubmitMs: 40,
    selectedBorrowerMatchesHistorical: true,
    replayError: null,
    ...overrides,
  };
}

describe("time-trial replay coordinator helpers", () => {
  it("assigns sequential ports in the allowed range", () => {
    expect(assignPorts(3)).toEqual([8545, 8546, 8547]);
  });

  it("rejects invalid worker counts", () => {
    expect(() => assignPorts(0)).toThrow(/between 1 and 6/i);
    expect(() => assignPorts(7)).toThrow(/between 1 and 6/i);
  });

  it("parses warm mode lists without duplicates", () => {
    expect(parseModes("warm_sign_required,warm_presign_ready,warm_sign_required")).toEqual([
      "warm_sign_required",
      "warm_presign_ready",
    ]);
  });

  it("treats immediate oracle events as replayable", () => {
    expect(isReplayableCandidate(candidate())).toBe(true);
  });

  it("excludes composed oracle events from the 107-event full replay set", () => {
    expect(
      isReplayableCandidate(
        candidate({
          eventId: "evt-2",
          marketLabel: "cbETH-alt",
          oracleType: "morpho_chainlink_v2",
          attributionBucket: "oracle_composed_leg",
        }),
      ),
    ).toBe(false);
  });

  it("excludes unsupported oracle candidates", () => {
    expect(
      isReplayableCandidate(
        candidate({
          marketLabel: "cbXRP",
          oracleType: "redstone_unsupported",
          attributionBucket: "unsupported_oracle_type",
        }),
      ),
    ).toBe(false);
  });

  it("expands each event into both replay modes", () => {
    const tasks = expandReplayTasks([candidate()], ["warm_sign_required", "warm_presign_ready"]);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.mode)).toEqual(["warm_sign_required", "warm_presign_ready"]);
  });

  it("filters out completed (eventId, mode) pairs on resume", () => {
    const tasks = expandReplayTasks([candidate()], ["warm_sign_required", "warm_presign_ready"]);
    const completed = loadCompletedTaskKeys([result({ mode: "warm_presign_ready" })]);
    const pending = filterPendingTasks(tasks, completed);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.mode).toBe("warm_sign_required");
  });

  it("supports multiple events during resume filtering", () => {
    const events = [candidate(), candidate({ eventId: "evt-2" })];
    const tasks = expandReplayTasks(events, ["warm_sign_required"]);
    const pending = filterPendingTasks(
      tasks,
      loadCompletedTaskKeys([result({ eventId: "evt-2" })]),
    );
    expect(pending.map((task) => task.event.eventId)).toEqual(["evt-1"]);
  });

  it("keeps both warm modes distinct in summaries", () => {
    const lines = summarizeResults([
      result({ mode: "warm_sign_required", wouldSubmitMs: 120 }),
      result({
        eventId: "evt-2",
        mode: "warm_presign_ready",
        wouldSubmitMs: 20,
        cacheHit: true,
      }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("warm_sign_required");
    expect(lines[1]).toContain("warm_presign_ready");
  });

  it("reports n/a percentiles when no successful latency exists", () => {
    const lines = summarizeResults([result({ wouldSubmitMs: null, replayError: "no_submit" })]);
    expect(lines[0]).toContain("p50=n/a");
  });

  it("uses replay output rows to build completed keys", () => {
    const keys = loadCompletedTaskKeys([
      result({ eventId: "evt-a", mode: "warm_sign_required" }),
      result({ eventId: "evt-a", mode: "warm_presign_ready" }),
    ]);
    expect(keys.has("evt-a::warm_sign_required")).toBe(true);
    expect(keys.has("evt-a::warm_presign_ready")).toBe(true);
  });

  it("treats transient infra failures as retryable on resume", () => {
    expect(
      isTerminalReplayResult(
        result({
          replayError:
            'HTTP request failed.\n\nURL: http://127.0.0.1:8545\nRequest body: {"method":"anvil_reset"}\n\nDetails: fetch failed',
          wouldSubmitMs: null,
        }),
      ),
    ).toBe(false);
  });

  it("preserves event ordering when expanding warm modes", () => {
    const tasks = expandReplayTasks(
      [candidate({ eventId: "evt-1" }), candidate({ eventId: "evt-2" })],
      ["warm_sign_required", "warm_presign_ready"],
    );
    expect(tasks.map((task) => `${task.event.eventId}:${task.mode}`)).toEqual([
      "evt-1:warm_sign_required",
      "evt-1:warm_presign_ready",
      "evt-2:warm_sign_required",
      "evt-2:warm_presign_ready",
    ]);
  });
});
