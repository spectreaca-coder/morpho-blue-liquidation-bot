/**
 * Unit tests for the UniswapV3 swap-profitability gate in swapQuoter.ts.
 *
 * Uses a mocked readContract to avoid live RPC calls.
 * vi.mock() is hoisted to the top of the file by vitest automatically,
 * so the import ordering below is after-hoist from the linter's perspective.
 */

import { readContract } from "viem/actions";
import { describe, expect, it, vi } from "vitest";

import {
  checkSwapQuoteGate,
  UNISWAP_V3_QUOTER_V2_BASE,
  type QuoteGateParams,
} from "../../src/utils/swapQuoter.js";

// vitest hoists vi.mock() calls — readContract will be replaced with vi.fn() at runtime.
vi.mock("viem/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/actions")>();
  return {
    ...actual,
    readContract: vi.fn(),
  };
});

// Minimal stub client — type-cast to avoid importing full viem chain objects.
const stubClient = {} as QuoteGateParams["client"];

const BASE_PARAMS: QuoteGateParams = {
  client: stubClient,
  quoterAddress: UNISWAP_V3_QUOTER_V2_BASE,
  collateralToken: "0xEDfa23602D0EC14714057867A78d01e94176BEA0", // wrsETH
  loanToken: "0x4200000000000000000000000000000000000006", // WETH
  seizedAssets: 475_000_000_000_000_000n, // 0.475 wrsETH
  requiredOut: 403_700_000_000_000_000n, // 0.4037 WETH (repaidAssets × 1.01)
  logTag: "[test] ",
  marketId: "0x214c2bf3c899c913efda9c4a49adff23f77bbc2dc525af7c05be7ec93f32d561",
  borrower: "0xDeadBeef00000000000000000000000000000000",
};

describe("checkSwapQuoteGate", () => {
  it("returns pass=true when best fee-tier output meets required amount", async () => {
    // Mock: fee tier 3000 returns 0.42 WETH (> 0.4037 required)
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(async (_client, params) => {
      const args = (params as { args: [{ fee: number }] }).args[0];
      if (args.fee === 3000) {
        // [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate]
        return [420_000_000_000_000_000n, 0n, 0, 0n] as const;
      }
      // Other fee tiers: revert (return 0 handled by catch in quoteOneFee)
      throw new Error("execution reverted: no pool");
    });

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(true);
    expect(result.expectedSwapOut).toBe(420_000_000_000_000_000n);
  });

  it("returns pass=false when all fee-tier outputs are below required amount", async () => {
    // Mock: wrsETH scenario — spot gives 0.3519 WETH, required is 0.4037 WETH
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(async (_client, params) => {
      const args = (params as { args: [{ fee: number }] }).args[0];
      if (args.fee === 3000) {
        return [351_900_000_000_000_000n, 0n, 0, 0n] as const;
      }
      throw new Error("execution reverted: no pool");
    });

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(false);
    expect(result.expectedSwapOut).toBe(351_900_000_000_000_000n);
  });

  it("returns fail-closed when all fee-tier quoter calls revert", async () => {
    // Mock: every fee tier reverts (pool does not exist)
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockRejectedValue(new Error("execution reverted: pool not initialized"));

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(false);
    expect(result.expectedSwapOut).toBe(0n);
  });

  it("returns optimistic pass when quoter output exactly equals required amount", async () => {
    // Edge case: output exactly at the boundary
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(async (_client, params) => {
      const args = (params as { args: [{ fee: number }] }).args[0];
      if (args.fee === 500) {
        return [BASE_PARAMS.requiredOut, 0n, 0, 0n] as const;
      }
      throw new Error("no pool");
    });

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(true);
    expect(result.expectedSwapOut).toBe(BASE_PARAMS.requiredOut);
  });

  it("uses the best output across multiple fee tiers", async () => {
    // fee 500 returns low, fee 3000 returns high — gate should use the max
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(async (_client, params) => {
      const args = (params as { args: [{ fee: number }] }).args[0];
      if (args.fee === 500) {
        return [100_000_000_000_000_000n, 0n, 0, 0n] as const; // 0.1 WETH (low)
      }
      if (args.fee === 3000) {
        return [450_000_000_000_000_000n, 0n, 0, 0n] as const; // 0.45 WETH (good)
      }
      throw new Error("no pool");
    });

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(true);
    expect(result.expectedSwapOut).toBe(450_000_000_000_000_000n);
  });

  // ── New tests covering the Promise.allSettled / per-tier-timeout fix ─────────

  it("FAIL: 1 tier hangs, 3 tiers return losing quotes → gate FAIL (not optimistic pass)", async () => {
    // Previously: the hanging tier caused a race, 500ms timeout won → optimistic PASS (bug).
    // After fix: the 3 completed tiers all return losing quotes → gate FAIL.
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(
      async (_client, params): Promise<readonly [bigint, bigint, number, bigint]> => {
        const args = (params as { args: [{ fee: number }] }).args[0];
        if (args.fee === 100) {
          // Hang — never resolves within per-tier 400ms timeout
          return new Promise(() => {
            /* intentionally never resolves */
          });
        }
        // 3 tiers return a losing quote (below requiredOut=0.4037 WETH)
        return [200_000_000_000_000_000n, 0n, 0, 0n] as const; // 0.2 WETH
      },
    );

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(false);
    expect(result.expectedSwapOut).toBe(200_000_000_000_000_000n);
  }, 2_000 /* fast: per-tier timeout is 400ms, global is 500ms */);

  it("PASS: 2 tiers hang, 2 tiers return winning quotes → gate PASS", async () => {
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(
      async (_client, params): Promise<readonly [bigint, bigint, number, bigint]> => {
        const args = (params as { args: [{ fee: number }] }).args[0];
        if (args.fee === 100 || args.fee === 500) {
          return new Promise(() => {
            /* hang */
          });
        }
        // fee 3000, fee 10000 return winning quotes
        return [450_000_000_000_000_000n, 0n, 0, 0n] as const; // 0.45 WETH
      },
    );

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(true);
    expect(result.expectedSwapOut).toBe(450_000_000_000_000_000n);
  }, 2_000);

  it("FAIL: all 4 tiers hang until global timeout → fail closed", async () => {
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(
      (): Promise<readonly [bigint, bigint, number, bigint]> =>
        new Promise(() => {
          /* all tiers hang */
        }),
    );

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(false);
    expect(result.expectedSwapOut).toBe(0n);
  }, 2_000);

  it("FAIL: all 4 tiers revert explicitly → fail closed", async () => {
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockRejectedValue(new Error("execution reverted: pool not initialized"));

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(false);
    expect(result.expectedSwapOut).toBe(0n);
  });

  it("PASS: 3 tiers hang, 1 tier returns winning quote before 500ms → gate PASS", async () => {
    const readContractMock = vi.mocked(readContract);
    readContractMock.mockImplementation(
      async (_client, params): Promise<readonly [bigint, bigint, number, bigint]> => {
        const args = (params as { args: [{ fee: number }] }).args[0];
        if (args.fee === 500) {
          // Returns immediately with a winning quote
          return [420_000_000_000_000_000n, 0n, 0, 0n] as const; // 0.42 WETH
        }
        return new Promise(() => {
          /* other 3 tiers hang */
        });
      },
    );

    const result = await checkSwapQuoteGate(BASE_PARAMS);

    expect(result.pass).toBe(true);
    expect(result.expectedSwapOut).toBe(420_000_000_000_000_000n);
  }, 2_000);
});
