/**
 * Direct Position Reader — on-chain fallback for known (marketId, user) pairs.
 *
 * Bypasses blue-api GraphQL indexing lag by reading Morpho Blue state directly
 * via viem multicall. Activated only when HARNESS_BYPASS_FILTERS="1" AND
 * HARNESS_DIRECT_POSITIONS is set with valid "marketId:user" pairs.
 *
 * Production default: env unset → getDirectPositionTargets() returns [] and
 * no RPC calls are ever made.
 */

import { type Address, type Chain, type Client, type Hex, type Transport } from "viem";
import { multicall } from "viem/actions";

import type { CachedPosition } from "../position-cache.js";

import { isHarnessBypassActive } from "./harness-filter-bypass.js";
import { MORPHO_BLUE } from "./morphoConstants.js";

// ─── Morpho Blue constants ────────────────────────────────────────────────────

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
/** Virtual amounts matching Morpho's share-conversion formula (prevents div-by-zero). */
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1_000_000n;

// ─── ABIs (minimal, inline) ──────────────────────────────────────────────────

const morphoAbi = [
  {
    name: "idToMarketParams",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
  },
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
  {
    name: "market",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" },
    ],
  },
] as const;

const oracleAbi = [
  {
    name: "price",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const erc20Abi = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DirectPositionTarget {
  marketId: Hex;
  user: Address;
}

interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** Module-level token metadata cache — survives across loadPositions() calls. */
const tokenMetaCache = new Map<string, TokenMeta>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse HARNESS_DIRECT_POSITIONS env var into validated targets.
 *
 * Format: `marketId:user[,marketId:user,...]`
 * Gates on isHarnessBypassActive(chainId). Returns [] on any issue.
 *
 * @param chainId - The numeric chain ID of the current bot instance.
 */
export function getDirectPositionTargets(chainId: number): DirectPositionTarget[] {
  if (!isHarnessBypassActive(chainId)) return [];

  const raw = process.env.HARNESS_DIRECT_POSITIONS;
  if (!raw || raw.trim() === "") return [];

  const results: DirectPositionTarget[] = [];

  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      console.warn(`[DIRECT] malformed pair (no colon): "${trimmed}" — skipping`);
      return []; // any malformed pair → return []
    }

    const marketId = trimmed.slice(0, colonIdx).trim();
    const user = trimmed.slice(colonIdx + 1).trim();

    if (!isValidHex(marketId, 66) || !isValidHex(user, 42)) {
      console.warn(`[DIRECT] malformed pair (bad hex): "${trimmed}" — skipping`);
      return []; // any malformed pair → return []
    }

    results.push({
      marketId: marketId as Hex,
      user: user as Address,
    });
  }

  return results;
}

/**
 * Fetch on-chain state for a list of (marketId, user) targets and return
 * them as CachedPosition objects suitable for direct insertion into PositionCache.
 *
 * Uses viem multicall to batch all reads into a single RPC round-trip per target.
 * Skips positions where borrowShares === 0 or collateral === 0 (not liquidatable).
 * Per-target try/catch ensures one failing read does not block others.
 *
 * @param args.logTag   - Log prefix (e.g. "[Base client]: ")
 * @param args.chainId  - Chain ID (gated: no-op unless Base + harness active)
 * @param args.client   - Viem public client for the chain
 * @param args.targets  - Parsed (marketId, user) pairs from getDirectPositionTargets()
 * @returns CachedPosition[] ready to be merged into PositionCache
 */
export async function fetchDirectPositions(args: {
  logTag: string;
  chainId: number;
  client: Client<Transport, Chain>;
  targets: DirectPositionTarget[];
}): Promise<CachedPosition[]> {
  const { logTag, targets, client } = args;

  if (targets.length === 0) return [];

  const positions: CachedPosition[] = [];

  for (const target of targets) {
    try {
      const pos = await readOneTarget(client, target);
      if (pos !== null) {
        positions.push(pos);
      }
    } catch (err) {
      console.error(
        `${logTag}[DIRECT] target ${target.marketId}:${target.user} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const hfList = positions.map((p) => p.apiHealthFactor.toFixed(4)).join(", ");
  console.log(`${logTag}[DIRECT] read ${positions.length} positions on-chain (HF: [${hfList}])`);

  return positions;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Read all on-chain state for one (marketId, user) target and build a CachedPosition.
 * Returns null when the position is not liquidatable (zero borrow or zero collateral).
 */
async function readOneTarget(
  client: Client<Transport, Chain>,
  target: DirectPositionTarget,
): Promise<CachedPosition | null> {
  // Phase 1: market params + position state + market totals (single multicall)
  const phase1 = await multicall(client, {
    contracts: [
      {
        address: MORPHO_BLUE,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [target.marketId],
      },
      {
        address: MORPHO_BLUE,
        abi: morphoAbi,
        functionName: "position",
        args: [target.marketId, target.user],
      },
      {
        address: MORPHO_BLUE,
        abi: morphoAbi,
        functionName: "market",
        args: [target.marketId],
      },
    ],
    allowFailure: false,
  });

  const [marketParams, positionData, marketState] = phase1;

  const borrowShares = BigInt(positionData[1]);
  const collateral = BigInt(positionData[2]);

  // Skip non-liquidatable positions (zero borrow or zero collateral)
  if (borrowShares === 0n || collateral === 0n) return null;

  const loanToken = marketParams[0];
  const collateralToken = marketParams[1];
  const oracleAddr = marketParams[2];
  const irm = marketParams[3];
  const lltv = BigInt(marketParams[4]);

  const totalBorrowAssets = BigInt(marketState[2]);
  const totalBorrowShares = BigInt(marketState[3]);

  // Phase 2: oracle price + token metadata (batched; token meta cached after first read)
  const needLoanMeta = !tokenMetaCache.has(loanToken.toLowerCase());
  const needCollateralMeta = !tokenMetaCache.has(collateralToken.toLowerCase());

  interface OracleCall {
    address: Address;
    abi: typeof oracleAbi;
    functionName: "price";
    args: readonly [];
  }
  interface Erc20Call {
    address: Address;
    abi: typeof erc20Abi;
    functionName: "symbol" | "decimals";
    args: readonly [];
  }
  type Phase2Contract = OracleCall | Erc20Call;

  const phase2Contracts: Phase2Contract[] = [
    { address: oracleAddr, abi: oracleAbi, functionName: "price", args: [] as const },
  ];

  if (needLoanMeta) {
    phase2Contracts.push({
      address: loanToken,
      abi: erc20Abi,
      functionName: "symbol",
      args: [] as const,
    });
    phase2Contracts.push({
      address: loanToken,
      abi: erc20Abi,
      functionName: "decimals",
      args: [] as const,
    });
  }
  if (needCollateralMeta) {
    phase2Contracts.push({
      address: collateralToken,
      abi: erc20Abi,
      functionName: "symbol",
      args: [] as const,
    });
    phase2Contracts.push({
      address: collateralToken,
      abi: erc20Abi,
      functionName: "decimals",
      args: [] as const,
    });
  }

  const phase2 = await multicall(client, {
    contracts: phase2Contracts,
    allowFailure: false,
  });

  // Parse phase 2 results in insertion order
  let idx = 0;
  const oraclePrice = BigInt(phase2[idx++] as bigint);

  if (needLoanMeta) {
    const symbol = phase2[idx++] as string;
    const decimals = Number(phase2[idx++]);
    tokenMetaCache.set(loanToken.toLowerCase(), { symbol, decimals });
  }
  if (needCollateralMeta) {
    const symbol = phase2[idx++] as string;
    const decimals = Number(phase2[idx++]);
    tokenMetaCache.set(collateralToken.toLowerCase(), { symbol, decimals });
  }

  // Both are guaranteed to be in cache now
  const loanMeta = tokenMetaCache.get(loanToken.toLowerCase())!;
  const collateralMeta = tokenMetaCache.get(collateralToken.toLowerCase())!;

  const apiHealthFactor = computeHealthFactor(
    collateral,
    borrowShares,
    totalBorrowAssets,
    totalBorrowShares,
    oraclePrice,
    lltv,
  );

  return {
    borrower: target.user,
    marketId: target.marketId,
    collateral,
    borrowShares,
    totalBorrowAssets,
    totalBorrowShares,
    lltv,
    oracleAddress: oracleAddr.toLowerCase(),
    collateralSymbol: collateralMeta.symbol,
    loanSymbol: loanMeta.symbol,
    collateralDecimals: collateralMeta.decimals,
    loanDecimals: loanMeta.decimals,
    loanToken,
    collateralToken,
    oracle: oracleAddr,
    irm,
    apiHealthFactor,
  };
}

/**
 * Compute health factor as a float, using the same virtual-share formula as
 * position-cache.ts / Morpho Blue on-chain math.
 *
 * Returns 1e9 (effectively infinite) when borrowAssets === 0.
 */
function computeHealthFactor(
  collateral: bigint,
  borrowShares: bigint,
  totalBorrowAssets: bigint,
  totalBorrowShares: bigint,
  oraclePrice: bigint,
  lltv: bigint,
): number {
  const denominator = totalBorrowShares + VIRTUAL_SHARES;
  const borrowAssets =
    (borrowShares * (totalBorrowAssets + VIRTUAL_ASSETS) + denominator - 1n) / denominator;

  if (borrowAssets === 0n) return 1e9;

  const collateralValue = (collateral * oraclePrice) / ORACLE_PRICE_SCALE;
  const maxBorrow = (collateralValue * lltv) / WAD;
  const hfBigint = (maxBorrow * WAD) / borrowAssets;

  return Number(hfBigint) / 1e18;
}

/** Validates that a string is a 0x-prefixed hex of a specific total character length. */
function isValidHex(value: string, expectedLength: number): boolean {
  return (
    typeof value === "string" &&
    value.startsWith("0x") &&
    value.length === expectedLength &&
    /^0x[0-9a-fA-F]+$/.test(value)
  );
}
