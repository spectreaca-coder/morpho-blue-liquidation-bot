import {
  FEE_TIERS,
  DEFAULT_FACTORY_ADDRESS,
  specificFactoryAddresses,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from "@morpho-blue-liquidation-bot/config";
import * as config from "@morpho-blue-liquidation-bot/config";
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

const FALLBACK_KNOWN_POOLS: Record<number, [Address, Address, Address][]> = {
  8453: [
    // wrsETH/WETH — fee 3000
    [
      "0xEDfa23602D0EC14714057867A78d01e94176BEA0",
      "0x4200000000000000000000000000000000000006",
      "0x16e25fAcBA67a40dA3436ab9E2E00C30daB0dD97",
    ],
    // cbETH/USDC — fee 3000
    [
      "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0xa8E4C55D6dAf4D768aeBa2378c1AD94c112Ef48a",
    ],
  ],
};

const KNOWN_POOLS =
  (
    config as typeof config & {
      KNOWN_POOLS?: Record<number, [Address, Address, Address][]>;
    }
  ).KNOWN_POOLS ?? FALLBACK_KNOWN_POOLS;

export class UniswapV3Venue implements LiquidityVenue {
  private pools: Record<Address, Record<Address, Address[]>> = {};
  private liquidityCache = new Map<Address, { amount: bigint; fetchedAt: number }>();

  private static readonly LIQUIDITY_CACHE_TTL_MS = 10 * 60 * 1000;

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
      const knownPool = this.getKnownPool(encoder.client.chain.id, src, dst);

      const fastPath = pools.length === 1 && knownPool === pools[0];
      // Diagnostic log — verify KNOWN_POOLS fast-path hit rate
      console.log(
        `[uniV3.convert] src=${src} dst=${dst} pools.len=${pools.length} ` +
          `knownPool=${knownPool ?? "undefined"} pools[0]=${pools[0] ?? "undefined"} ` +
          `fastPath=${fastPath} chainId=${encoder.client.chain.id}`,
      );

      const biggestPool = fastPath
        ? pools[0]
        : (
            await Promise.all(
              pools.map(async (pool) => {
                const cached = this.liquidityCache.get(pool);
                if (
                  cached &&
                  Date.now() - cached.fetchedAt < UniswapV3Venue.LIQUIDITY_CACHE_TTL_MS
                ) {
                  return { pool, amount: cached.amount };
                }

                const amount = await readContract(encoder.client, {
                  address: pool,
                  abi: uniswapV3PoolAbi,
                  functionName: "liquidity",
                });

                this.liquidityCache.set(pool, { amount, fetchedAt: Date.now() });
                return { pool, amount };
              }),
            )
          ).reduce<{ pool: Address; amount: bigint } | null>(
            // Finding 7 fix: with null seed, the previous comparator `max !== null && ...`
            // always returned null because the very first iteration short-circuited on
            // max=null, leaving biggestPool undefined and throwing "No Uniswap pool found".
            // Treat null max as "any liquidity wins", then fall back to strict >= for ties.
            (max, liquidity) => (max === null || liquidity.amount > max.amount ? liquidity : max),
            null,
          )?.pool;

      if (!biggestPool) {
        throw new Error("(UniswapV3) No Uniswap pool found");
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
            zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n,
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
        `(UniswapV3) Error swapping: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getCachedPools(src: Address, dst: Address) {
    if (this.pools[src]?.[dst] !== undefined) return this.pools[src][dst];
    if (this.pools[dst]?.[src] !== undefined) return this.pools[dst][src];
    return undefined;
  }

  private async fetchPools(encoder: ExecutorEncoder, src: Address, dst: Address) {
    const knownPool = this.getKnownPool(encoder.client.chain.id, src, dst);
    if (knownPool) {
      this.pools[src] = { ...this.pools[src], [dst]: [knownPool] };
      return [knownPool];
    }

    const factoryAddress =
      specificFactoryAddresses[encoder.client.chain.id] ?? DEFAULT_FACTORY_ADDRESS;

    try {
      const newPools = (
        await Promise.all(
          FEE_TIERS.map(async (fee) => {
            const pool = await readContract(encoder.client, {
              address: factoryAddress,
              abi: uniswapV3FactoryAbi,
              functionName: "getPool",
              args: [src, dst, fee],
            });
            if (pool === zeroAddress) return null;

            // Filter ghost pools (zero liquidity) and warm convert()'s TTL cache.
            try {
              const liquidity = await readContract(encoder.client, {
                address: pool,
                abi: uniswapV3PoolAbi,
                functionName: "liquidity",
              });
              if (liquidity === 0n) return null;
              this.liquidityCache.set(pool, { amount: liquidity, fetchedAt: Date.now() });
            } catch {
              return null;
            }

            return pool;
          }),
        )
      ).filter((pool): pool is Address => pool !== null);

      if (this.pools[src]?.[dst] === undefined) {
        this.pools[src] = { ...this.pools[src], [dst]: newPools };
      }

      return newPools;
    } catch (error) {
      throw new Error(
        `(UniswapV3) Error fetching pools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getKnownPool(chainId: number, src: Address, dst: Address) {
    return KNOWN_POOLS[chainId]?.find(
      ([tokenA, tokenB]) =>
        (tokenA.toLowerCase() === src.toLowerCase() &&
          tokenB.toLowerCase() === dst.toLowerCase()) ||
        (tokenA.toLowerCase() === dst.toLowerCase() && tokenB.toLowerCase() === src.toLowerCase()),
    )?.[2];
  }
}
