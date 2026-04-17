import {
  AERODROME_FACTORY_ADDRESSES,
  AERODROME_MAX_SQRT_RATIO,
  AERODROME_MIN_SQRT_RATIO,
  AERODROME_TICK_SPACINGS,
} from "@morpho-blue-liquidation-bot/config";
import { executorAbi, type ExecutorEncoder } from "executooor-viem";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  fromHex,
  zeroAddress,
} from "viem";
import { readContract } from "viem/actions";

import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from "../abis/uniswapV3";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";

export class AerodromeV3Venue implements LiquidityVenue {
  private pools: Record<Address, Record<Address, Address[]>> = {};

  async supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;

    const pools = this.getCachedPools(src, dst) ?? (await this.fetchPools(encoder, src, dst));

    return pools.length > 0;
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    const pools = this.getCachedPools(src, dst);

    if (pools === undefined) {
      return toConvert;
    }

    try {
      const liquidities = await Promise.all(
        pools.map(async (pool) => {
          return {
            pool,
            amount: await readContract(encoder.client, {
              address: pool,
              abi: uniswapV3PoolAbi,
              functionName: "liquidity",
            }),
          };
        }),
      );

      const biggestPool = liquidities.reduce(
        (max, liquidity) => (max !== null && liquidity.amount > max.amount ? liquidity : max),
        liquidities[0] ?? null,
      )?.pool;

      if (!biggestPool) {
        throw new Error("(AerodromeV3) No Aerodrome pool found");
      }

      const zeroForOne = fromHex(src, "bigint") < fromHex(dst, "bigint");

      const encodedContext =
        `0x${0n.toString(16).padStart(24, "0") + zeroAddress.substring(2)}` as const;
      const callbacks = [
        encodeFunctionData({
          abi: executorAbi,
          functionName: "call_g0oyU7o",
          args: [
            src,
            0n,
            encodedContext,
            encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [biggestPool, srcAmount],
            }),
          ],
        }),
      ];

      encoder.pushCall(
        biggestPool,
        0n,
        encodeFunctionData({
          abi: uniswapV3PoolAbi,
          functionName: "swap",
          args: [
            encoder.address,
            zeroForOne,
            srcAmount,
            zeroForOne ? AERODROME_MIN_SQRT_RATIO + 1n : AERODROME_MAX_SQRT_RATIO - 1n,
            encodeAbiParameters([{ type: "bytes[]" }, { type: "bytes" }], [callbacks, "0x"]),
          ],
        }),
        {
          sender: biggestPool,
          dataIndex: 2n, // uniswapV3SwapCallback(int256,int256,bytes)
        },
      );

      /// assumed to be the last liquidity venue
      return {
        src: dst,
        dst: dst,
        srcAmount: 0n,
      };
    } catch (error) {
      throw new Error(
        `(AerodromeV3) Error swapping: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getCachedPools(src: Address, dst: Address) {
    if (this.pools[src]?.[dst] !== undefined) return this.pools[src][dst];
    if (this.pools[dst]?.[src] !== undefined) return this.pools[dst][src];
    return undefined;
  }

  private async fetchPools(encoder: ExecutorEncoder, src: Address, dst: Address) {
    const factoryAddress = AERODROME_FACTORY_ADDRESSES[encoder.client.chain.id];

    if (!factoryAddress) {
      return [];
    }

    try {
      const newPools = (
        await Promise.all(
          AERODROME_TICK_SPACINGS.map(async (tickSpacing) =>
            readContract(encoder.client, {
              address: factoryAddress,
              abi: uniswapV3FactoryAbi,
              functionName: "getPool",
              args: [src, dst, tickSpacing],
            }),
          ),
        )
      ).filter((pool) => pool !== zeroAddress);

      if (this.pools[src]?.[dst] === undefined) {
        this.pools[src] = { ...this.pools[src], [dst]: newPools };
      }

      return newPools;
    } catch (error) {
      throw new Error(
        `(AerodromeV3) Error fetching pools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
