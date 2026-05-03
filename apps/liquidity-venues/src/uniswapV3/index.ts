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
  type Hex,
  encodeAbiParameters,
  encodePacked,
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
    // WETH/USDC — fee 500
    [
      "0x4200000000000000000000000000000000000006",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    ],
    // cbBTC/USDC — fee 500
    [
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef",
    ],
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

const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const Q32 = 1n << 32n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const ONE_E18 = 1_000_000_000_000_000_000n;

const uniswapV3SwapRouterAbi = [
  {
    name: "exactInput",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface UniswapV3PoolSnapshot {
  pool: Address;
  token0: Address;
  token1: Address;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tickSpacing: number;
}

export interface UniswapV3PoolDepthEstimate extends UniswapV3PoolSnapshot {
  maxSwapIn: bigint;
  ticksCrossed: number;
}

export function buildUniswapV3Path(
  firstToken: Address,
  hops: { fee: number; tokenOut: Address }[],
) {
  const types: ("address" | "uint24")[] = ["address"];
  const values: [Address | number, ...(Address | number)[]] = [firstToken];
  for (const hop of hops) {
    types.push("uint24", "address");
    values.push(hop.fee, hop.tokenOut);
  }
  return encodePacked(types, values);
}

export function encodeUniswapV3RouterExactInput(
  encoder: ExecutorEncoder,
  params: {
    router: Address;
    tokenIn: Address;
    amountIn: bigint;
    minAmountOut: bigint;
    path: Hex;
  },
) {
  encoder.erc20Approve(params.tokenIn, params.router, 0n);
  encoder.erc20Approve(params.tokenIn, params.router, params.amountIn);
  encoder.pushCall(
    params.router,
    0n,
    encodeFunctionData({
      abi: uniswapV3SwapRouterAbi,
      functionName: "exactInput",
      args: [
        {
          path: params.path,
          recipient: encoder.address,
          amountIn: params.amountIn,
          amountOutMinimum: params.minAmountOut,
        },
      ],
    }),
  );
}

export async function readUniswapV3PoolSnapshot(
  client: ExecutorEncoder["client"],
  pool: Address,
  cache?: Map<string, UniswapV3PoolSnapshot>,
): Promise<UniswapV3PoolSnapshot> {
  const key = pool.toLowerCase();
  const cached = cache?.get(key);
  if (cached) return cached;

  const [token0, token1, slot0, liquidity, tickSpacing] = await Promise.all([
    readContract(client, { address: pool, abi: uniswapV3PoolAbi, functionName: "token0" }),
    readContract(client, { address: pool, abi: uniswapV3PoolAbi, functionName: "token1" }),
    readContract(client, { address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" }),
    readContract(client, { address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" }),
    readContract(client, { address: pool, abi: uniswapV3PoolAbi, functionName: "tickSpacing" }),
  ]);

  const snapshot: UniswapV3PoolSnapshot = {
    pool,
    token0,
    token1,
    sqrtPriceX96: slot0[0],
    tick: Number(slot0[1]),
    liquidity,
    tickSpacing: Number(tickSpacing),
  };
  cache?.set(key, snapshot);
  return snapshot;
}

export function getUniswapV3SpotAmountOut(
  snapshot: UniswapV3PoolSnapshot,
  tokenIn: Address,
  amountIn: bigint,
): bigint {
  if (amountIn === 0n) return 0n;
  return tokenIn.toLowerCase() === snapshot.token0.toLowerCase()
    ? (amountIn * snapshot.sqrtPriceX96 * snapshot.sqrtPriceX96) / Q192
    : (amountIn * Q192) / (snapshot.sqrtPriceX96 * snapshot.sqrtPriceX96);
}

export async function estimateUniswapV3MaxSwapIn(params: {
  client: ExecutorEncoder["client"];
  pool: Address;
  tokenIn: Address;
  slippageBudgetBps: number;
  snapshotCache?: Map<string, UniswapV3PoolSnapshot>;
}): Promise<UniswapV3PoolDepthEstimate> {
  const snapshot = await readUniswapV3PoolSnapshot(
    params.client,
    params.pool,
    params.snapshotCache,
  );
  const zeroForOne = params.tokenIn.toLowerCase() === snapshot.token0.toLowerCase();
  const rScaled = BigInt(
    Math.floor(Math.sqrt(1 - params.slippageBudgetBps / 10_000) * Number(ONE_E18)),
  );
  const targetSqrtPriceX96 = zeroForOne
    ? (snapshot.sqrtPriceX96 * rScaled) / ONE_E18
    : (snapshot.sqrtPriceX96 * ONE_E18 + rScaled - 1n) / rScaled;

  let sqrtPriceX96 = snapshot.sqrtPriceX96;
  let tick = snapshot.tick;
  let liquidity = snapshot.liquidity;
  let maxSwapIn = 0n;
  let ticksCrossed = 0;

  while (
    liquidity > 0n &&
    (zeroForOne ? sqrtPriceX96 > targetSqrtPriceX96 : sqrtPriceX96 < targetSqrtPriceX96)
  ) {
    const nextTick = await findNextInitializedTick(
      params.client,
      snapshot.pool,
      tick,
      snapshot.tickSpacing,
      zeroForOne,
    );
    const boundarySqrtPriceX96 = getSqrtRatioAtTick(nextTick);
    const nextSqrtPriceX96 = zeroForOne
      ? boundarySqrtPriceX96 > targetSqrtPriceX96
        ? boundarySqrtPriceX96
        : targetSqrtPriceX96
      : boundarySqrtPriceX96 < targetSqrtPriceX96
        ? boundarySqrtPriceX96
        : targetSqrtPriceX96;

    maxSwapIn += zeroForOne
      ? getAmount0Delta(nextSqrtPriceX96, sqrtPriceX96, liquidity)
      : getAmount1Delta(sqrtPriceX96, nextSqrtPriceX96, liquidity);

    if (nextSqrtPriceX96 === targetSqrtPriceX96) break;

    const [, liquidityNet] = await readContract(params.client, {
      address: snapshot.pool,
      abi: uniswapV3PoolAbi,
      functionName: "ticks",
      args: [nextTick],
    });

    liquidity = zeroForOne ? liquidity - liquidityNet : liquidity + liquidityNet;
    sqrtPriceX96 = boundarySqrtPriceX96;
    tick = zeroForOne ? nextTick - 1 : nextTick;
    ticksCrossed += 1;

    if (tick <= MIN_TICK || tick >= MAX_TICK) break;
  }

  return { ...snapshot, maxSwapIn, ticksCrossed };
}

function floorDiv(value: number, divisor: number) {
  return value < 0 && value % divisor !== 0
    ? Math.trunc(value / divisor) - 1
    : Math.trunc(value / divisor);
}

function tickBitmapPosition(compressedTick: number) {
  return {
    wordPos: Math.floor(compressedTick / 256),
    bitPos: ((compressedTick % 256) + 256) % 256,
  };
}

async function findNextInitializedTick(
  client: ExecutorEncoder["client"],
  pool: Address,
  tick: number,
  tickSpacing: number,
  lte: boolean,
) {
  const compressed = floorDiv(tick, tickSpacing);

  if (lte) {
    const { wordPos, bitPos } = tickBitmapPosition(compressed);
    const word = await readContract(client, {
      address: pool,
      abi: uniswapV3PoolAbi,
      functionName: "tickBitmap",
      args: [wordPos],
    });
    const mask = (1n << BigInt(bitPos + 1)) - 1n;
    const masked = word & mask;
    return (
      (masked !== 0n ? compressed - (bitPos - msb(masked)) : compressed - bitPos) * tickSpacing
    );
  }

  const { wordPos, bitPos } = tickBitmapPosition(compressed + 1);
  const word = await readContract(client, {
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: "tickBitmap",
    args: [wordPos],
  });
  const mask = (MAX_UINT256 ^ ((1n << BigInt(bitPos)) - 1n)) & MAX_UINT256;
  const masked = word & mask;
  return (
    (masked !== 0n ? compressed + 1 + (lsb(masked) - bitPos) : compressed + 1 + (255 - bitPos)) *
    tickSpacing
  );
}

function msb(value: bigint) {
  let bit = 255;
  while (((value >> BigInt(bit)) & 1n) === 0n) bit -= 1;
  return bit;
}

function lsb(value: bigint) {
  let bit = 0;
  while (((value >> BigInt(bit)) & 1n) === 0n) bit += 1;
  return bit;
}

function getAmount0Delta(sqrtAX96: bigint, sqrtBX96: bigint, liquidity: bigint) {
  return ((liquidity << 96n) * (sqrtBX96 - sqrtAX96)) / sqrtBX96 / sqrtAX96;
}

function getAmount1Delta(sqrtAX96: bigint, sqrtBX96: bigint, liquidity: bigint) {
  return (liquidity * (sqrtBX96 - sqrtAX96)) / Q96;
}

function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > BigInt(MAX_TICK)) throw new Error(`tick out of range: ${tick}`);

  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

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
