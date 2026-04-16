/**
 * Aave V3 DataProvider tests.
 *
 * Tests 1–2 and 5 mock global.fetch so they run offline (CI-safe).
 * Tests 3–4 are pure unit tests requiring no network.
 *
 * To run against the live subgraph, set env var AAVE_INTEGRATION=1 and
 * provide AAVE_SUBGRAPH_URL_42161 pointing to a working endpoint.
 *
 * Run:
 *   pnpm --filter data-providers test
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

import {
  AaveV3DataProvider,
  type AaveV3Reserve,
  type AaveV3LiquidatablePosition,
} from "../../src/aaveV3/index.js";

const ARBITRUM_CHAIN_ID = 42161;
const WAD = 10n ** 18n;
const HF_BUFFER = (WAD * 105n) / 100n; // 1.05e18

// ─── Fixture data ─────────────────────────────────────────────────────────────

const MOCK_RESERVES_RESPONSE = {
  data: {
    reserves: [
      {
        underlyingAsset: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
        symbol: "USDC.e",
        baseLTVasCollateral: "8000",
        reserveLiquidationThreshold: "8500",
        reserveLiquidationBonus: "10500",
        aToken: { id: "0x625e7708f30ca75bfd92586e17077590c60eb4cd" },
        vToken: { id: "0xfccf3cabbe80101232d343252614b6a3ee81c989" },
        usageAsCollateralEnabled: true,
        borrowingEnabled: true,
      },
      {
        underlyingAsset: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        symbol: "WETH",
        baseLTVasCollateral: "8000",
        reserveLiquidationThreshold: "8250",
        reserveLiquidationBonus: "10500",
        aToken: { id: "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8" },
        vToken: { id: "0x0c84331e39d6658cd6e6b9ba04736cc4c4734351" },
        usageAsCollateralEnabled: true,
        borrowingEnabled: true,
      },
    ],
  },
};

const MOCK_USERS_RESPONSE = {
  data: {
    users: [
      {
        id: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        healthFactor: "950000000000000000", // 0.95e18 — liquidatable
        reserves: [
          {
            reserve: { underlyingAsset: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8" },
            currentATokenBalance: "1000000000",
            currentVariableDebt: "900000000",
            usageAsCollateralEnabledOnUser: true,
          },
        ],
      },
      {
        id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        healthFactor: "1030000000000000000", // 1.03e18 — within 5% buffer
        reserves: [
          {
            reserve: { underlyingAsset: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" },
            currentATokenBalance: "500000000000000000",
            currentVariableDebt: "400000000000000000",
            usageAsCollateralEnabledOnUser: true,
          },
        ],
      },
    ],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return a mock Response wrapping a JSON object. */
function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AaveV3DataProvider", () => {
  let provider: AaveV3DataProvider;

  beforeAll(() => {
    provider = new AaveV3DataProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: fetchAaveMarkets returns a non-empty list with required fields ──

  it("fetchAaveMarkets(42161) returns non-empty reserve list with required fields", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockJsonResponse(MOCK_RESERVES_RESPONSE));

    const reserves: AaveV3Reserve[] = await provider.fetchAaveMarkets(ARBITRUM_CHAIN_ID);

    expect(reserves.length).toBeGreaterThan(0);

    for (const reserve of reserves) {
      // Required address fields must be non-empty strings.
      expect(typeof reserve.underlyingAsset).toBe("string");
      expect(reserve.underlyingAsset.length).toBeGreaterThan(0);

      expect(typeof reserve.symbol).toBe("string");
      expect(reserve.symbol.length).toBeGreaterThan(0);

      expect(typeof reserve.aTokenAddress).toBe("string");
      expect(reserve.aTokenAddress.length).toBeGreaterThan(0);

      expect(typeof reserve.variableDebtTokenAddress).toBe("string");
      expect(reserve.variableDebtTokenAddress.length).toBeGreaterThan(0);

      // Numeric config fields must be non-negative integers.
      expect(typeof reserve.ltvBps).toBe("number");
      expect(reserve.ltvBps).toBeGreaterThanOrEqual(0);

      expect(typeof reserve.liquidationThresholdBps).toBe("number");
      expect(reserve.liquidationThresholdBps).toBeGreaterThanOrEqual(0);

      expect(typeof reserve.liquidationBonusBps).toBe("number");
      expect(reserve.liquidationBonusBps).toBeGreaterThanOrEqual(0);
    }

    // Spot-check fixture values.
    expect(reserves[0]?.symbol).toBe("USDC.e");
    expect(reserves[0]?.ltvBps).toBe(8000);
    expect(reserves[0]?.liquidationThresholdBps).toBe(8500);
    expect(reserves[0]?.liquidationBonusBps).toBe(10500);
  });

  // ── Test 2: fetchAaveLiquidatablePositions returns parseable result ─────────

  it("fetchAaveLiquidatablePositions(42161) returns positions each with HF < 1.05e18", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockJsonResponse(MOCK_USERS_RESPONSE));

    const positions: AaveV3LiquidatablePosition[] =
      await provider.fetchAaveLiquidatablePositions(ARBITRUM_CHAIN_ID);

    // Both mock users are within the 5 % buffer.
    expect(positions.length).toBe(2);

    for (const pos of positions) {
      // HF must be a bigint below the 5 % buffer.
      expect(typeof pos.healthFactor).toBe("bigint");
      expect(pos.healthFactor).toBeGreaterThan(0n);
      expect(pos.healthFactor).toBeLessThanOrEqual(HF_BUFFER);

      // User must be a non-empty address string.
      expect(typeof pos.user).toBe("string");
      expect(pos.user.length).toBeGreaterThan(0);

      // rawHealthFactor must be a non-empty string.
      expect(typeof pos.rawHealthFactor).toBe("string");
      expect(pos.rawHealthFactor.length).toBeGreaterThan(0);

      // Reserves array must exist.
      expect(Array.isArray(pos.reserves)).toBe(true);
    }

    // Sorted ascending by HF — lowest-risk-first not required, but verify sort.
    expect(positions[0]?.healthFactor).toBeLessThanOrEqual(positions[1]?.healthFactor ?? HF_BUFFER);
  });

  // ── Test 3: HF decoding from known WAD values (pure unit) ─────────────────

  describe("parseHealthFactor (unit)", () => {
    it("decodes a healthy HF correctly", () => {
      // 1.5e18 — well above liquidation threshold.
      const hf = provider.parseHealthFactor("1500000000000000000");
      expect(hf).toBe(1500000000000000000n);
    });

    it("decodes an undercollateralised HF (< 1e18)", () => {
      // 0.95e18 — position should be liquidatable.
      const hf = provider.parseHealthFactor("950000000000000000");
      expect(hf).toBe(950000000000000000n);
      expect(hf).not.toBeNull();
      if (hf !== null) {
        expect(hf).toBeLessThan(WAD);
      }
    });

    it("returns null for MaxUint256 sentinel (user with no debt)", () => {
      // Aave returns MaxUint256 when a user has no active debt.
      const maxUint256 =
        "115792089237316195423570985008687907853269984665640564039457584007913129639935";
      const hf = provider.parseHealthFactor(maxUint256);
      expect(hf).toBeNull();
    });

    it("returns null for empty / null-like strings", () => {
      expect(provider.parseHealthFactor("")).toBeNull();
      expect(provider.parseHealthFactor("null")).toBeNull();
    });

    it("returns null for non-numeric strings", () => {
      expect(provider.parseHealthFactor("not-a-number")).toBeNull();
    });
  });

  // ── Test 4: Graceful error on unsupported chainId (pure unit) ─────────────

  it("throws a descriptive error for unsupported chainId", async () => {
    await expect(provider.fetchAaveMarkets(999999)).rejects.toThrow(
      /No subgraph URL configured for chainId 999999/,
    );
  });

  // ── Test 5: Retry on HTTP 503 succeeds on second attempt ──────────────────

  it("retries on HTTP 503 and succeeds on subsequent attempt", async () => {
    let callCount = 0;

    vi.spyOn(global, "fetch").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Service Unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }
      return mockJsonResponse(MOCK_RESERVES_RESPONSE);
    });

    const reserves = await provider.fetchAaveMarkets(ARBITRUM_CHAIN_ID);
    expect(reserves.length).toBeGreaterThan(0);
    expect(callCount).toBe(2);
  });
});
