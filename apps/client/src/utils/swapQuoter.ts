/**
 * Uniswap V3 QuoterV2 helper for pre-submit swap profitability gating.
 *
 * Only UniswapV3 venues are gated here.  1inch / Balancer venues have
 * internal slippage handling and are left ungated.
 */

import { API_BASE_URL, slippage, supportedNetworks } from "@morpho-blue-liquidation-bot/config";
import type { Account, Address, Chain, Transport, WalletClient } from "viem";
import { readContract } from "viem/actions";

import { isShadowOnly } from "./shadow-runtime.js";

/** QuoterV2 on Base mainnet (same address on most EVM chains). */
export const UNISWAP_V3_QUOTER_V2_BASE = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address;

/** Standard UniswapV3 fee tiers (same set used by the venue for pool discovery). */
const V3_FEE_TIERS = [100, 500, 3_000, 10_000] as const;

const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Total timeout for all parallel quoter calls (ms). */
const QUOTER_TIMEOUT_MS = 500;

/** Per-tier timeout: a single slow RPC call must not block the others. */
const QUOTER_PER_TIER_TIMEOUT_MS = 400;
const QUOTE_RACE_TIMEOUT_MS = 500;
const QUOTE_RACE_PER_VENUE_TIMEOUT_MS = 300;

export interface QuoteGateParams {
  /** WalletClient used for readContract calls. */
  client: WalletClient<Transport, Chain, Account>;
  /** Quoter V2 contract address — defaults to Base mainnet QuoterV2. */
  quoterAddress?: Address;
  /** Collateral token being sold (tokenIn). */
  collateralToken: Address;
  /** Loan token being received (tokenOut). */
  loanToken: Address;
  /** Amount of collateral seized (amountIn, in collateral decimals). */
  seizedAssets: bigint;
  /**
   * Minimum acceptable swap output.
   * Typically repaidAssets × (10_000 + bufferBps) / 10_000.
   */
  requiredOut: bigint;
  /** Human-readable log tag for contextual logging. */
  logTag: string;
  /** Market ID (hex) — for log context only. */
  marketId: string;
  /** Borrower address — for log context only. */
  borrower: string;
}

export interface QuoteGateResult {
  /** true = swap is profitable enough; false = skip this liquidation. */
  pass: boolean;
  /** Best expected swap output from the quoter (0n if all calls failed/timed out). */
  expectedSwapOut: bigint;
}

export type QuoteRaceVenueName = "uniswapV3" | "1inch" | "balancer" | "aerodromeV3";

export interface QuoteRaceProbe {
  venue: QuoteRaceVenueName;
  enabled?: boolean;
  quote?: () => Promise<bigint | null>;
}

export interface QuoteRaceResult {
  winnerVenue: QuoteRaceVenueName | null;
  expectedOut: bigint;
  bestObservedOut: bigint;
  quotesByVenue: Partial<Record<QuoteRaceVenueName, bigint | null>>;
  timedOutVenues: QuoteRaceVenueName[];
  usedFallback: boolean;
}

export interface FixedRouteHop {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
}

export interface FixedRouteQuote {
  expectedOut: bigint;
  initializedTicksCrossed: number;
  predictedSlippageBps: number;
}

export function getPredictedSlippageBps(spotOut: bigint, expectedOut: bigint): number {
  if (spotOut === 0n || expectedOut >= spotOut) return 0;
  return Number(((spotOut - expectedOut) * 10_000n) / spotOut);
}

export async function quoteFixedUniswapV3Route(params: {
  client: WalletClient<Transport, Chain, Account>;
  quoterAddress?: Address;
  amountIn: bigint;
  spotOut: bigint;
  hops: readonly FixedRouteHop[];
}): Promise<FixedRouteQuote | null> {
  if (params.amountIn === 0n || params.hops.length === 0) return null;

  let amountIn = params.amountIn;
  let initializedTicksCrossed = 0;

  for (const hop of params.hops) {
    try {
      const result = await readContract(params.client, {
        address: params.quoterAddress ?? UNISWAP_V3_QUOTER_V2_BASE,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: hop.tokenIn,
            tokenOut: hop.tokenOut,
            amountIn,
            fee: hop.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      amountIn = result[0];
      initializedTicksCrossed += Number(result[2]);
    } catch {
      return null;
    }
  }

  return {
    expectedOut: amountIn,
    initializedTicksCrossed,
    predictedSlippageBps: getPredictedSlippageBps(params.spotOut, amountIn),
  };
}

async function quoteBestUniswapV3Out(params: QuoteGateParams): Promise<{
  expectedSwapOut: bigint;
  timedOutCount: number;
  optimisticPass: boolean;
}> {
  const {
    client,
    quoterAddress = UNISWAP_V3_QUOTER_V2_BASE,
    collateralToken,
    loanToken,
    seizedAssets,
  } = params;

  type TierResult = { type: "quote"; value: bigint } | { type: "revert" } | { type: "timeout" };

  const quoteOneFee = (fee: number): Promise<TierResult> => {
    const rpcCall = readContract(client, {
      address: quoterAddress,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: collateralToken,
          tokenOut: loanToken,
          amountIn: seizedAssets,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
      .then((result): TierResult => ({ type: "quote", value: result[0] }))
      .catch((): TierResult => ({ type: "revert" }));

    return Promise.race([
      rpcCall,
      new Promise<TierResult>((resolve) =>
        setTimeout(() => {
          resolve({ type: "timeout" });
        }, QUOTER_PER_TIER_TIMEOUT_MS),
      ),
    ]);
  };

  const allSettledResults = await Promise.race([
    Promise.allSettled(V3_FEE_TIERS.map(quoteOneFee)),
    new Promise<null>((resolve) =>
      setTimeout(() => {
        resolve(null);
      }, QUOTER_TIMEOUT_MS),
    ),
  ]);

  if (allSettledResults === null) {
    return { expectedSwapOut: 0n, timedOutCount: V3_FEE_TIERS.length, optimisticPass: true };
  }

  const tierResults = allSettledResults
    .filter((r): r is PromiseFulfilledResult<TierResult> => r.status === "fulfilled")
    .map((r) => r.value);
  const quotedValues = tierResults
    .filter((r): r is { type: "quote"; value: bigint } => r.type === "quote")
    .map((r) => r.value);
  const timedOutCount = tierResults.filter((r) => r.type === "timeout").length;

  if (quotedValues.length === 0) {
    return { expectedSwapOut: 0n, timedOutCount, optimisticPass: true };
  }

  return {
    expectedSwapOut: quotedValues.reduce<bigint>((max, v) => (v > max ? v : max), 0n),
    timedOutCount,
    optimisticPass: false,
  };
}

export async function quoteOneInchOut(params: {
  chainId: number;
  collateralToken: Address;
  loanToken: Address;
  seizedAssets: bigint;
  executorAddress: Address;
  originAddress: Address;
}): Promise<bigint | null> {
  const apiKey = process.env.ONE_INCH_SWAP_API_KEY;
  if (!apiKey || params.seizedAssets === 0n || !supportedNetworks.includes(params.chainId))
    return null;

  const url = new URL(`/swap/v6.1/${params.chainId}/swap`, API_BASE_URL);
  const query: Record<string, string | number | boolean | bigint> = {
    src: params.collateralToken,
    dst: params.loanToken,
    amount: params.seizedAssets,
    from: params.executorAddress,
    slippage: Number(slippage) / 100,
    origin: params.originAddress,
    includeTokensInfo: false,
    includeProtocols: false,
    includeGas: false,
    allowPartialFill: false,
    disableEstimate: true,
    usePermit2: false,
  };
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) throw new Error(res.statusText);

  const body = (await res.json()) as { dstAmount: string };
  return BigInt(body.dstAmount);
}

export async function raceClearingSwapQuotes(params: {
  requiredOut: bigint;
  probes: QuoteRaceProbe[];
}): Promise<QuoteRaceResult> {
  const quotesByVenue: Partial<Record<QuoteRaceVenueName, bigint | null>> = {};
  const timedOutVenues: QuoteRaceVenueName[] = [];
  const probeOrder: Record<QuoteRaceVenueName, number> = {
    uniswapV3: 0,
    "1inch": 1,
    balancer: 2,
    aerodromeV3: 3,
  };

  type ProbeResult =
    | { venue: QuoteRaceVenueName; type: "quote"; expectedOut: bigint | null }
    | { venue: QuoteRaceVenueName; type: "timeout" };

  const runProbe = (probe: QuoteRaceProbe): Promise<ProbeResult> => {
    if (probe.enabled === false || probe.quote === undefined) {
      return Promise.resolve({ venue: probe.venue, type: "quote", expectedOut: null });
    }

    return Promise.race([
      probe
        .quote()
        .then((expectedOut): ProbeResult => ({ venue: probe.venue, type: "quote", expectedOut }))
        .catch((): ProbeResult => ({ venue: probe.venue, type: "quote", expectedOut: null })),
      new Promise<ProbeResult>((resolve) =>
        setTimeout(() => {
          resolve({ venue: probe.venue, type: "timeout" });
        }, QUOTE_RACE_PER_VENUE_TIMEOUT_MS),
      ),
    ]);
  };

  const settled = await Promise.race([
    Promise.allSettled(params.probes.map(runProbe)),
    new Promise<null>((resolve) =>
      setTimeout(() => {
        resolve(null);
      }, QUOTE_RACE_TIMEOUT_MS),
    ),
  ]);

  const probeResults =
    settled === null
      ? params.probes.map((probe) => ({ venue: probe.venue, type: "timeout" as const }))
      : settled
          .filter((r): r is PromiseFulfilledResult<ProbeResult> => r.status === "fulfilled")
          .map((r) => r.value);

  let bestObservedOut = 0n;
  let winnerVenue: QuoteRaceVenueName | null = null;
  let expectedOut = 0n;

  for (const result of probeResults) {
    if (result.type === "timeout") {
      timedOutVenues.push(result.venue);
      quotesByVenue[result.venue] = null;
      continue;
    }

    quotesByVenue[result.venue] = result.expectedOut;
    if (result.expectedOut === null) continue;
    if (result.expectedOut > bestObservedOut) bestObservedOut = result.expectedOut;
    if (result.expectedOut < params.requiredOut) continue;
    if (
      result.expectedOut > expectedOut ||
      (result.expectedOut === expectedOut &&
        winnerVenue !== null &&
        probeOrder[result.venue] < probeOrder[winnerVenue])
    ) {
      winnerVenue = result.venue;
      expectedOut = result.expectedOut;
    }
  }

  return {
    winnerVenue,
    expectedOut,
    bestObservedOut,
    quotesByVenue,
    timedOutVenues,
    usedFallback: winnerVenue !== null && winnerVenue !== "uniswapV3",
  };
}

/**
 * Calls UniswapV3 QuoterV2.quoteExactInputSingle across all standard fee tiers
 * in parallel and checks whether the best expected output covers the required
 * flash-loan repayment amount.
 *
 * Semantics:
 *  - PASS (true)  when bestOut >= requiredOut
 *  - FAIL (false) when bestOut < requiredOut AND at least one quoter returned
 *  - FAIL when all fee-tier calls revert or the overall call times out in live mode
 *
 * Shadow-only mode keeps the old optimistic pass behavior so quote-gate
 * outages can be observed without spending gas.
 */
export async function checkSwapQuoteGate(params: QuoteGateParams): Promise<QuoteGateResult> {
  const { requiredOut, logTag, marketId, borrower } = params;
  const quoteResult = await quoteBestUniswapV3Out(params);

  if (
    quoteResult.optimisticPass &&
    quoteResult.expectedSwapOut === 0n &&
    quoteResult.timedOutCount === V3_FEE_TIERS.length
  ) {
    const pass = isShadowOnly();
    console.warn(
      `${logTag}[quote-gate] global-timeout market=${marketId} borrower=${borrower.slice(0, 10)} — ${pass ? "shadow optimistic PASS" : "BLOCK"}`,
    );
    return { pass, expectedSwapOut: 0n };
  }
  if (quoteResult.optimisticPass) {
    const pass = isShadowOnly();
    console.warn(
      `${logTag}[quote-gate] all-tiers-${quoteResult.timedOutCount === 0 ? "reverted" : "timeout"} market=${marketId} borrower=${borrower.slice(0, 10)} — ${pass ? "shadow optimistic PASS" : "BLOCK"}`,
    );
    return { pass, expectedSwapOut: 0n };
  }

  const bestOut = quoteResult.expectedSwapOut;
  if (bestOut >= requiredOut) {
    return { pass: true, expectedSwapOut: bestOut };
  }

  // Best quote is below required — gate FAIL (do not fall back to optimistic pass).
  const shortfall = requiredOut - bestOut;
  console.log(
    `${logTag}[quote-gate] SKIP market=${marketId} borrower=${borrower.slice(0, 10)} ` +
      `expected=${bestOut} required=${requiredOut} shortfall=${shortfall} timedOut=${quoteResult.timedOutCount}`,
  );
  return { pass: false, expectedSwapOut: bestOut };
}
