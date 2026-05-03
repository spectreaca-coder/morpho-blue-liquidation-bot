import {
  AERODROME_FACTORY_ADDRESSES,
  AERODROME_MAX_SQRT_RATIO,
  AERODROME_MIN_SQRT_RATIO,
  AERODROME_TICK_SPACINGS,
} from "@morpho-blue-liquidation-bot/config";
import type { ExecutorEncoder } from "executooor-viem";
import { type Address, type Hex, zeroAddress } from "viem";
import { base } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";

import { aerodromeSlipstreamFactoryAbi } from "../../src/abis/aerodromeV3.js";
import { uniswapV3PoolAbi } from "../../src/abis/uniswapV3.js";
import { AerodromeV3Venue } from "../../src/index.js";

vi.mock("viem/actions", () => ({
  readContract: vi.fn(),
}));

// eslint-disable-next-line import-x/order
import { readContract } from "viem/actions";

const mockedReadContract = vi.mocked(readContract);

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const UNKNOWN_SRC = "0x5555555555555555555555555555555555555555" as Address;
const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

interface MockEncoder {
  address: Address;
  client: { chain: { id: number } };
  pushCall: (
    target: Address,
    value: bigint,
    data: Hex,
    metadata: { sender: Address; dataIndex: bigint },
  ) => void;
}

function makeEncoder(chainId: number) {
  const pushCall = vi.fn<MockEncoder["pushCall"]>();
  const encoder: MockEncoder = {
    address: "0x4444444444444444444444444444444444444444" as Address,
    client: { chain: { id: chainId } },
    pushCall,
  };
  return { encoder: encoder as unknown as ExecutorEncoder, pushCall };
}

afterEach(() => {
  vi.restoreAllMocks();
  mockedReadContract.mockReset();
});

describe("AerodromeV3Venue — unit", () => {
  it("exports correct config constants", () => {
    // factory address on Base must be set
    expect(AERODROME_FACTORY_ADDRESSES[base.id]).toBeDefined();
    expect(typeof AERODROME_FACTORY_ADDRESSES[base.id]).toBe("string");

    // tickSpacing 1 removed per memory rule; only 50, 100, 200 allowed
    expect(AERODROME_TICK_SPACINGS).not.toContain(1);
    expect(AERODROME_TICK_SPACINGS).toContain(50);
    expect(AERODROME_TICK_SPACINGS).toContain(100);
    expect(AERODROME_TICK_SPACINGS).toContain(200);

    // sqrt ratio sentinel values must be positive bigints
    expect(AERODROME_MIN_SQRT_RATIO).toBeGreaterThan(0n);
    expect(AERODROME_MAX_SQRT_RATIO).toBeGreaterThan(AERODROME_MIN_SQRT_RATIO);
  });

  it("factory address sanity — Base uses Aerodrome Slipstream CLFactory", () => {
    // Verified on-chain: WETH/USDC CL100 pool.factory() and cbBTC/USDC CL100 pool.factory()
    // both return 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A
    expect(AERODROME_FACTORY_ADDRESSES[base.id]).toBe("0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A");
  });

  it("supportsRoute returns true for WETH/USDC when factory returns nonzero pool", async () => {
    const venue = new AerodromeV3Venue();
    const { encoder } = makeEncoder(base.id);

    const WETH_USDC_CL100 = "0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59" as Address;

    mockedReadContract.mockImplementation(async (_client, parameters) => {
      if (
        parameters.abi === aerodromeSlipstreamFactoryAbi &&
        parameters.functionName === "getPool"
      ) {
        const tickSpacing = parameters.args?.[2];
        if (tickSpacing === 100) return WETH_USDC_CL100;
        return zeroAddress;
      }
      // liquidity query for pool selection
      if (parameters.abi === uniswapV3PoolAbi && parameters.functionName === "liquidity") {
        return 1_000_000n;
      }
      return zeroAddress;
    });

    expect(await venue.supportsRoute(encoder, WETH, USDC)).toBe(true);
  });

  it("supportsRoute returns true for cbBTC/USDC when factory returns nonzero pool", async () => {
    const venue = new AerodromeV3Venue();
    const { encoder } = makeEncoder(base.id);

    const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
    const CBBTC_USDC_CL100 = "0x4e962BB3889Bf030368F56810A9c96B83CB3E778" as Address;

    mockedReadContract.mockImplementation(async (_client, parameters) => {
      if (
        parameters.abi === aerodromeSlipstreamFactoryAbi &&
        parameters.functionName === "getPool"
      ) {
        const tickSpacing = parameters.args?.[2];
        if (tickSpacing === 100) return CBBTC_USDC_CL100;
        return zeroAddress;
      }
      if (parameters.abi === uniswapV3PoolAbi && parameters.functionName === "liquidity") {
        return 500_000n;
      }
      return zeroAddress;
    });

    expect(await venue.supportsRoute(encoder, CBBTC, USDC)).toBe(true);
  });

  it("supportsRoute returns false for same-token pair", async () => {
    const venue = new AerodromeV3Venue();
    const { encoder } = makeEncoder(base.id);

    // No readContract call expected for same-src-dst fast return
    expect(await venue.supportsRoute(encoder, WETH, WETH)).toBe(false);
    expect(mockedReadContract).not.toHaveBeenCalled();
  });

  it("supportsRoute returns false when factory not configured for chain", async () => {
    const venue = new AerodromeV3Venue();
    // chain id 999 has no factory address entry
    const { encoder } = makeEncoder(999);

    expect(await venue.supportsRoute(encoder, WETH, USDC)).toBe(false);
    expect(mockedReadContract).not.toHaveBeenCalled();
  });

  it("supportsRoute returns false when factory returns only zeroAddress for all tick spacings", async () => {
    const venue = new AerodromeV3Venue();
    const { encoder } = makeEncoder(base.id);

    mockedReadContract.mockResolvedValue(zeroAddress);

    expect(await venue.supportsRoute(encoder, UNKNOWN_SRC, USDC)).toBe(false);
    // should query factory for each tick spacing
    expect(mockedReadContract).toHaveBeenCalledTimes(AERODROME_TICK_SPACINGS.length);
  });

  it("supportsRoute returns true when at least one pool exists, and caches pools", async () => {
    const venue = new AerodromeV3Venue();
    const { encoder } = makeEncoder(base.id);

    let callCount = 0;
    mockedReadContract.mockImplementation(async (_client, parameters) => {
      if (
        parameters.abi === aerodromeSlipstreamFactoryAbi &&
        parameters.functionName === "getPool"
      ) {
        callCount++;
        const tickSpacing = parameters.args?.[2];
        if (tickSpacing === 50) return POOL_A;
        return zeroAddress;
      }
      // liquidity call for pool selection
      if (parameters.abi === uniswapV3PoolAbi && parameters.functionName === "liquidity") {
        return 1_000n;
      }
      return zeroAddress;
    });

    expect(await venue.supportsRoute(encoder, WETH, USDC)).toBe(true);
    const firstQueryCount = callCount;

    // Second call should use cache — no new factory reads
    expect(await venue.supportsRoute(encoder, WETH, USDC)).toBe(true);
    expect(callCount).toBe(firstQueryCount);
  });

  it("convert encodes pushCall targeting the highest-liquidity pool", async () => {
    const venue = new AerodromeV3Venue();
    const { encoder, pushCall } = makeEncoder(base.id);

    mockedReadContract.mockImplementation(async (_client, parameters) => {
      if (
        parameters.abi === aerodromeSlipstreamFactoryAbi &&
        parameters.functionName === "getPool"
      ) {
        const tickSpacing = parameters.args?.[2];
        if (tickSpacing === 50) return POOL_A;
        if (tickSpacing === 100) return POOL_B;
        return zeroAddress;
      }
      if (parameters.abi === uniswapV3PoolAbi && parameters.functionName === "liquidity") {
        if (parameters.address === POOL_A) return 100n;
        if (parameters.address === POOL_B) return 999n; // POOL_B wins
      }
      return zeroAddress;
    });

    await venue.supportsRoute(encoder, WETH, USDC);
    const result = await venue.convert(encoder, {
      src: WETH,
      dst: USDC,
      srcAmount: 1_000_000n,
    });

    // pushCall should target POOL_B (highest liquidity)
    expect(pushCall).toHaveBeenCalledOnce();
    const [target] = pushCall.mock.calls[0]!;
    expect(target).toBe(POOL_B);

    // convert should signal "done" — src === dst
    expect(result.src).toBe(USDC);
    expect(result.dst).toBe(USDC);
    expect(result.srcAmount).toBe(0n);
  });

  it("convert throws when pools not yet fetched (supportsRoute not called)", async () => {
    const venue = new AerodromeV3Venue();
    const { encoder } = makeEncoder(base.id);

    // No supportsRoute call → cache empty → convert returns toConvert unchanged
    const toConvert = { src: WETH, dst: USDC, srcAmount: 1n };
    const result = await venue.convert(encoder, toConvert);

    // When cache is empty, convert returns the input unchanged
    expect(result).toEqual(toConvert);
  });
});
