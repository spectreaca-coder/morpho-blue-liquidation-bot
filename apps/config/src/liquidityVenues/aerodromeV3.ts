import type { Address } from "viem";
import { base } from "viem/chains";

export const AERODROME_MIN_SQRT_RATIO = 4295128739n;
export const AERODROME_MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

export const AERODROME_FACTORY_ADDRESSES: Record<number, Address> = {
  [base.id]: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", // Aerodrome Slipstream CLFactory (verified via pool.factory())
};

// Aerodrome CL (concentrated liquidity) fee tiers — tick spacings
// tickSpacing 1 = ~0.01%, 50 = ~1%, 100 = ~2%, 200 = ~4%
export const AERODROME_TICK_SPACINGS = [50, 100, 200];
