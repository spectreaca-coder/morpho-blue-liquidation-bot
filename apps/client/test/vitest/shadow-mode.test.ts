/**
 * Tests for shadow-mode submit abstraction (txSubmitter.ts + shadow-runtime.ts).
 *
 * Coverage:
 *  1. isShadowMode() returns correct boolean based on env var
 *  2. submitOrShadow() env=false: calls fallbackFn, returns shadowMode=false result
 *  3. submitOrShadow() env=true: does NOT call fallbackFn, writes intent JSONL, returns synthetic
 *  4. submitBundleOrShadow() env=false / env=true
 *  5. Intent JSONL line matches schema
 *  6. logs/ dir auto-created if missing
 *  7. Multiple intents in parallel do not interleave writes (append mode)
 *  8. fallbackFn errors propagate when env=false
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// We need to intercept the module-level SHADOW_INTENT_LOG_PATH constant
// in txSubmitter.ts. The constant references "logs/shadow_submit_intent.jsonl"
// relative to CWD. We override appendJsonlRecord via the shadow-runtime mock so
// we can redirect writes to a temp dir without patching CWD.
// ──────────────────────────────────────────────────────────────────────────────

let capturedLogPath: string | undefined;
let capturedRecord: unknown;

// Capture writes from appendJsonlRecord so tests can inspect them.
vi.mock("../../src/utils/shadow-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/shadow-runtime.js")>();
  return {
    ...actual,
    // isShadowOnly reads process.env directly — leave it real so vi.stubEnv works.
    appendJsonlRecord: vi.fn(async (logPath: string, record: unknown, _prefix: string) => {
      capturedLogPath = logPath;
      capturedRecord = record;
    }),
  };
});

// Import AFTER mock registration so the mock is in place.
import { appendJsonlRecord } from "../../src/utils/shadow-runtime.js";
import { isShadowMode, submitBundleOrShadow, submitOrShadow } from "../../src/utils/txSubmitter.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const BORROWER = "0x1000000000000000000000000000000000000001" as Hex;
const MARKET_ID = `0x${"aa".repeat(32)}`;
const SIGNED_TX = "0xdeadbeef01" as Hex;
const SYNTHETIC_PREFIX = "0x"; // keccak256 returns 0x-prefixed

function candidateRef() {
  return { borrower: BORROWER, marketId: MARKET_ID, collateralSymbol: "cbBTC" };
}

function gasParams() {
  return {
    nonce: 7,
    gas: 700_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 5_000_000n,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  capturedLogPath = undefined;
  capturedRecord = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ──────────────────────────────────────────────────────────────────────────────
// 1. isShadowMode()
// ──────────────────────────────────────────────────────────────────────────────

describe("isShadowMode()", () => {
  it("returns false when SHADOW_ONLY is unset", () => {
    vi.stubEnv("SHADOW_ONLY", "");
    expect(isShadowMode()).toBe(false);
  });

  it("returns false when SHADOW_ONLY is 'false'", () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    expect(isShadowMode()).toBe(false);
  });

  it("returns true when SHADOW_ONLY is 'true'", () => {
    vi.stubEnv("SHADOW_ONLY", "true");
    expect(isShadowMode()).toBe(true);
  });

  it("is hot-reload friendly — reflects env changes between calls", () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    expect(isShadowMode()).toBe(false);
    vi.stubEnv("SHADOW_ONLY", "true");
    expect(isShadowMode()).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. submitOrShadow() — production path (env=false)
// ──────────────────────────────────────────────────────────────────────────────

describe("submitOrShadow() — production path", () => {
  it("calls fallbackFn and returns its result when SHADOW_ONLY=false", async () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    const expected = "0xproductiontxhash" as Hex;
    const submit = vi.fn().mockResolvedValue(expected);

    const result = await submitOrShadow({
      path: "alchemy",
      triggerPath: "flashblock",
      candidateRef: candidateRef(),
      gasParams: gasParams(),
      serializedTx: SIGNED_TX,
      submit,
      createSyntheticResult: (_hash) => "0xsynthetic" as Hex,
    });

    expect(submit).toHaveBeenCalledOnce();
    expect(result).toBe(expected);
    // Live mode now emits intent + outcome records (Option C observability).
    // Fire-and-forget: appendJsonlRecord runs in microtask, so flush it.
    await new Promise((r) => setTimeout(r, 0));
    expect(appendJsonlRecord).toHaveBeenCalledTimes(2);
    const calls = (appendJsonlRecord as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const intent = calls[0]?.[1] as Record<string, unknown>;
    const outcome = calls[1]?.[1] as Record<string, unknown>;
    expect(intent.type).toBe("live_submit_intent");
    expect(intent.path).toBe("alchemy");
    expect(intent.triggerPath).toBe("flashblock");
    expect(outcome.type).toBe("live_submit_outcome");
    expect(outcome.status).toBe("accepted");
    // Default txHash extraction: a Hex string return value is captured.
    expect(outcome.txHash).toBe(expected);
    expect(typeof outcome.latencyMs).toBe("number");
    expect(outcome.errorMessage).toBeNull();
  });

  it("uses extractOutcome callback for non-Hex result types", async () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    const expected = { bundleHash: "0xabc123", acceptedCount: 4 };
    const submit = vi.fn().mockResolvedValue(expected);

    const result = await submitOrShadow({
      path: "flashbots-bundle",
      candidateRef: candidateRef(),
      submit,
      createSyntheticResult: (_hash) => expected,
      extractOutcome: (r) => ({ txHash: (r as { bundleHash: string }).bundleHash }),
    });

    expect(result).toEqual(expected);
    await new Promise((r) => setTimeout(r, 0));
    const calls = (appendJsonlRecord as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const outcome = calls[1]?.[1] as Record<string, unknown>;
    expect(outcome.txHash).toBe("0xabc123");
  });

  it("emits error outcome and re-throws when submit rejects", async () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    const submit = vi.fn().mockRejectedValue(new Error("rpc timeout"));

    await expect(
      submitOrShadow({
        path: "alchemy",
        candidateRef: candidateRef(),
        submit,
        createSyntheticResult: (_hash) => "0xsynthetic" as Hex,
      }),
    ).rejects.toThrow("rpc timeout");

    expect(submit).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(appendJsonlRecord).toHaveBeenCalledTimes(2);
    const calls = (appendJsonlRecord as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const outcome = calls[1]?.[1] as Record<string, unknown>;
    expect(outcome.type).toBe("live_submit_outcome");
    expect(outcome.status).toBe("error");
    expect(outcome.errorMessage).toBe("rpc timeout");
    expect(outcome.txHash).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. submitOrShadow() — shadow path (env=true)
// ──────────────────────────────────────────────────────────────────────────────

describe("submitOrShadow() — shadow path", () => {
  it("does NOT call fallbackFn when SHADOW_ONLY=true", async () => {
    vi.stubEnv("SHADOW_ONLY", "true");
    const submit = vi.fn().mockResolvedValue("should-not-be-called");

    await submitOrShadow({
      path: "alchemy",
      candidateRef: candidateRef(),
      gasParams: gasParams(),
      serializedTx: SIGNED_TX,
      submit,
      createSyntheticResult: (hash) => hash,
    });

    expect(submit).not.toHaveBeenCalled();
  });

  it("returns a synthetic tx hash prefixed with 0x", async () => {
    vi.stubEnv("SHADOW_ONLY", "true");

    const result = await submitOrShadow({
      path: "alchemy",
      candidateRef: candidateRef(),
      gasParams: gasParams(),
      serializedTx: SIGNED_TX,
      submit: vi.fn(),
      createSyntheticResult: (hash) => hash,
    });

    expect(typeof result).toBe("string");
    expect((result as string).startsWith(SYNTHETIC_PREFIX)).toBe(true);
  });

  it("writes to appendJsonlRecord on shadow path", async () => {
    vi.stubEnv("SHADOW_ONLY", "true");

    await submitOrShadow({
      path: "bloxroute",
      triggerPath: "poll",
      candidateRef: candidateRef(),
      gasParams: gasParams(),
      serializedTx: SIGNED_TX,
      submit: vi.fn(),
      createSyntheticResult: (hash) => hash,
    });

    expect(appendJsonlRecord).toHaveBeenCalledOnce();
    expect(capturedLogPath).toContain("shadow_submit_intent.jsonl");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. submitBundleOrShadow() — same as submitOrShadow (delegates to it)
// ──────────────────────────────────────────────────────────────────────────────

describe("submitBundleOrShadow()", () => {
  it("calls fallbackFn and returns result when SHADOW_ONLY=false", async () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    const expected = { bundleHash: "0xabc" };
    const submit = vi.fn().mockResolvedValue(expected);

    const result = await submitBundleOrShadow({
      path: "flashbots-bundle",
      bundle: { txCount: 2, targetBlockNumber: "100", blockCount: 1 },
      submit,
      createSyntheticResult: (_hash) => ({ bundleHash: "0xsynthetic" }),
    });

    expect(submit).toHaveBeenCalledOnce();
    expect(result).toEqual(expected);
  });

  it("does NOT call fallbackFn and logs when SHADOW_ONLY=true", async () => {
    vi.stubEnv("SHADOW_ONLY", "true");
    const submit = vi.fn();

    await submitBundleOrShadow({
      path: "flashbots-bundle",
      bundle: { txCount: 1, targetBlockNumber: "200", blockCount: 3 },
      submit,
      createSyntheticResult: (_hash) => ({ bundleHash: "0xsynthetic" }),
    });

    expect(submit).not.toHaveBeenCalled();
    expect(appendJsonlRecord).toHaveBeenCalledOnce();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. Intent JSONL schema validation
// ──────────────────────────────────────────────────────────────────────────────

describe("Intent JSONL schema", () => {
  it("record matches expected schema fields", async () => {
    vi.stubEnv("SHADOW_ONLY", "true");

    await submitOrShadow({
      path: "sequencer",
      triggerPath: "flashblock",
      eventId: "evt-test-123",
      candidateRef: candidateRef(),
      gasParams: gasParams(),
      serializedTx: SIGNED_TX,
      metadata: { url: "https://mainnet-sequencer.base.org" },
      submit: vi.fn(),
      createSyntheticResult: (hash) => hash,
    });

    expect(capturedRecord).toBeDefined();
    const record = capturedRecord as Record<string, unknown>;

    // Required schema fields
    expect(record.type).toBe("shadow_submit_intent");
    expect(typeof record.timestamp).toBe("number");
    expect(record.path).toBe("sequencer");
    expect(record.triggerPath).toBe("flashblock");
    expect(record.eventId).toBe("evt-test-123");
    expect(record.shadowMode).toBe(true);

    // syntheticTxHash present and 0x-prefixed
    expect(typeof record.syntheticTxHash).toBe("string");
    expect((record.syntheticTxHash as string).startsWith("0x")).toBe(true);

    // candidateRef
    const ref = record.candidateRef as Record<string, unknown>;
    expect(ref.borrower).toBe(BORROWER);
    expect(ref.marketId).toBe(MARKET_ID);
    expect(ref.collateralSymbol).toBe("cbBTC");

    // gasParams serialized as strings (not bigint)
    const gp = record.gasParams as Record<string, unknown>;
    expect(gp.nonce).toBe(7);
    expect(typeof gp.maxFeePerGas).toBe("string");
    expect(typeof gp.maxPriorityFeePerGas).toBe("string");
    expect(gp.maxFeePerGas).toBe("2000000000");
    expect(gp.maxPriorityFeePerGas).toBe("5000000");
  });

  it("serializedTx is included in the record", async () => {
    vi.stubEnv("SHADOW_ONLY", "true");

    await submitOrShadow({
      path: "alchemy",
      serializedTx: SIGNED_TX,
      submit: vi.fn(),
      createSyntheticResult: (hash) => hash,
    });

    const record = capturedRecord as Record<string, unknown>;
    expect(record.serializedTx).toBe(SIGNED_TX);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. logs/ dir auto-created if missing
//    (We test appendJsonlRecord is called with the correct path — the real
//     mkdir logic is in shadow-runtime.ts which is tested separately by the
//     mock capturing the call. Here we verify the path contains "logs/".)
// ──────────────────────────────────────────────────────────────────────────────

describe("logs/ path", () => {
  it("intent log path contains 'logs/' directory segment", async () => {
    vi.stubEnv("SHADOW_ONLY", "true");

    await submitOrShadow({
      path: "alchemy",
      submit: vi.fn(),
      createSyntheticResult: (hash) => hash,
    });

    expect(capturedLogPath).toMatch(/logs\//);
    expect(capturedLogPath).toMatch(/shadow_submit_intent\.jsonl$/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. Parallel writes do not interleave (append mode check via real fs)
//    Uses shadow-runtime.ts directly to test appendJsonlRecord atomicity.
// ──────────────────────────────────────────────────────────────────────────────

describe("appendJsonlRecord — parallel write safety", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "shadow-test-"));
    logPath = join(tmpDir, "parallel.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parallel appends produce N valid JSONL lines (no interleaving)", async () => {
    // Opt out of the VITEST no-op guard since this test must exercise the
    // real disk write path against an isolated tmpdir.
    vi.stubEnv("DISABLE_TEST_LOG_GUARD", "true");

    // Use vi.importActual to get the real (unmocked) appendJsonlRecord.
    const realModule = await vi.importActual<typeof import("../../src/utils/shadow-runtime.js")>(
      "../../src/utils/shadow-runtime.js",
    );
    const realAppend = realModule.appendJsonlRecord;

    const COUNT = 20;
    const records = Array.from({ length: COUNT }, (_, i) => ({
      seq: i,
      data: `record-${i}`,
    }));

    await Promise.all(records.map((rec) => realAppend(logPath, rec, "[test]")));

    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(COUNT);

    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      expect(parsed).toHaveProperty("seq");
      expect(parsed).toHaveProperty("data");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. fallbackFn errors propagate when env=false (already covered in test 2,
//    but explicitly naming the requirement here for traceability)
// ──────────────────────────────────────────────────────────────────────────────

describe("error propagation", () => {
  it("network error from fallbackFn is re-thrown in production mode", async () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    const networkError = new Error("connection refused");
    const submit = vi.fn().mockRejectedValue(networkError);

    await expect(
      submitOrShadow({
        path: "alchemy",
        submit,
        createSyntheticResult: (hash) => hash,
      }),
    ).rejects.toThrow("connection refused");
  });

  it("type error from fallbackFn is re-thrown in production mode", async () => {
    vi.stubEnv("SHADOW_ONLY", "false");
    const submit = vi.fn().mockRejectedValue(new TypeError("invalid argument"));

    await expect(
      submitBundleOrShadow({
        path: "flashbots-bundle",
        submit,
        createSyntheticResult: (_hash) => ({ bundleHash: "x" }),
      }),
    ).rejects.toThrow("invalid argument");
  });
});
