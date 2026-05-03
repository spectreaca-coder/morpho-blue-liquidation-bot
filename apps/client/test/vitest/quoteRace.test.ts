import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quoteOneInchOut, raceClearingSwapQuotes } from "../../src/utils/swapQuoter.js";

describe("raceClearingSwapQuotes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.ONE_INCH_SWAP_API_KEY;
  });

  it("picks the highest clearing quote across venues", async () => {
    const result = await raceClearingSwapQuotes({
      requiredOut: 100n,
      probes: [
        { venue: "uniswapV3", quote: async () => 90n },
        { venue: "1inch", quote: async () => 120n },
        { venue: "balancer", enabled: false },
      ],
    });

    expect(result.winnerVenue).toBe("1inch");
    expect(result.expectedOut).toBe(120n);
    expect(result.bestObservedOut).toBe(120n);
    expect(result.usedFallback).toBe(true);
  });

  it("returns no winner when every quote misses the clearing threshold", async () => {
    const result = await raceClearingSwapQuotes({
      requiredOut: 100n,
      probes: [
        { venue: "uniswapV3", quote: async () => 80n },
        { venue: "1inch", quote: async () => 95n },
      ],
    });

    expect(result.winnerVenue).toBeNull();
    expect(result.expectedOut).toBe(0n);
    expect(result.bestObservedOut).toBe(95n);
  });

  it("marks slow venues as timed out and still uses completed winners", async () => {
    const result = await raceClearingSwapQuotes({
      requiredOut: 100n,
      probes: [
        {
          venue: "uniswapV3",
          quote: async () =>
            new Promise<bigint>(() => {
              /* timeout */
            }),
        },
        { venue: "1inch", quote: async () => 110n },
      ],
    });

    expect(result.winnerVenue).toBe("1inch");
    expect(result.timedOutVenues).toEqual(["uniswapV3"]);
    expect(result.quotesByVenue.uniswapV3).toBeNull();
  }, 2_000);

  it("breaks equal clearing quotes by the fallback order", async () => {
    const result = await raceClearingSwapQuotes({
      requiredOut: 100n,
      probes: [
        { venue: "uniswapV3", quote: async () => 110n },
        { venue: "1inch", quote: async () => 110n },
      ],
    });

    expect(result.winnerVenue).toBe("uniswapV3");
    expect(result.usedFallback).toBe(false);
  });

  it("skips 1inch quotes when the API key is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await quoteOneInchOut({
      chainId: 8453,
      collateralToken: "0xcb585250f852C6c6bf90434AB21A00f02833a4af",
      loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      seizedAssets: 1_000n,
      executorAddress: "0x2222222222222222222222222222222222222222",
      originAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
