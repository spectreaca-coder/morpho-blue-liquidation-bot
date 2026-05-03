import type { ChainConfig } from "@morpho-blue-liquidation-bot/config";
import type { Address, Hex } from "viem";
import { getGasPrice, sendRawTransaction } from "viem/actions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiquidationBot } from "../../src/bot.js";
import { FlashblockHandler } from "../../src/flashblock-handler.js";
import type { OracleUpdateEvent } from "../../src/flashblock-watcher.js";
import type { PositionCache } from "../../src/position-cache.js";
import type { PreSignedTx, PreSigner } from "../../src/preSigner.js";
import type {
  PrimaryWalletCoordinator,
  PrimaryWalletLease,
} from "../../src/primary-wallet-coordinator.js";
import { TxCache, type PrebuiltTx } from "../../src/tx-cache.js";

vi.mock("viem/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/actions")>();
  return {
    ...actual,
    getGasPrice: vi.fn(),
    getTransactionReceipt: vi.fn(),
    readContract: vi.fn(),
    sendRawTransaction: vi.fn(),
  };
});

vi.mock("../../src/discord-notifier.js", () => ({
  discord: {
    notifyBatchResult: vi.fn().mockResolvedValue(undefined),
    notifyError: vi.fn().mockResolvedValue(undefined),
    notifyFlashCrash: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/health.js", () => ({
  setFlashblockLastEventMs: vi.fn(),
}));

vi.mock("../../src/utils/bloxrouteSubmit.js", () => ({
  buildBloxroutePromise: vi.fn(),
  loadBloxrouteConfig: vi.fn(() => null),
}));

const BORROWER = "0x1000000000000000000000000000000000000001" as Address;
const EXECUTOR = "0x2000000000000000000000000000000000000002" as Address;
const MARKET_ID = `0x${"11".repeat(32)}`;
const FRESH_SIGNED_TX = "0xdeadbeef" as Hex;
const CACHED_SIGNED_TX = "0xcafebabe" as Hex;
const TX_HASH = `0x${"aa".repeat(32)}`;
const REQUIRED_MAX_FEE_PER_GAS = 2_500_000_000n;
const REQUIRED_MAX_PRIORITY_FEE_PER_GAS = 5_000_000n;

const handlers: FlashblockHandler[] = [];

function makePrebuilt(): PrebuiltTx {
  return {
    borrower: BORROWER,
    marketId: MARKET_ID,
    collateralSymbol: "WETH",
    loanSymbol: "USDC",
    lltv: 850_000_000_000_000_000n,
    calls: ["0x1234" as Hex],
    borrowAssets: 20_000_000n,
    seizableCollateral: 1_000_000_000_000_000_000n,
    builtAt: Date.now(),
  };
}

function makeEvent(): OracleUpdateEvent {
  return {
    aggregatorAddress: "0x1e0b2c3896338fbb201c4f0a27c6904801dca06b",
    blockNumber: 123,
    flashblockIndex: 0,
    detectedAt: new Date().toISOString(),
    rawTx: "0x1234",
    extractedPrice: 200_000_000_000n,
  };
}

function makeCachedTx(overrides: Partial<PreSignedTx> = {}): PreSignedTx {
  const prebuilt = makePrebuilt();
  return {
    signedTx: CACHED_SIGNED_TX,
    calldata: TxCache.encodeCalldata(prebuilt),
    nonce: 7,
    gas: 700_000n,
    maxFeePerGas: REQUIRED_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: REQUIRED_MAX_PRIORITY_FEE_PER_GAS,
    createdAt: Date.now(),
    borrower: BORROWER,
    marketId: MARKET_ID,
    ...overrides,
  };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await nextTick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function setGasCache(
  handler: FlashblockHandler,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): void {
  const mutable = handler as unknown as {
    cachedMaxFeePerGas: bigint;
    cachedMaxPriorityFeePerGas: bigint;
  };
  mutable.cachedMaxFeePerGas = maxFeePerGas;
  mutable.cachedMaxPriorityFeePerGas = maxPriorityFeePerGas;
}

async function createSubject(options?: {
  cachedTx?: PreSignedTx;
  preSignerEnabled?: boolean;
  sendSucceeds?: boolean;
}): Promise<{
  handler: FlashblockHandler;
  signTransaction: ReturnType<typeof vi.fn>;
  preSignerSpies?: {
    get: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  };
  coordinatorSpies: {
    nextNonce: ReturnType<typeof vi.fn>;
    resetNonceCache: ReturnType<typeof vi.fn>;
    rollbackNonce: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}> {
  const prebuilt = makePrebuilt();
  const candidate = {
    position: {
      borrower: BORROWER,
      marketId: MARKET_ID,
      collateralSymbol: "WETH",
      loanSymbol: "USDC",
      loanDecimals: 6,
    },
    healthFactor: 0n,
    borrowAssets: prebuilt.borrowAssets,
    seizableCollateral: prebuilt.seizableCollateral,
  };

  const signTransaction = vi.fn().mockResolvedValue(FRESH_SIGNED_TX);
  const lease: PrimaryWalletLease = { owner: "test-lease", token: Symbol("test-lease") };
  const coordinatorSpies = {
    nextNonce: vi.fn().mockResolvedValue(7),
    claimReservedNonce: vi.fn((_lease: PrimaryWalletLease, nonce: number) => nonce === 7),
    resetNonceCache: vi.fn(),
    rollbackNonce: vi.fn(),
    release: vi.fn(),
  };
  const coordinator = {
    client: {
      signTransaction,
    },
    executorAddress: EXECUTOR,
    tryAcquire: vi.fn().mockReturnValue(lease),
    nextNonce: coordinatorSpies.nextNonce,
    claimReservedNonce: coordinatorSpies.claimReservedNonce,
    rollbackNonce: coordinatorSpies.rollbackNonce,
    resetNonceCache: coordinatorSpies.resetNonceCache,
    release: coordinatorSpies.release,
  } as unknown as PrimaryWalletCoordinator;

  const positionCache = {
    findLiquidatableByPrice: vi.fn().mockReturnValue([candidate]),
    findByCollateralSymbol: vi.fn().mockReturnValue([candidate]),
  } as unknown as PositionCache;

  const txCache = {
    get: vi.fn().mockReturnValue(prebuilt),
  } as unknown as TxCache;

  const bot = {
    fastLiquidate: vi.fn(),
  } as unknown as LiquidationBot;

  const preSignerEnabled = options?.preSignerEnabled ?? true;
  const preSignerSpies = preSignerEnabled
    ? {
        get: vi.fn().mockReturnValue(options?.cachedTx),
        invalidate: vi.fn(),
      }
    : undefined;
  const preSigner = preSignerSpies as PreSigner | undefined;

  const sendRawTransactionMock = vi.mocked(sendRawTransaction);
  if (options?.sendSucceeds === false) {
    sendRawTransactionMock.mockRejectedValue(new Error("send failed"));
  } else {
    sendRawTransactionMock.mockResolvedValue(TX_HASH);
  }

  const handler = new FlashblockHandler(
    "[test] ",
    { chainId: 1 } as ChainConfig,
    bot,
    positionCache,
    txCache,
    coordinator,
    undefined,
    undefined,
    preSigner,
  );
  handlers.push(handler);
  await nextTick();
  setGasCache(handler, REQUIRED_MAX_FEE_PER_GAS, 0n);

  return {
    handler,
    signTransaction,
    preSignerSpies,
    coordinatorSpies,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(getGasPrice).mockResolvedValue(1_000_000_000n);
});

afterEach(() => {
  while (handlers.length > 0) {
    handlers.pop()?.dispose();
  }
  vi.restoreAllMocks();
});

describe("FlashblockHandler presign reuse", () => {
  it("uses a matching cached tx and skips local signing", async () => {
    const cachedTx = makeCachedTx();
    const { handler, signTransaction, preSignerSpies } = await createSubject({
      cachedTx,
      sendSucceeds: true,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(
      () => (preSignerSpies?.invalidate.mock.calls.length ?? 0) === 1,
      "post-broadcast invalidate",
    );

    expect(signTransaction).not.toHaveBeenCalled();
    expect(vi.mocked(sendRawTransaction)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendRawTransaction)).toHaveBeenCalledWith(expect.anything(), {
      serializedTransaction: cachedTx.signedTx,
    });
    expect(preSignerSpies?.invalidate).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledWith(BORROWER, MARKET_ID);
  });

  it("falls back to fresh signing when the cached tx is stale", async () => {
    const { handler, signTransaction, preSignerSpies } = await createSubject({
      cachedTx: makeCachedTx({ createdAt: Date.now() - 30_001 }),
      sendSucceeds: false,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(() => signTransaction.mock.calls.length === 1, "fresh sign");
    await waitFor(() => vi.mocked(sendRawTransaction).mock.calls.length === 1, "send attempt");

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledWith(BORROWER, MARKET_ID);
  });

  it("falls back to fresh signing when the cached nonce mismatches", async () => {
    const { handler, signTransaction, preSignerSpies } = await createSubject({
      cachedTx: makeCachedTx({ nonce: 6 }),
      sendSucceeds: false,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(() => signTransaction.mock.calls.length === 1, "fresh sign");
    await waitFor(() => vi.mocked(sendRawTransaction).mock.calls.length === 1, "send attempt");

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledWith(BORROWER, MARKET_ID);
  });

  it("falls back to fresh signing when the cached max fee is below the required floor", async () => {
    const { handler, signTransaction, preSignerSpies } = await createSubject({
      cachedTx: makeCachedTx({ maxFeePerGas: REQUIRED_MAX_FEE_PER_GAS - 1n }),
      sendSucceeds: false,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(() => signTransaction.mock.calls.length === 1, "fresh sign");
    await waitFor(() => vi.mocked(sendRawTransaction).mock.calls.length === 1, "send attempt");

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledWith(BORROWER, MARKET_ID);
  });

  it("falls back to fresh signing when the cached calldata mismatches", async () => {
    const { handler, signTransaction, preSignerSpies } = await createSubject({
      cachedTx: makeCachedTx({ calldata: "0x5678" as Hex }),
      sendSucceeds: false,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(() => signTransaction.mock.calls.length === 1, "fresh sign");
    await waitFor(() => vi.mocked(sendRawTransaction).mock.calls.length === 1, "send attempt");

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledWith(BORROWER, MARKET_ID);
  });

  it("signs fresh without crashing when no PreSigner is wired", async () => {
    const { handler, signTransaction } = await createSubject({
      preSignerEnabled: false,
      sendSucceeds: true,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(() => signTransaction.mock.calls.length === 1, "fresh sign");
    await waitFor(() => vi.mocked(sendRawTransaction).mock.calls.length === 1, "send attempt");

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendRawTransaction)).toHaveBeenCalledWith(expect.anything(), {
      serializedTransaction: FRESH_SIGNED_TX,
    });
  });

  it("invalidates the cache after a successful broadcast", async () => {
    const { handler, signTransaction, preSignerSpies } = await createSubject({
      preSignerEnabled: true,
      sendSucceeds: true,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(
      () => (preSignerSpies?.invalidate.mock.calls.length ?? 0) === 1,
      "post-broadcast invalidate",
    );

    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledTimes(1);
    expect(preSignerSpies?.invalidate).toHaveBeenCalledWith(BORROWER, MARKET_ID);
  });

  it("increments presignHit counter when a cached tx is reused", async () => {
    const cachedTx = makeCachedTx();
    const { handler, preSignerSpies } = await createSubject({
      cachedTx,
      sendSucceeds: true,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(
      () => (preSignerSpies?.invalidate.mock.calls.length ?? 0) === 1,
      "post-broadcast invalidate",
    );

    // Access private counter via type cast
    const mutable = handler as unknown as { presignHit: number };
    expect(mutable.presignHit).toBe(1);
  });

  it("increments miss_stale counter when cached tx is stale", async () => {
    const { handler, signTransaction } = await createSubject({
      cachedTx: makeCachedTx({ createdAt: Date.now() - 30_001 }),
      sendSucceeds: true,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(() => signTransaction.mock.calls.length === 1, "fresh sign");

    const mutable = handler as unknown as { miss_stale: number };
    expect(mutable.miss_stale).toBe(1);
  });

  it("emits [PreSignMetrics] log line and resets counters", async () => {
    const { handler } = await createSubject({
      preSignerEnabled: false,
      sendSucceeds: true,
    });

    // Manually poke counters to simulate accumulated data
    const mutable = handler as unknown as {
      presignHit: number;
      miss_stale: number;
      miss_nonce: number;
      miss_calldata: number;
      miss_gas: number;
      miss_fee: number;
      miss_tip: number;
      cold_no_cache: number;
      batchCount: number;
      coldSignLatencyMs: number[];
      presignHitLatencyMs: number[];
      _emitPreSignMetrics: () => void;
    };
    mutable.presignHit = 3;
    mutable.miss_stale = 1;
    mutable.batchCount = 2;
    mutable.coldSignLatencyMs = [10, 20];
    mutable.presignHitLatencyMs = [1, 2];

    const consoleSpy = vi.spyOn(console, "log");

    mutable._emitPreSignMetrics();

    const emitted = consoleSpy.mock.calls
      .flat()
      .find((arg) => typeof arg === "string" && arg.includes("[PreSignMetrics]"));
    expect(emitted).toBeDefined();
    expect(emitted as string).toContain("hit=3");
    expect(emitted as string).toContain("miss_stale=1");
    expect(emitted as string).toContain("batches=2");
    expect(emitted as string).toContain("coldSignAvgMs=15.00");
    expect(emitted as string).toContain("hitReadAvgMs=1.50");

    // Counters should be reset after emit
    expect(mutable.presignHit).toBe(0);
    expect(mutable.batchCount).toBe(0);
    expect(mutable.coldSignLatencyMs).toHaveLength(0);
  });
});
