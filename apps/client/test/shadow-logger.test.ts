import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Address, Hex, PublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShadowLogger, type ShadowAttemptParams } from "../src/shadow-logger.js";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const OUR_EXECUTOR = "0x00000000000000000000000000000000000000aa";
const OTHER_EXECUTOR = "0x00000000000000000000000000000000000000bb";

function makeAttempt(overrides: Partial<ShadowAttemptParams> = {}): ShadowAttemptParams {
  return {
    borrower: "0x00000000000000000000000000000000000000b0",
    marketId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    collateralSymbol: "cbBTC",
    loanSymbol: "USDC",
    ourTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ourTipWei: 15_000_000n,
    ourMaxFeePerGasWei: 1_500_000_000n,
    ourSentBlock: 100n,
    ourSentMs: 1_700_000_000_000,
    expectedProfitUsd: 42,
    flashblockReceivedMs: 1_699_999_999_900,
    ...overrides,
  };
}

type StubbedClient = PublicClient & {
  request: ReturnType<typeof vi.fn>;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getTransaction: ReturnType<typeof vi.fn>;
  getTransactionReceipt: ReturnType<typeof vi.fn>;
  getBlock: ReturnType<typeof vi.fn>;
  getCode: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Record<string, unknown> = {}): StubbedClient {
  return {
    request: vi.fn(async () => []),
    getBlockNumber: vi.fn(async () => 103n),
    getTransaction: vi.fn(async () => ({
      from: "0x00000000000000000000000000000000000000f1" as Address,
      to: MORPHO,
    })),
    getTransactionReceipt: vi.fn(async () => ({
      blockNumber: 101n,
      effectiveGasPrice: 25_000_000n,
      gasUsed: 700_000n,
    })),
    getBlock: vi.fn(async () => ({
      baseFeePerGas: 10_000_000n,
      timestamp: 1_700_000_001n,
    })),
    getCode: vi.fn(async () => "0x"),
    ...overrides,
  } as StubbedClient;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function readJsonLines(logPath: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForLineCount(
  logPath: string,
  count: number,
): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const lines = await readJsonLines(logPath);
      if (lines.length >= count) return lines;
    } catch {
      // appendFile may not have created the file yet
    }
    await flushAsyncWork();
  }
  throw new Error(`timed out waiting for ${count} log lines`);
}

describe("ShadowLogger", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Only fake setTimeout/clearTimeout so we can deterministically advance the
    // enrichment delay timer, while keeping setImmediate/queueMicrotask real —
    // fs/promises.appendFile and viem RPC mocks rely on them, and full fake
    // timers cause the LOST-path enrichment chain (getLogs → getTx → getReceipt
    // → getBlock → getCode → appendFile) to never resolve.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    tempDir = await mkdtemp(join(tmpdir(), "shadow-logger-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("recordAttempt writes a shadow_attempt line immediately", async () => {
    const logPath = join(tempDir, "shadow.jsonl");
    const logger = new ShadowLogger({
      logPath,
      publicClient: makeClient(),
      morphoAddress: MORPHO,
      ourExecutorAddresses: new Set([OUR_EXECUTOR]),
      enrichmentDelayMs: 1_000,
    });

    logger.recordAttempt(makeAttempt());

    const lines = await waitForLineCount(logPath, 1);
    expect(lines[0]).toMatchObject({
      type: "shadow_attempt",
      ourTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ourTipGwei: 0.015,
      sentBlock: "100",
    });
  });

  it("writes shadow_outcome after enrichment for WON and LOST cases", async () => {
    const wonPath = join(tempDir, "won.jsonl");
    const wonClient = makeClient({
      request: vi.fn(async () => [
        {
          transactionHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
          blockNumber: "0x65" as Hex,
          transactionIndex: "0x0" as Hex,
          logIndex: "0x0" as Hex,
        },
      ]),
    });
    const wonLogger = new ShadowLogger({
      logPath: wonPath,
      publicClient: wonClient,
      morphoAddress: MORPHO,
      ourExecutorAddresses: new Set([OUR_EXECUTOR]),
      enrichmentDelayMs: 25,
    });

    wonLogger.recordAttempt(makeAttempt());
    await vi.advanceTimersByTimeAsync(25);
    await flushAsyncWork();

    const wonLines = await waitForLineCount(wonPath, 2);
    expect(wonLines[1]).toMatchObject({
      type: "shadow_outcome",
      outcome: "WON",
      winnerTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      winnerToRole: "morpho_direct",
      sealedBlock: "101",
    });

    const lostPath = join(tempDir, "lost.jsonl");
    const lostClient = makeClient({
      request: vi.fn(async () => [
        {
          transactionHash:
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
          blockNumber: "0x65" as Hex,
          transactionIndex: "0x1" as Hex,
          logIndex: "0x0" as Hex,
        },
      ]),
      getTransaction: vi.fn(async () => ({
        from: "0x00000000000000000000000000000000000000f2" as Address,
        to: OTHER_EXECUTOR,
      })),
      getTransactionReceipt: vi.fn(async () => ({
        blockNumber: 101n,
        effectiveGasPrice: 40_000_000n,
        gasUsed: 710_000n,
      })),
      getBlock: vi.fn(async () => ({
        baseFeePerGas: 10_000_000n,
        timestamp: 1_700_000_002n,
      })),
      getCode: vi.fn(async () => "0x1234"),
    });
    const lostLogger = new ShadowLogger({
      logPath: lostPath,
      publicClient: lostClient,
      morphoAddress: MORPHO,
      ourExecutorAddresses: new Set([OUR_EXECUTOR]),
      enrichmentDelayMs: 25,
    });

    lostLogger.recordAttempt(
      makeAttempt({
        ourTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      }),
    );
    await vi.advanceTimersByTimeAsync(25);
    await flushAsyncWork();

    const lostLines = await waitForLineCount(lostPath, 2);
    expect(lostLines[1]).toMatchObject({
      type: "shadow_outcome",
      outcome: "LOST",
      winnerTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      winnerToAddress: OTHER_EXECUTOR,
      winnerToRole: "unknown_private_relay",
      winnerTipGwei: 0.03,
      winnerEffectiveGasPriceGwei: 0.04,
      lagMs: 2000,
      lagBlocks: 1,
    });
  });

  it("stop prevents pending enrichment from firing", async () => {
    const logPath = join(tempDir, "stopped.jsonl");
    const client = makeClient();
    const logger = new ShadowLogger({
      logPath,
      publicClient: client,
      morphoAddress: MORPHO,
      ourExecutorAddresses: new Set([OUR_EXECUTOR]),
      enrichmentDelayMs: 1_000,
    });

    logger.recordAttempt(makeAttempt());
    await waitForLineCount(logPath, 1);
    logger.stop();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    const lines = await waitForLineCount(logPath, 1);
    expect(lines).toHaveLength(1);
    expect(client.request).not.toHaveBeenCalled();
  });
});
