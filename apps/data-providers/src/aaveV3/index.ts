import type { Account, Address, Chain, Client, Hex, Transport } from "viem";

import type { DataProvider, LiquidatablePositionsResult } from "../dataProvider.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** 1e18 — Aave V3 health factor is returned in WAD (18 decimals). */
const WAD = 10n ** 18n;

/**
 * 5% buffer above liquidation threshold.
 * Only positions with HF < 1.05e18 are surfaced.
 */
const HF_BUFFER = (WAD * 105n) / 100n;

/** Subgraph page size. The Graph hosted service allows up to 1000. */
const PAGE_SIZE = 1000;

/** Maximum retry attempts on transient subgraph errors (503/429). */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential back-off. */
const RETRY_BASE_DELAY_MS = 500;

// ─── Subgraph config per chainId ─────────────────────────────────────────────

interface ChainSubgraphConfig {
  /**
   * The Graph hosted-service URL for this chain's Aave V3 subgraph.
   * Override at construction time via {@link AaveV3DataProviderOptions.subgraphUrls}.
   */
  defaultSubgraphUrl: string;
}

/**
 * Known subgraph URLs keyed by EVM chainId.
 * Only Arbitrum (42161) is shipped by default; add more entries to extend.
 */
const CHAIN_SUBGRAPH_CONFIGS: Record<number, ChainSubgraphConfig> = {
  /** Arbitrum One */
  42161: {
    defaultSubgraphUrl: "https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum",
  },
};

// ─── Public types ─────────────────────────────────────────────────────────────

/** A single reserve returned by {@link AaveV3DataProvider.fetchAaveMarkets}. */
export interface AaveV3Reserve {
  /** Underlying ERC-20 token address. */
  underlyingAsset: Address;
  /** Human-readable symbol (from the subgraph). */
  symbol: string;
  /**
   * Loan-to-Value in basis points (e.g. 8000 = 80 %).
   * Source: `reserve.baseLTVasCollateral` from subgraph.
   */
  ltvBps: number;
  /**
   * Liquidation threshold in basis points (e.g. 8250 = 82.5 %).
   * Source: `reserve.reserveLiquidationThreshold`.
   */
  liquidationThresholdBps: number;
  /**
   * Liquidation bonus in basis points above 10 000
   * (e.g. 10500 means 5 % bonus).
   * Source: `reserve.reserveLiquidationBonus`.
   */
  liquidationBonusBps: number;
  /** Aave aToken address for this reserve. */
  aTokenAddress: Address;
  /** Variable debt token address for this reserve. */
  variableDebtTokenAddress: Address;
  /** Whether the asset can be used as collateral. */
  usageAsCollateralEnabled: boolean;
  /** Whether borrowing is enabled for this reserve. */
  borrowingEnabled: boolean;
}

/** A liquidatable Aave V3 position. */
export interface AaveV3LiquidatablePosition {
  /** Borrower wallet address. */
  user: Address;
  /**
   * Health factor in WAD (18-decimal fixed-point bigint).
   * A value < 1e18 means the position is undercollateralised.
   */
  healthFactor: bigint;
  /**
   * Raw health factor string as returned by the subgraph, kept for
   * diagnostics and to allow callers to detect sentinel values.
   */
  rawHealthFactor: string;
  /** Per-reserve positions held by this user. */
  reserves: AaveV3UserReserve[];
}

/** One user's position in a specific reserve. */
export interface AaveV3UserReserve {
  /** Underlying asset address for this reserve. */
  underlyingAsset: Address;
  /**
   * Current aToken balance (collateral) as a string from the subgraph.
   * Use BigInt(currentATokenBalance) for on-chain comparisons.
   */
  currentATokenBalance: string;
  /**
   * Current variable debt as a string from the subgraph.
   */
  currentVariableDebt: string;
  /** Whether the user enabled this reserve as collateral. */
  usageAsCollateralEnabledOnUser: boolean;
}

/** Constructor options for {@link AaveV3DataProvider}. */
export interface AaveV3DataProviderOptions {
  /**
   * Override the default subgraph URL per chainId.
   * Keys are numeric EVM chain IDs.
   * @example { 42161: "https://my-mirror.example.com/subgraphs/..." }
   */
  subgraphUrls?: Record<number, string>;
}

// ─── Subgraph response shapes (internal) ─────────────────────────────────────

interface SubgraphReserve {
  underlyingAsset: string;
  symbol: string;
  baseLTVasCollateral: string;
  reserveLiquidationThreshold: string;
  reserveLiquidationBonus: string;
  aToken: { id: string };
  vToken: { id: string };
  usageAsCollateralEnabled: boolean;
  borrowingEnabled: boolean;
}

interface SubgraphUserReserve {
  reserve: { underlyingAsset: string };
  currentATokenBalance: string;
  currentVariableDebt: string;
  usageAsCollateralEnabledOnUser: boolean;
}

interface SubgraphUser {
  id: string;
  healthFactor: string;
  reserves: SubgraphUserReserve[];
}

interface SubgraphReservesResponse {
  data?: {
    reserves?: SubgraphReserve[];
  };
  errors?: { message: string }[];
}

interface SubgraphUsersResponse {
  data?: {
    users?: SubgraphUser[];
  };
  errors?: { message: string }[];
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Aave V3 data provider — queries The Graph's hosted subgraph.
 *
 * Implements the standard {@link DataProvider} interface so it can be wired
 * into the factory like any other provider. The Morpho-specific
 * `fetchMarkets` / `fetchLiquidatablePositions` methods return empty results
 * (Aave positions cannot be represented as `AccrualPosition`). Use the
 * Aave-specific `fetchAaveMarkets` / `fetchAaveLiquidatablePositions` instead.
 */
export class AaveV3DataProvider implements DataProvider {
  private readonly subgraphUrls: Record<number, string>;

  constructor(options?: AaveV3DataProviderOptions) {
    // Merge caller overrides on top of built-in defaults.
    const defaults: Record<number, string> = {};
    for (const [chainId, cfg] of Object.entries(CHAIN_SUBGRAPH_CONFIGS)) {
      defaults[Number(chainId)] = cfg.defaultSubgraphUrl;
    }
    this.subgraphUrls = { ...defaults, ...(options?.subgraphUrls ?? {}) };
  }

  // ── DataProvider interface (Morpho-specific stubs) ─────────────────────────

  /**
   * Not applicable for Aave V3 — returns empty array.
   * Aave does not use the Morpho vault / market-ID abstraction.
   */
  async fetchMarkets(
    _client: Client<Transport, Chain, Account>,
    _vaults: Address[],
  ): Promise<Hex[]> {
    return [];
  }

  /**
   * Not applicable for Aave V3 — returns empty result sets.
   * Use {@link fetchAaveLiquidatablePositions} for Aave liquidation data.
   */
  async fetchLiquidatablePositions(
    _client: Client<Transport, Chain, Account>,
    _marketIds: Hex[],
  ): Promise<LiquidatablePositionsResult> {
    return { liquidatablePositions: [], preLiquidatablePositions: [] };
  }

  // ── Aave-specific public API ───────────────────────────────────────────────

  /**
   * Fetch all active Aave V3 reserves for a given chain.
   *
   * @param chainId - EVM chain ID (e.g. 42161 for Arbitrum).
   * @returns Array of {@link AaveV3Reserve} objects.
   * @throws If the chain is not configured or the subgraph is unreachable.
   */
  async fetchAaveMarkets(chainId: number): Promise<AaveV3Reserve[]> {
    const url = this.resolveSubgraphUrl(chainId);

    const query = `{
  reserves(first: 200, where: { isActive: true }) {
    underlyingAsset
    symbol
    baseLTVasCollateral
    reserveLiquidationThreshold
    reserveLiquidationBonus
    aToken { id }
    vToken { id }
    usageAsCollateralEnabled
    borrowingEnabled
  }
}`;

    const raw = await this.fetchWithRetry<SubgraphReservesResponse>(url, query);

    if (raw.errors && raw.errors.length > 0) {
      throw new Error(
        `[AaveV3] Subgraph error on fetchAaveMarkets (chain ${chainId}): ${raw.errors[0]?.message ?? "unknown"}`,
      );
    }

    const reserves = raw.data?.reserves ?? [];

    return reserves.map((r) => ({
      underlyingAsset: r.underlyingAsset as Address,
      symbol: r.symbol,
      ltvBps: Number(r.baseLTVasCollateral),
      liquidationThresholdBps: Number(r.reserveLiquidationThreshold),
      liquidationBonusBps: Number(r.reserveLiquidationBonus),
      aTokenAddress: r.aToken.id as Address,
      variableDebtTokenAddress: r.vToken.id as Address,
      usageAsCollateralEnabled: r.usageAsCollateralEnabled,
      borrowingEnabled: r.borrowingEnabled,
    }));
  }

  /**
   * Fetch users whose health factor is below the liquidation buffer threshold.
   *
   * Queries the subgraph for users with active borrows and HF below
   * `HF_BUFFER` (1.05e18). Handles pagination transparently.
   *
   * @param chainId - EVM chain ID.
   * @returns Array of {@link AaveV3LiquidatablePosition} sorted by HF ascending
   *   (most at-risk first).
   */
  async fetchAaveLiquidatablePositions(chainId: number): Promise<AaveV3LiquidatablePosition[]> {
    const url = this.resolveSubgraphUrl(chainId);

    const allUsers: SubgraphUser[] = [];
    let skip = 0;

    while (true) {
      const query = `{
  users(
    first: ${PAGE_SIZE},
    skip: ${skip},
    where: { borrowedReservesCount_gt: 0 }
    orderBy: healthFactor
    orderDirection: asc
  ) {
    id
    healthFactor
    reserves {
      reserve { underlyingAsset }
      currentATokenBalance
      currentVariableDebt
      usageAsCollateralEnabledOnUser
    }
  }
}`;

      const raw = await this.fetchWithRetry<SubgraphUsersResponse>(url, query);

      if (raw.errors && raw.errors.length > 0) {
        throw new Error(
          `[AaveV3] Subgraph error on fetchAaveLiquidatablePositions (chain ${chainId}): ${raw.errors[0]?.message ?? "unknown"}`,
        );
      }

      const batch = raw.data?.users ?? [];
      if (batch.length === 0) break;

      allUsers.push(...batch);

      // If we received a full page, there may be more — continue paginating.
      // Also stop early if the last user's HF already exceeds our buffer,
      // since results are ordered asc by HF.
      if (batch.length < PAGE_SIZE) break;

      const lastUser = batch[batch.length - 1];
      if (lastUser !== undefined) {
        const lastHf = this.parseHealthFactor(lastUser.healthFactor);
        if (lastHf !== null && lastHf > HF_BUFFER) break;
      }

      skip += PAGE_SIZE;
    }

    // Filter and decode.
    const liquidatable: AaveV3LiquidatablePosition[] = [];

    for (const user of allUsers) {
      const hf = this.parseHealthFactor(user.healthFactor);

      // Guard: skip sentinel values (Aave uses MaxUint256 for users with no debt).
      if (hf === null) continue;
      if (hf <= 0n) continue;
      if (hf > HF_BUFFER) continue;

      liquidatable.push({
        user: user.id as Address,
        healthFactor: hf,
        rawHealthFactor: user.healthFactor,
        reserves: user.reserves.map((ur) => ({
          underlyingAsset: ur.reserve.underlyingAsset as Address,
          currentATokenBalance: ur.currentATokenBalance,
          currentVariableDebt: ur.currentVariableDebt,
          usageAsCollateralEnabledOnUser: ur.usageAsCollateralEnabledOnUser,
        })),
      });
    }

    // Sort ascending so highest-risk (lowest HF) is first.
    liquidatable.sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1));

    return liquidatable;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Resolve the subgraph URL for a given chainId, throwing a descriptive
   * error if the chain is not supported.
   */
  private resolveSubgraphUrl(chainId: number): string {
    const url = this.subgraphUrls[chainId];
    if (!url) {
      const supported = Object.keys(this.subgraphUrls).join(", ");
      throw new Error(
        `[AaveV3] No subgraph URL configured for chainId ${chainId}. Supported: ${supported}`,
      );
    }
    return url;
  }

  /**
   * Parse a raw health factor string from the subgraph into a WAD bigint.
   *
   * Aave stores HF as a decimal string with 18 digits of precision.
   * Returns `null` for non-numeric or unparseable values (e.g. "-1" sentinel).
   *
   * @param raw - Raw string from subgraph, e.g. "980000000000000000"
   */
  parseHealthFactor(raw: string): bigint | null {
    if (!raw || raw === "" || raw === "null") return null;

    try {
      const value = BigInt(raw);
      // Aave uses MaxUint256 as sentinel for "no debt" — exclude those.
      // MaxUint256 = 2^256 - 1 ≈ 1.16e77; anything above 1000 WAD is unrealistic.
      const MAX_REALISTIC_HF = WAD * 1000n;
      if (value > MAX_REALISTIC_HF) return null;
      // Negative values would cause BigInt() to throw — already handled above.
      return value;
    } catch {
      return null;
    }
  }

  /**
   * POST a GraphQL query to the given URL with exponential back-off retry
   * on HTTP 429 / 503.
   */
  private async fetchWithRetry<T>(url: string, query: string): Promise<T> {
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (response.ok) {
        return response.json() as Promise<T>;
      }

      // Retry on rate-limit or server errors.
      if (response.status === 429 || response.status === 503) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
        continue;
      }

      // Non-retryable HTTP error.
      throw new Error(`[AaveV3] Subgraph HTTP ${response.status} ${response.statusText} — ${url}`);
    }

    throw new Error(`[AaveV3] Subgraph unreachable after ${MAX_RETRIES} retries — ${url}`);
  }
}
