import type { CbXrpPoolAwareConfig } from "@morpho-blue-liquidation-bot/config";
import type { ToConvert } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { UniswapV3Venue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Address, Hex } from "viem";
import { readContract } from "viem/actions";
import { base } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";

const liquidityVenueMocks = vi.hoisted(() => ({
  buildUniswapV3Path: vi.fn(),
  encodeUniswapV3RouterExactInput: vi.fn(),
  estimateUniswapV3MaxSwapIn: vi.fn(),
  getUniswapV3SpotAmountOut: vi.fn(),
  readUniswapV3PoolSnapshot: vi.fn(),
}));

const swapQuoterMocks = vi.hoisted(() => ({
  checkSwapQuoteGate: vi.fn(),
  quoteOneInchOut: vi.fn(),
  quoteFixedUniswapV3Route: vi.fn(),
  raceClearingSwapQuotes: vi.fn(),
}));

vi.mock("@morpho-blue-liquidation-bot/liquidity-venues", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@morpho-blue-liquidation-bot/liquidity-venues")>();
  return {
    ...actual,
    buildUniswapV3Path: liquidityVenueMocks.buildUniswapV3Path,
    encodeUniswapV3RouterExactInput: liquidityVenueMocks.encodeUniswapV3RouterExactInput,
    estimateUniswapV3MaxSwapIn: liquidityVenueMocks.estimateUniswapV3MaxSwapIn,
    getUniswapV3SpotAmountOut: liquidityVenueMocks.getUniswapV3SpotAmountOut,
    readUniswapV3PoolSnapshot: liquidityVenueMocks.readUniswapV3PoolSnapshot,
  };
});

vi.mock("../../src/utils/swapQuoter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/swapQuoter.js")>();
  return {
    ...actual,
    checkSwapQuoteGate: swapQuoterMocks.checkSwapQuoteGate,
    quoteOneInchOut: swapQuoterMocks.quoteOneInchOut,
    quoteFixedUniswapV3Route: swapQuoterMocks.quoteFixedUniswapV3Route,
    raceClearingSwapQuotes: swapQuoterMocks.raceClearingSwapQuotes,
  };
});

vi.mock("viem/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/actions")>();
  return {
    ...actual,
    readContract: vi.fn(),
  };
});

import { type CachedPosition, type PositionCache } from "../../src/position-cache.js";
import { TxCache, applyCbXrpPoolAwareCap } from "../../src/tx-cache.js";
import { resolveShareLiquidationPlan } from "../../src/utils/morphoLiquidation.js";

const BORROWER = "0x1111111111111111111111111111111111111111" as Address;
const EXECUTOR = "0x2222222222222222222222222222222222222222" as Address;
const TREASURY = "0x3333333333333333333333333333333333333333" as Address;
const ORACLE = "0x4444444444444444444444444444444444444444" as Address;
const IRM = "0x5555555555555555555555555555555555555555" as Address;
const CBXRP = "0xcb585250f852C6c6bf90434AB21A00f02833a4af" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
const DIRECT_POOL = "0x3733cbB1402C788900A0A152e61c9aA31888FB95" as Address;
const CBXRP_WETH_POOL = "0x6ceFe2a691b1734042c10958B8E0EC19D81b2850" as Address;
const WETH_USDC_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as Address;
const CBXRP_MARKET_ID = "0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109" as Hex;
const NON_CBXRP_MARKET_ID =
  "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as Hex;
const ORACLE_PRICE = 64643715318620483239000000000000000000000n;
const stubClient = { chain: base } as Parameters<typeof applyCbXrpPoolAwareCap>[0]["client"];

const REALISTIC_MARKET = {
  borrowShares: 674722025n,
  collateral: 10969n,
  totalBorrowAssets: 4479803533167n,
  totalBorrowShares: 4449640271686n,
  price: ORACLE_PRICE,
  lltv: 860000000000000000n,
};

const CBXRP_POOL_AWARE: CbXrpPoolAwareConfig = {
  marketId: CBXRP_MARKET_ID,
  slippageBudgetBps: 100,
  router: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address,
  direct: {
    pool: DIRECT_POOL,
    fee: 10_000,
  },
  fallback: {
    cbXrpToWeth: {
      pool: CBXRP_WETH_POOL,
      fee: 10_000,
    },
    wethToUsdc: {
      pool: WETH_USDC_POOL,
      fee: 500,
    },
  },
};

function makeRequestedPlan() {
  const plan = resolveShareLiquidationPlan({
    ...REALISTIC_MARKET,
    targetSeizedAssets: REALISTIC_MARKET.collateral,
  });
  if (plan === null) {
    throw new Error("expected requestedPlan fixture to resolve");
  }
  return plan;
}

function makeDepthEstimate(maxSwapIn: bigint) {
  return {
    pool: DIRECT_POOL,
    token0: CBXRP,
    token1: USDC,
    sqrtPriceX96: 2n ** 96n,
    tick: 0,
    liquidity: 25_000n,
    tickSpacing: 200,
    maxSwapIn,
    ticksCrossed: 1,
  };
}

function makePoolSnapshot(pool: Address) {
  if (pool.toLowerCase() === CBXRP_WETH_POOL.toLowerCase()) {
    return {
      pool,
      token0: CBXRP,
      token1: WETH,
      sqrtPriceX96: 2n ** 96n,
      tick: 10,
      liquidity: 15_000n,
      tickSpacing: 200,
    };
  }

  return {
    pool,
    token0: WETH,
    token1: USDC,
    sqrtPriceX96: 2n ** 96n,
    tick: 20,
    liquidity: 20_000n,
    tickSpacing: 10,
  };
}

function makeCbXrpParams() {
  const requestedPlan = makeRequestedPlan();

  return {
    requestedPlan,
    params: {
      client: stubClient,
      borrower: BORROWER,
      marketId: CBXRP_MARKET_ID,
      collateralToken: CBXRP,
      loanToken: USDC,
      requestedPlan,
      totalBorrowAssets: REALISTIC_MARKET.totalBorrowAssets,
      totalBorrowShares: REALISTIC_MARKET.totalBorrowShares,
      price: REALISTIC_MARKET.price,
      lltv: REALISTIC_MARKET.lltv,
      quoteGateBufferBps: 100,
      cbXrpPoolAware: CBXRP_POOL_AWARE,
    },
  };
}

function makeNonCbXrpPosition(): CachedPosition {
  return {
    borrower: BORROWER,
    marketId: NON_CBXRP_MARKET_ID,
    collateral: REALISTIC_MARKET.collateral,
    borrowShares: REALISTIC_MARKET.borrowShares,
    totalBorrowAssets: REALISTIC_MARKET.totalBorrowAssets,
    totalBorrowShares: REALISTIC_MARKET.totalBorrowShares,
    lltv: REALISTIC_MARKET.lltv,
    oracleAddress: ORACLE.toLowerCase(),
    collateralSymbol: "cbBTC",
    loanSymbol: "USDC",
    collateralDecimals: 8,
    loanDecimals: 6,
    loanToken: USDC,
    collateralToken: CBBTC,
    oracle: ORACLE,
    irm: IRM,
    apiHealthFactor: 0.99,
  };
}

function makeCbXrpPosition(): CachedPosition {
  return {
    ...makeNonCbXrpPosition(),
    marketId: CBXRP_MARKET_ID,
    collateralSymbol: "cbXRP",
    collateralToken: CBXRP,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  liquidityVenueMocks.buildUniswapV3Path.mockImplementation(
    (_firstToken: Address, hops: { fee: number; tokenOut: Address }[]) =>
      (hops.length === 1 ? "0x1111" : "0x2222") as Hex,
  );
  liquidityVenueMocks.encodeUniswapV3RouterExactInput.mockImplementation(() => undefined);
  liquidityVenueMocks.estimateUniswapV3MaxSwapIn.mockResolvedValue(makeDepthEstimate(9_500n));
  liquidityVenueMocks.getUniswapV3SpotAmountOut.mockImplementation(
    (_snapshot: unknown, _tokenIn: Address, amountIn: bigint) => amountIn * 2n,
  );
  liquidityVenueMocks.readUniswapV3PoolSnapshot.mockImplementation(
    async (_client: unknown, pool: Address) => makePoolSnapshot(pool),
  );

  swapQuoterMocks.checkSwapQuoteGate.mockResolvedValue({ pass: true, expectedSwapOut: 0n });
  swapQuoterMocks.quoteOneInchOut.mockResolvedValue(null);
  swapQuoterMocks.quoteFixedUniswapV3Route.mockImplementation(
    async ({ hops }: { hops: { tokenIn: Address; tokenOut: Address; fee: number }[] }) => ({
      expectedOut: 10n ** 30n,
      initializedTicksCrossed: hops.length,
      predictedSlippageBps: hops.length === 1 ? 25 : 40,
    }),
  );
  swapQuoterMocks.raceClearingSwapQuotes.mockResolvedValue({
    winnerVenue: null,
    expectedOut: 0n,
    bestObservedOut: 0n,
    quotesByVenue: {},
    timedOutVenues: [],
    usedFallback: false,
  });

  vi.mocked(readContract).mockResolvedValue(ORACLE_PRICE);
});

describe("cbXRP pool-aware cap", () => {
  it("caps liquidation size from the direct pool depth snapshot", async () => {
    const { requestedPlan, params } = makeCbXrpParams();
    liquidityVenueMocks.estimateUniswapV3MaxSwapIn.mockResolvedValue(makeDepthEstimate(5_000n));

    const decision = await applyCbXrpPoolAwareCap(params);

    expect(decision).not.toBeNull();
    expect(decision!.liquidationPlan.seizedAssets).toBeLessThanOrEqual(5_000n);
    expect(decision!.liquidationPlan.repaidShares).toBeLessThan(requestedPlan.repaidShares);
    expect(decision!.telemetry.directPoolSnapshot).toMatchObject({
      pool: DIRECT_POOL,
      liquidity: 25_000n,
      maxSwapIn: 5_000n,
    });
  });

  it("switches to the fixed two-hop route when direct impact breaches the threshold", async () => {
    const { params } = makeCbXrpParams();
    liquidityVenueMocks.estimateUniswapV3MaxSwapIn.mockResolvedValue(makeDepthEstimate(12_000n));
    swapQuoterMocks.quoteFixedUniswapV3Route.mockImplementation(
      async ({ hops }: { hops: { tokenIn: Address; tokenOut: Address; fee: number }[] }) => ({
        expectedOut: 10n ** 30n,
        initializedTicksCrossed: hops.length,
        predictedSlippageBps: hops.length === 1 ? 150 : 35,
      }),
    );

    const decision = await applyCbXrpPoolAwareCap(params);

    expect(decision).not.toBeNull();
    expect(decision!.path).toBe("0x2222");
    expect(decision!.telemetry.chosenRoute).toBe("fallback");
    expect(decision!.telemetry.fallbackPoolSnapshots).toHaveLength(2);
  });

  it("leaves non-cbXRP markets on the existing build path", async () => {
    const passthroughVenue = {
      supportsRoute: vi.fn().mockResolvedValue(true),
      convert: vi.fn(async (_encoder: unknown, toConvert: ToConvert) => ({
        ...toConvert,
        src: toConvert.dst,
      })),
    };
    const txCache = new TxCache({
      logTag: "[test] ",
      chainId: base.id,
      client: stubClient,
      positionCache: {} as unknown as PositionCache,
      executorAddress: EXECUTOR,
      treasuryAddress: TREASURY,
      liquidityVenues: [passthroughVenue],
      liquidationBufferBps: 0,
      quoteGateEnabled: true,
      quoteGateBufferBps: 100,
    });
    const position = makeNonCbXrpPosition();

    await txCache.build([position]);

    const prebuilt = txCache.get(position.borrower, position.marketId);
    expect(prebuilt).toBeDefined();
    expect(prebuilt?.swapTelemetry).toBeUndefined();
    expect(liquidityVenueMocks.estimateUniswapV3MaxSwapIn).not.toHaveBeenCalled();
  });

  it("includes predicted and realized slippage telemetry fields", async () => {
    const { params } = makeCbXrpParams();
    swapQuoterMocks.quoteFixedUniswapV3Route.mockResolvedValue({
      expectedOut: 10n ** 30n,
      initializedTicksCrossed: 1,
      predictedSlippageBps: 42,
    });

    const decision = await applyCbXrpPoolAwareCap(params);

    expect(decision).not.toBeNull();
    expect(decision!.telemetry).toMatchObject({
      predictedSlippageBps: 42,
      predictedExpectedOut: 10n ** 30n,
      realizedSwapOut: null,
      realizedSlippageBps: null,
      residualCbXrp: null,
    });
    expect("predictedSlippageBps" in decision!.telemetry).toBe(true);
    expect("realizedSlippageBps" in decision!.telemetry).toBe(true);
  });

  it("bypasses quote race for the cbXRP pool-aware path", async () => {
    const txCache = new TxCache({
      logTag: "[test] ",
      chainId: base.id,
      client: stubClient,
      positionCache: {} as unknown as PositionCache,
      executorAddress: EXECUTOR,
      treasuryAddress: TREASURY,
      liquidityVenues: [new UniswapV3Venue()],
      liquidationBufferBps: 0,
      quoteGateEnabled: true,
      quoteRaceEnabled: true,
      quoteGateBufferBps: 100,
    });

    await txCache.build([makeCbXrpPosition()]);

    expect(txCache.get(BORROWER, CBXRP_MARKET_ID)).toBeDefined();
    expect(swapQuoterMocks.raceClearingSwapQuotes).not.toHaveBeenCalled();
  });
});
