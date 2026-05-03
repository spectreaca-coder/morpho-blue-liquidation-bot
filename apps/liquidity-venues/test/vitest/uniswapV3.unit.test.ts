import { MIN_SQRT_RATIO } from "@morpho-blue-liquidation-bot/config";
import { executorAbi } from "executooor-viem";
import type { ExecutorEncoder } from "executooor-viem";
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
  zeroAddress,
} from "viem";
import { readContract } from "viem/actions";
import { base } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from "../../src/abis/uniswapV3.js";
import { UniswapV3Venue } from "../../src/index.js";

vi.mock("viem/actions", () => ({
  readContract: vi.fn(),
}));

const mockedReadContract = vi.mocked(readContract);

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const UNKNOWN_SRC = "0x5555555555555555555555555555555555555555" as Address;
const WETH_USDC_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as Address;
const UNKNOWN_POOL_500 = "0x1111111111111111111111111111111111111111" as Address;
const UNKNOWN_POOL_3000 = "0x2222222222222222222222222222222222222222" as Address;
const UNKNOWN_POOL_10000 = "0x3333333333333333333333333333333333333333" as Address;

interface MockEncoder {
  address: Address;
  client: {
    chain: { id: number };
  };
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
    client: {
      chain: { id: chainId },
    },
    pushCall,
  };

  return {
    encoder: encoder as unknown as ExecutorEncoder,
    pushCall,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mockedReadContract.mockReset();
});

describe("uniswapV3 liquidity venue unit", () => {
  it("uses the Base WETH/USDC known pool fast path", async () => {
    const liquidityVenue = new UniswapV3Venue();
    const { encoder, pushCall } = makeEncoder(base.id);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const srcAmount = 1_000_000n;

    expect(await liquidityVenue.supportsRoute(encoder, WETH, USDC)).toBe(true);

    await liquidityVenue.convert(encoder, {
      src: WETH,
      dst: USDC,
      srcAmount,
    });

    expect(mockedReadContract).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `[uniV3.convert] src=${WETH} dst=${USDC} pools.len=1 knownPool=${WETH_USDC_POOL}`,
      ),
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("fastPath=true"));

    const encodedContext =
      `0x${0n.toString(16).padStart(24, "0") + zeroAddress.substring(2)}` as const;
    const callbacks = [
      encodeFunctionData({
        abi: executorAbi,
        functionName: "call_g0oyU7o",
        args: [
          WETH,
          0n,
          encodedContext,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [WETH_USDC_POOL, srcAmount],
          }),
        ],
      }),
    ];

    expect(pushCall).toHaveBeenCalledWith(
      WETH_USDC_POOL,
      0n,
      encodeFunctionData({
        abi: uniswapV3PoolAbi,
        functionName: "swap",
        args: [
          "0x4444444444444444444444444444444444444444",
          true,
          srcAmount,
          MIN_SQRT_RATIO + 1n,
          encodeAbiParameters([{ type: "bytes[]" }, { type: "bytes" }], [callbacks, "0x"]),
        ],
      }),
      {
        sender: WETH_USDC_POOL,
        dataIndex: 2n,
      },
    );
  });

  it("resolves an unknown pair through the registry slow path", async () => {
    const liquidityVenue = new UniswapV3Venue();
    const { encoder, pushCall } = makeEncoder(base.id);
    const srcAmount = 2_000_000n;

    mockedReadContract.mockImplementation(async (client, parameters) => {
      if (parameters.abi === uniswapV3FactoryAbi && parameters.functionName === "getPool") {
        const fee = parameters.args[2];
        if (fee === 500) return UNKNOWN_POOL_500;
        if (fee === 3000) return UNKNOWN_POOL_3000;
        if (fee === 10000) return UNKNOWN_POOL_10000;
      }

      if (parameters.abi === uniswapV3PoolAbi && parameters.functionName === "liquidity") {
        if (parameters.address === UNKNOWN_POOL_500) return 10n;
        if (parameters.address === UNKNOWN_POOL_3000) return 20n;
        if (parameters.address === UNKNOWN_POOL_10000) return 15n;
      }

      throw new Error(`Unexpected readContract call: ${JSON.stringify(parameters)}`);
    });

    expect(await liquidityVenue.supportsRoute(encoder, UNKNOWN_SRC, USDC)).toBe(true);

    await liquidityVenue.convert(encoder, {
      src: UNKNOWN_SRC,
      dst: USDC,
      srcAmount,
    });

    expect(pushCall).toHaveBeenCalledWith(UNKNOWN_POOL_3000, 0n, expect.any(String), {
      sender: UNKNOWN_POOL_3000,
      dataIndex: 2n,
    });
  });
});
