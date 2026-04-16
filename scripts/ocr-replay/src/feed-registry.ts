import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

import { FEEDS, BASE_RPC_URL } from "./config.js";
import { OracleFeed } from "./types.js";

const AGG_ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

/** Delay helper to pace RPC calls. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 * Handles "over rate limit" and transient RPC errors.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 6, baseDelayMs = 1000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = (e as Error).message ?? "";
      // Only retry on rate-limit or transient errors.
      if (!msg.includes("rate limit") && !msg.includes("timeout") && !msg.includes("503")) {
        throw e;
      }
    }
  }
  throw lastError;
}

export interface FeedVerifyResult {
  feed: OracleFeed;
  ok: boolean;
  actualDescription?: string;
  actualDecimals?: number;
  error?: string;
}

export async function verifyFeeds(): Promise<FeedVerifyResult[]> {
  if (!BASE_RPC_URL) throw new Error("BASE_ARCHIVE_RPC_URL not set");
  const client = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });
  const results: FeedVerifyResult[] = [];

  for (const feed of FEEDS) {
    // Fixed delay between feeds to avoid burst rate limits on public RPCs.
    if (results.length > 0) await sleep(1000);

    try {
      // Sequential calls with retry to reduce burst pressure.
      const description = await withRetry(() =>
        client.readContract({
          address: feed.aggregator,
          abi: AGG_ABI,
          functionName: "description",
        }),
      );
      await sleep(500);
      const decimals = await withRetry(() =>
        client.readContract({
          address: feed.aggregator,
          abi: AGG_ABI,
          functionName: "decimals",
        }),
      );

      // description examples: "ETH / USD", "cbBTC / USD",
      // "wstETH-stETH Exchange Rate", "CBETH / ETH"
      // Match case-insensitively on the base token symbol (first part before "/").
      const baseToken = feed.symbol.split("/")[0].trim().toLowerCase();
      const descLower = description.toLowerCase();
      const decimalsOk = Number(decimals) === feed.decimals;
      const descOk = descLower.includes(baseToken);
      const ok = descOk && decimalsOk;

      results.push({
        feed,
        ok,
        actualDescription: description,
        actualDecimals: Number(decimals),
      });
    } catch (e) {
      results.push({ feed, ok: false, error: (e as Error).message });
    }
  }

  return results;
}
