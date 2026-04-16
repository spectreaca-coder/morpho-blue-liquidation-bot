import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

import { FEEDS, BASE_RPC_URL } from "./config.js";
import { OracleFeed } from "./types.js";

const AGG_ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

/** Delay helper to avoid public RPC rate limits. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    transport: http(BASE_RPC_URL, { retryCount: 5, retryDelay: 1500 }),
  });
  const results: FeedVerifyResult[] = [];

  for (const feed of FEEDS) {
    // Delay between feeds to respect public RPC rate limits.
    if (results.length > 0) await sleep(800);

    try {
      // Sequential calls (not parallel) to reduce burst load on public RPCs.
      const description = await client.readContract({
        address: feed.aggregator,
        abi: AGG_ABI,
        functionName: "description",
      });
      await sleep(400);
      const decimals = await client.readContract({
        address: feed.aggregator,
        abi: AGG_ABI,
        functionName: "decimals",
      });

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
