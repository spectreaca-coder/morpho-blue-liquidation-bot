/**
 * Aerodrome Slipstream (CL) quoter helper for the quote-race fallback.
 *
 * Calls Aerodrome's MixedRouteQuoterV1 on Base, which uses tickSpacing (int24)
 * instead of Uniswap V3's fee (uint24) for pool identification.
 */

import { AERODROME_TICK_SPACINGS } from "@morpho-blue-liquidation-bot/config";
import type { Account, Address, Chain, Transport, WalletClient } from "viem";
import { readContract } from "viem/actions";

/**
 * Aerodrome MixedRouteQuoterV1 on Base mainnet.
 * Source: Aerodrome Finance Slipstream deployment registry.
 * WARNING: Verify on Basescan before production use — a wrong address causes silent reverts.
 */
const AERODROME_MIXED_ROUTE_QUOTER_V1_BASE =
  "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0" as Address;

const AERODROME_CL_QUOTER_ABI = [
  {
    name: "quoteExactInputSingleV3",
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
          { name: "tickSpacing", type: "int24" },
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

export interface AerodromeQuoterParams {
  client: WalletClient<Transport, Chain, Account>;
  chainId: number;
  collateralToken: Address;
  loanToken: Address;
  seizedAssets: bigint;
  executorAddress: Address;
  originAddress: Address;
}

/**
 * Quotes the expected loan-token output for a single-hop Aerodrome Slipstream swap.
 *
 * Tries each tick spacing from AERODROME_TICK_SPACINGS in order and returns the
 * first non-zero quote. Throws if no pool responds with a positive quote, so the
 * quote-race timer will reject this probe rather than recording a zero.
 *
 * @param params - Quoter input parameters including WalletClient for RPC calls.
 * @returns Expected amountOut in loan-token units.
 * @throws If all tick spacings revert or return zero.
 */
export async function quoteAerodromeSlipstreamOut(params: AerodromeQuoterParams): Promise<bigint> {
  for (const tickSpacing of AERODROME_TICK_SPACINGS) {
    try {
      const result = await readContract(params.client, {
        address: AERODROME_MIXED_ROUTE_QUOTER_V1_BASE,
        abi: AERODROME_CL_QUOTER_ABI,
        functionName: "quoteExactInputSingleV3",
        args: [
          {
            tokenIn: params.collateralToken,
            tokenOut: params.loanToken,
            amountIn: params.seizedAssets,
            tickSpacing,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const amountOut = result[0];
      if (amountOut > 0n) {
        return amountOut;
      }
    } catch {
      // Pool does not exist for this tickSpacing — try next.
    }
  }
  throw new Error("(AerodromeQuoter) No Slipstream pool returned a positive quote");
}
