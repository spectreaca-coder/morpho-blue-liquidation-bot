import type { ChainConfig, PendingPrewarmFeedMap } from "@morpho-blue-liquidation-bot/config";
import type { Address, Hex } from "viem";
import { getGasPrice, getTransactionCount, sendRawTransaction } from "viem/actions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiquidationBot } from "../../src/bot.js";
import { FlashblockHandler } from "../../src/flashblock-handler.js";
import type { OracleUpdateEvent } from "../../src/flashblock-watcher.js";
import { setFlashblockLastEventMs } from "../../src/health.js";
import type { PositionCache } from "../../src/position-cache.js";
import type { PreSigner } from "../../src/preSigner.js";
import type { PrimaryWalletCoordinator } from "../../src/primary-wallet-coordinator.js";
import { type PrebuiltTx, TxCache } from "../../src/tx-cache.js";

vi.mock("viem/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/actions")>();
  return {
    ...actual,
    getGasPrice: vi.fn(),
    getTransactionCount: vi.fn(),
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

const WALLET_ADDRESS = "0x3000000000000000000000000000000000000003" as Address;
const EXECUTOR_ADDRESS = "0x2000000000000000000000000000000000000002" as Address;
const BTC_AGGREGATOR = "0x0e3dc8a6a86d2f6f5f67b373a047c267fb1fc3e6";
const ETH_AGGREGATOR = "0x1e0b2c3896338fbb201c4f0a27c6904801dca06b";
const OTHER_AGGREGATOR = "0x0ee7145e1370653533e2f2e824424be2aa95a4aa";
const BTC_MARKET = `0x${"11".repeat(32)}`;
const ETH_MARKET = `0x${"22".repeat(32)}`;
const CBETH_MARKET = `0x${"33".repeat(32)}`;
const DEFAULT_RAW_TX = "0x1234";

const handlers: FlashblockHandler[] = [];

function makePendingFeeds(): PendingPrewarmFeedMap {
  return {
    [BTC_AGGREGATOR]: {
      feedName: "BTC/USD",
      marketIds: [BTC_MARKET],
    },
    [ETH_AGGREGATOR]: {
      feedName: "ETH/USD",
      marketIds: [ETH_MARKET, CBETH_MARKET],
    },
  };
}

function makeEvent(overrides: Partial<OracleUpdateEvent> = {}): OracleUpdateEvent {
  return {
    aggregatorAddress: ETH_AGGREGATOR,
    blockNumber: 0,
    flashblockIndex: 0,
    detectedAt: new Date().toISOString(),
    rawTx: DEFAULT_RAW_TX,
    extractedPrice: undefined,
    source: "alchemy-pending",
    ...overrides,
  };
}

function makePrebuilt(borrower: Address, marketId: Hex): PrebuiltTx {
  return {
    borrower,
    marketId,
    collateralSymbol: "WETH",
    loanSymbol: "USDC",
    lltv: 850_000_000_000_000_000n,
    calls: ["0x1234" as Hex],
    borrowAssets: 20_000_000n,
    seizableCollateral: 1_000_000_000_000_000_000n,
    builtAt: Date.now(),
  };
}

function makeCandidate(args: {
  borrower: Address;
  marketId: Hex;
  collateralSymbol?: string;
  borrowAssets: bigint;
}) {
  return {
    position: {
      borrower: args.borrower,
      marketId: args.marketId,
      collateralSymbol: args.collateralSymbol ?? "WETH",
      loanSymbol: "USDC",
      loanDecimals: 6,
    },
    healthFactor: 0n,
    borrowAssets: args.borrowAssets,
    seizableCollateral: 1_000_000_000_000_000_000n,
  };
}

async function nextTick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await nextTick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function createSubject(options?: {
  chainId?: number;
  pendingPrewarmFeeds?: PendingPrewarmFeedMap;
  candidates?: ReturnType<typeof makeCandidate>[];
  isBusy?: boolean;
}) {
  const candidates = options?.candidates ?? [];
  const preSigner = {
    presign: vi.fn().mockResolvedValue("0xdeadbeef" as Hex),
    get: vi.fn(),
    invalidate: vi.fn(),
  } as unknown as PreSigner;

  const txCache = {
    rebuildOne: vi.fn().mockResolvedValue(undefined),
    get: vi.fn((borrower: Address, marketId: Hex) => makePrebuilt(borrower, marketId)),
  } as unknown as TxCache;

  const positionCache = {
    findNearLiquidation: vi.fn().mockReturnValue(candidates),
    findLiquidatableByPrice: vi.fn().mockReturnValue([]),
    findByCollateralSymbol: vi.fn().mockReturnValue([]),
  } as unknown as PositionCache;

  const coordinator = {
    client: {
      account: { address: WALLET_ADDRESS },
      signTransaction: vi.fn().mockResolvedValue("0xfeed" as Hex),
    },
    executorAddress: EXECUTOR_ADDRESS,
    isBusy: options?.isBusy ?? false,
    tryAcquire: vi.fn(),
    nextNonce: vi.fn(),
    reserveNonce: vi.fn().mockResolvedValue(9),
    releaseReservedNonce: vi.fn(),
    rollbackNonce: vi.fn(),
    resetNonceCache: vi.fn(),
    release: vi.fn(),
  } as unknown as PrimaryWalletCoordinator;

  const bot = {
    fastLiquidate: vi.fn(),
  } as unknown as LiquidationBot;

  const handler = new FlashblockHandler(
    "[test] ",
    {
      chainId: options?.chainId ?? 8453,
      pendingPrewarmFeeds: options?.pendingPrewarmFeeds,
    } as ChainConfig,
    bot,
    positionCache,
    txCache,
    coordinator,
    undefined,
    undefined,
    preSigner,
    options?.pendingPrewarmFeeds,
  );

  handlers.push(handler);
  await nextTick();

  return {
    handler,
    preSigner,
    txCache,
    positionCache,
    coordinator,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: vi.fn() }));
  vi.mocked(getGasPrice).mockResolvedValue(1_000_000_000n);
  vi.mocked(getTransactionCount).mockResolvedValue(9);
});

afterEach(() => {
  while (handlers.length > 0) {
    handlers.pop()?.dispose();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FlashblockHandler pending prewarm", () => {
  it("routes alchemy-pending events to the pending branch without touching canonical state", async () => {
    const { handler } = await createSubject({
      pendingPrewarmFeeds: makePendingFeeds(),
    });
    const pendingSpy = vi
      .spyOn(
        handler as unknown as { handlePendingOracleUpdate: (event: OracleUpdateEvent) => void },
        "handlePendingOracleUpdate",
      )
      .mockImplementation(() => undefined);

    const event = makeEvent();
    handler.handleOracleUpdate(event);

    expect(pendingSpy).toHaveBeenCalledTimes(1);
    expect(pendingSpy).toHaveBeenCalledWith(event);
    expect(vi.mocked(setFlashblockLastEventMs)).not.toHaveBeenCalled();
    expect(
      (
        handler as unknown as {
          lastBlockByAggregator: Map<string, number>;
        }
      ).lastBlockByAggregator.size,
    ).toBe(0);
  });

  it("keeps canonical events on the existing liveness path", async () => {
    const { handler, positionCache } = await createSubject({
      pendingPrewarmFeeds: makePendingFeeds(),
    });

    handler.handleOracleUpdate(
      makeEvent({
        source: undefined,
        blockNumber: 123,
        extractedPrice: 200_000_000_000n,
      }),
    );

    expect(vi.mocked(setFlashblockLastEventMs)).toHaveBeenCalledTimes(1);
    expect(
      (
        handler as unknown as {
          lastBlockByAggregator: Map<string, number>;
        }
      ).lastBlockByAggregator.get(ETH_AGGREGATOR),
    ).toBe(123);
    expect(
      (
        positionCache as unknown as {
          findLiquidatableByPrice: ReturnType<typeof vi.fn>;
        }
      ).findLiquidatableByPrice,
    ).toHaveBeenCalledTimes(1);
  });

  it("dedups identical pending txs for 5 seconds, then allows a new prewarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    const topCandidate = makeCandidate({
      borrower: "0x1000000000000000000000000000000000000001" as Address,
      marketId: ETH_MARKET,
      borrowAssets: 30_000_000n,
    });
    const { handler, preSigner } = await createSubject({
      pendingPrewarmFeeds: makePendingFeeds(),
      candidates: [topCandidate],
    });

    handler.handleOracleUpdate(makeEvent({ rawTx: "0xaaaa" }));
    await waitFor(
      () =>
        (
          preSigner as unknown as {
            presign: ReturnType<typeof vi.fn>;
          }
        ).presign.mock.calls.length === 1,
      "first presign",
    );

    handler.handleOracleUpdate(makeEvent({ rawTx: "0xaaaa" }));
    await nextTick();

    expect(
      (
        preSigner as unknown as {
          presign: ReturnType<typeof vi.fn>;
        }
      ).presign,
    ).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);
    handler.handleOracleUpdate(makeEvent({ rawTx: "0xaaaa" }));

    await waitFor(
      () =>
        (
          preSigner as unknown as {
            presign: ReturnType<typeof vi.fn>;
          }
        ).presign.mock.calls.length === 2,
      "second presign after ttl",
    );
  });

  it("ignores pending aggregators that are not in pendingPrewarmFeeds", async () => {
    const candidate = makeCandidate({
      borrower: "0x1000000000000000000000000000000000000001" as Address,
      marketId: ETH_MARKET,
      borrowAssets: 30_000_000n,
    });
    const { handler, preSigner, txCache } = await createSubject({
      pendingPrewarmFeeds: makePendingFeeds(),
      candidates: [candidate],
    });

    handler.handleOracleUpdate(
      makeEvent({
        aggregatorAddress: OTHER_AGGREGATOR,
      }),
    );
    await nextTick();

    expect(
      (
        txCache as unknown as {
          rebuildOne: ReturnType<typeof vi.fn>;
        }
      ).rebuildOne,
    ).not.toHaveBeenCalled();
    expect(
      (
        preSigner as unknown as {
          presign: ReturnType<typeof vi.fn>;
        }
      ).presign,
    ).not.toHaveBeenCalled();
  });

  it("pre-signs only the top candidate even when multiple near-liquidation positions match", async () => {
    const firstBorrower = "0x1000000000000000000000000000000000000001" as Address;
    const secondBorrower = "0x1000000000000000000000000000000000000002" as Address;
    const thirdBorrower = "0x1000000000000000000000000000000000000003" as Address;
    const candidates = [
      makeCandidate({ borrower: firstBorrower, marketId: ETH_MARKET, borrowAssets: 30_000_000n }),
      makeCandidate({
        borrower: secondBorrower,
        marketId: CBETH_MARKET,
        borrowAssets: 20_000_000n,
      }),
      makeCandidate({ borrower: thirdBorrower, marketId: ETH_MARKET, borrowAssets: 10_000_000n }),
    ];
    const { handler, preSigner, txCache } = await createSubject({
      pendingPrewarmFeeds: makePendingFeeds(),
      candidates,
    });

    handler.handleOracleUpdate(makeEvent());

    await waitFor(
      () =>
        (
          preSigner as unknown as {
            presign: ReturnType<typeof vi.fn>;
          }
        ).presign.mock.calls.length === 1,
      "single top presign",
    );

    expect(
      (
        txCache as unknown as {
          rebuildOne: ReturnType<typeof vi.fn>;
        }
      ).rebuildOne,
    ).toHaveBeenCalledTimes(1);
    expect(
      (
        txCache as unknown as {
          rebuildOne: ReturnType<typeof vi.fn>;
        }
      ).rebuildOne,
    ).toHaveBeenCalledWith(firstBorrower, ETH_MARKET);
    expect(
      (
        preSigner as unknown as {
          presign: ReturnType<typeof vi.fn>;
        }
      ).presign,
    ).toHaveBeenCalledTimes(1);
    const presignCall = (
      preSigner as unknown as {
        presign: ReturnType<typeof vi.fn>;
      }
    ).presign.mock.calls[0];
    expect(presignCall).toBeDefined();
    expect(presignCall?.[0]).toBe(firstBorrower);
    expect(presignCall?.[1]).toBe(ETH_MARKET);
    expect(presignCall?.[2]).toBe(TxCache.encodeCalldata(makePrebuilt(firstBorrower, ETH_MARKET)));
    expect(presignCall?.[3]).toBe(9);
    expect(presignCall?.[4]).toBe(700_000n);
    expect(typeof presignCall?.[5]).toBe("bigint");
    expect(typeof presignCall?.[6]).toBe("bigint");
  });

  it("skips pending prewarm when wallet[0] is already leased", async () => {
    const candidate = makeCandidate({
      borrower: "0x1000000000000000000000000000000000000001" as Address,
      marketId: ETH_MARKET,
      borrowAssets: 30_000_000n,
    });
    const { handler, preSigner, txCache } = await createSubject({
      pendingPrewarmFeeds: makePendingFeeds(),
      candidates: [candidate],
      isBusy: true,
    });

    handler.handleOracleUpdate(makeEvent());
    await nextTick();

    expect(
      (
        txCache as unknown as {
          rebuildOne: ReturnType<typeof vi.fn>;
        }
      ).rebuildOne,
    ).not.toHaveBeenCalled();
    expect(
      (
        preSigner as unknown as {
          presign: ReturnType<typeof vi.fn>;
        }
      ).presign,
    ).not.toHaveBeenCalled();
  });

  it("never submits transactions from the pending branch", async () => {
    const candidate = makeCandidate({
      borrower: "0x1000000000000000000000000000000000000001" as Address,
      marketId: BTC_MARKET,
      collateralSymbol: "cbBTC",
      borrowAssets: 40_000_000n,
    });
    const { handler, preSigner } = await createSubject({
      pendingPrewarmFeeds: makePendingFeeds(),
      candidates: [candidate],
    });

    handler.handleOracleUpdate(
      makeEvent({
        aggregatorAddress: BTC_AGGREGATOR,
      }),
    );

    await waitFor(
      () =>
        (
          preSigner as unknown as {
            presign: ReturnType<typeof vi.fn>;
          }
        ).presign.mock.calls.length === 1,
      "pending presign",
    );

    expect(vi.mocked(sendRawTransaction)).not.toHaveBeenCalled();
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
