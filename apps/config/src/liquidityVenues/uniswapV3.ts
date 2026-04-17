import type { Address } from "viem";
import { arbitrum, base, katana, unichain, worldchain } from "viem/chains";

import { hyperevm, monad } from "../chains";

export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

export const DEFAULT_FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Address;

export const specificFactoryAddresses: Record<number, Address> = {
  [base.id]: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  [unichain.id]: "0x1F98400000000000000000000000000000000003",
  [katana.id]: "0x203e8740894c8955cB8950759876d7E7E45E04c1",
  [worldchain.id]: "0x7a5028BDa40e7B173C278C5342087826455ea25a",
  [hyperevm.id]: "0xB1c0fa0B789320044A6F623cFe5eBda9562602E3",
  [monad.id]: "0x204faca1764b154221e35c0d20abb3c525710498",
  [arbitrum.id]: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
};

export const FEE_TIERS = [500, 3000, 10000];

// Pre-verified pool addresses. getPool() is CREATE2-deterministic, so these addresses do not change.
// Only single-pool pairs should be listed here, where selecting by liquidity is unnecessary.
export const KNOWN_POOLS: Record<number, [Address, Address, Address][]> = {
  [base.id]: [
    // wrsETH/WETH — fee 3000 (only active pool, liquidity ~697B)
    [
      "0xEDfa23602D0EC14714057867A78d01e94176BEA0" as Address,
      "0x4200000000000000000000000000000000000006" as Address,
      "0x16e25fAcBA67a40dA3436ab9E2E00C30daB0dD97" as Address,
    ],
    // cbETH/USDC — fee 3000 (only active pool, others have 0 liquidity)
    [
      "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as Address,
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
      "0xa8E4C55D6dAf4D768aeBa2378c1AD94c112Ef48a" as Address,
    ],
  ],
};
