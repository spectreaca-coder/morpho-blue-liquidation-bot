import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetShadowTimingLoggerForTests,
  createEventTimer,
  emitTimingRow,
  type CandidateRef,
  type ShadowTimingRow,
} from "../../src/utils/shadowTimingLogger.js";

const originalShadowOnly = process.env.SHADOW_ONLY;
const originalShadowTimingPath = process.env.SHADOW_TIMING_LOG_PATH;

function makeRef(index: number, collateralSymbol = "cbBTC"): CandidateRef {
  const borrower = `0x${index.toString(16).padStart(40, "0")}`;
  const marketId = `0x${index.toString(16).padStart(64, "0")}`;
  return {
    borrower,
    marketId,
    collateralSymbol,
  };
}

function makeRow(overrides: Partial<ShadowTimingRow> = {}): ShadowTimingRow {
  return {
    eventId: "event-1",
    path: "flashblock",
    oracleAddress: "0xoracle",
    oracleBlockNumber: 123,
    cexPair: null,
    cexPrice: null,
    triggerReceiveAt: 1,
    handlerDispatchAt: 2,
    candidateRef: makeRef(1),
    calldataReadyAt: 3,
    signCompleteAt: 4,
    wouldSubmitAt: 5,
    cacheHit: true,
    skippedReason: null,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readRows(logPath: string): Promise<ShadowTimingRow[]> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ShadowTimingRow);
}

describe("shadowTimingLogger", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shadow-timing-"));
    logPath = join(tempDir, "logs", "shadow_timing.jsonl");
    process.env.SHADOW_ONLY = "true";
    process.env.SHADOW_TIMING_LOG_PATH = logPath;
    _resetShadowTimingLoggerForTests();
  });

  afterEach(async () => {
    _resetShadowTimingLoggerForTests();
    if (originalShadowOnly === undefined) delete process.env.SHADOW_ONLY;
    else process.env.SHADOW_ONLY = originalShadowOnly;
    if (originalShadowTimingPath === undefined) delete process.env.SHADOW_TIMING_LOG_PATH;
    else process.env.SHADOW_TIMING_LOG_PATH = originalShadowTimingPath;
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("1. emitTimingRow basic JSONL write to tmp dir", async () => {
    expect(emitTimingRow(makeRow())).toBe(true);

    const rows = await readRows(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toBe("event-1");
    expect(rows[0]?.path).toBe("flashblock");
  });

  it("2. emitTimingRow mkdir -p on missing logs dir", async () => {
    const nestedLogPath = join(tempDir, "deep", "missing", "logs", "shadow_timing.jsonl");
    process.env.SHADOW_TIMING_LOG_PATH = nestedLogPath;

    expect(emitTimingRow(makeRow({ eventId: "event-2" }))).toBe(true);

    const directoryStat = await stat(dirname(nestedLogPath));
    expect(directoryStat.isDirectory()).toBe(true);
    const rows = await readRows(nestedLogPath);
    expect(rows[0]?.eventId).toBe("event-2");
  });

  it("3. emitTimingRow IO failure swallowed, returns false", async () => {
    const blockerPath = join(tempDir, "blocked");
    await writeFile(blockerPath, "not-a-directory", "utf8");
    process.env.SHADOW_TIMING_LOG_PATH = join(blockerPath, "shadow_timing.jsonl");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(emitTimingRow(makeRow({ eventId: "event-3" }))).toBe(false);
    expect(emitTimingRow(makeRow({ eventId: "event-4" }))).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("4. createEventTimer(flashblock) monotonic t0<=t1<=t2<=t3", async () => {
    const ref = makeRef(1);
    const timer = createEventTimer("flashblock", {
      oracleAddress: "0xfeed",
      oracleBlockNumber: 44,
    });

    timer.setHandlerDispatch();
    timer.addCandidate(ref);
    await delay(2);
    timer.setCalldataReady(ref);
    await delay(2);
    timer.setSignComplete(ref, true);
    await delay(2);
    timer.setWouldSubmit(ref);
    timer.flush();

    const [row] = await readRows(logPath);
    expect(row?.triggerReceiveAt).toBeLessThanOrEqual(row?.handlerDispatchAt ?? 0);
    expect(row?.handlerDispatchAt ?? 0).toBeLessThanOrEqual(row?.calldataReadyAt ?? 0);
    expect(row?.calldataReadyAt ?? 0).toBeLessThanOrEqual(row?.signCompleteAt ?? 0);
    expect(row?.signCompleteAt ?? 0).toBeLessThanOrEqual(row?.wouldSubmitAt ?? 0);
    expect(row?.cacheHit).toBe(true);
  });

  it("5. createEventTimer(poll, oracleCtx) oracle fields populated", async () => {
    const ref = makeRef(2, "WETH");
    const timer = createEventTimer("poll", {
      oracleAddress: "0xmockoracle",
      oracleBlockNumber: 999,
    });

    timer.setHandlerDispatch();
    timer.addCandidate(ref);
    timer.flush();

    const [row] = await readRows(logPath);
    expect(row?.path).toBe("poll");
    expect(row?.oracleAddress).toBe("0xmockoracle");
    expect(row?.oracleBlockNumber).toBe(999);
    expect(row?.cexPair).toBeNull();
  });

  it("6. createEventTimer(poll) periodic oracle fields null", async () => {
    const ref = makeRef(3, "cbETH");
    const timer = createEventTimer("poll");

    timer.setHandlerDispatch();
    timer.addCandidate(ref);
    timer.flush();

    const [row] = await readRows(logPath);
    expect(row?.path).toBe("poll");
    expect(row?.oracleAddress).toBeNull();
    expect(row?.oracleBlockNumber).toBeNull();
  });

  it("7. createEventTimer(cex-presign) cex populated, wouldSubmitAt null", async () => {
    const ref = makeRef(4, "cbBTC");
    const timer = createEventTimer("cex-presign", undefined, {
      cexPair: "BTC-USD",
      cexPrice: 67_001.25,
    });

    timer.setHandlerDispatch();
    timer.addCandidate(ref);
    timer.setCalldataReady(ref);
    timer.setSignComplete(ref, false);
    timer.flush();

    const [row] = await readRows(logPath);
    expect(row?.path).toBe("cex-presign");
    expect(row?.cexPair).toBe("BTC-USD");
    expect(row?.cexPrice).toBe(67_001.25);
    expect(row?.wouldSubmitAt).toBeNull();
  });

  it("8. fan-out: 1 event, 3 candidates -> 3 rows on flush, same eventId/triggerReceiveAt", async () => {
    const refs = [makeRef(5, "cbBTC"), makeRef(6, "WETH"), makeRef(7, "cbETH")];
    const timer = createEventTimer("flashblock", {
      oracleAddress: "0xfanout",
      oracleBlockNumber: 501,
    });

    timer.setHandlerDispatch();
    for (const ref of refs) {
      timer.addCandidate(ref);
      timer.setCalldataReady(ref);
      timer.setSignComplete(ref, true);
      timer.setWouldSubmit(ref);
    }
    timer.flush();

    const rows = await readRows(logPath);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(1);
    expect(new Set(rows.map((row) => row.triggerReceiveAt)).size).toBe(1);
    expect(new Set(rows.map((row) => row.candidateRef?.borrower)).size).toBe(3);
  });

  it("9. skipped candidate row has skippedReason + wouldSubmitAt null", async () => {
    const ref = makeRef(8, "cbBTC");
    const timer = createEventTimer("flashblock", {
      oracleAddress: "0xskip",
      oracleBlockNumber: 777,
    });

    timer.setHandlerDispatch();
    timer.addCandidate(ref);
    timer.setSkipped(ref, "busy-wallet");
    timer.flush();

    const [row] = await readRows(logPath);
    expect(row?.skippedReason).toBe("busy-wallet");
    expect(row?.wouldSubmitAt).toBeNull();
  });

  it("10. parallel flushes don't interleave (append-safe)", async () => {
    const timers = Array.from({ length: 5 }, (_, index) => {
      const timer = createEventTimer("poll", {
        oracleAddress: `0xoracle${index}`,
        oracleBlockNumber: index,
      });
      const ref = makeRef(index + 20, `asset-${index}`);
      timer.setHandlerDispatch();
      timer.addCandidate(ref);
      timer.setCalldataReady(ref);
      timer.setSignComplete(ref, false);
      timer.setWouldSubmit(ref);
      return timer;
    });

    await Promise.all(
      timers.map((timer) =>
        Promise.resolve().then(() => {
          timer.flush();
        }),
      ),
    );

    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
