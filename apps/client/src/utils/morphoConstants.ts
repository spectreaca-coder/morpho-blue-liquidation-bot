import type { Address } from "viem";

/**
 * Shared Morpho Blue constants — used by selfFundingTip, direct-position-reader,
 * and other utilities that need the canonical contract address without depending
 * on @morpho-org/blue-sdk's getChainAddresses() at module load.
 *
 * Morpho Blue uses the same deterministic CREATE2 deployment address on every
 * chain it ships to (mainnet, Base, Arbitrum, etc.), so this constant is
 * chain-agnostic.
 */

/** Morpho Blue core contract (deterministic CREATE2 — same on all chains). */
export const MORPHO_BLUE: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
