import { describe, it, expect } from "vitest";

import { FEEDS } from "../src/config.js";
import { fetchAnswerUpdatedEvents } from "../src/fetch-events.js";

describe("fetch events", () => {
  it("ETH/USD returns 30+ events in last 24h window", async () => {
    const ethFeed = FEEDS.find((f) => f.symbol === "ETH/USD");
    if (!ethFeed) throw new Error("ETH/USD feed not found in FEEDS");

    const now = BigInt(Math.floor(Date.now() / 1000));
    const since = now - 86_400n; // 24 hours

    const events = await fetchAnswerUpdatedEvents(ethFeed, since, now);

    // ETH/USD heartbeat = 20 min → expect at least 30 updates in 24h.
    expect(events.length).toBeGreaterThanOrEqual(30);

    for (const e of events) {
      // Price sanity: ETH must be between $1,000 and $20,000.
      expect(e.newPriceUsd).toBeGreaterThan(1_000);
      expect(e.newPriceUsd).toBeLessThan(20_000);

      // Symbol must be set correctly.
      expect(e.oracleSymbol).toBe("ETH/USD");

      // Required fields must be present and non-zero.
      expect(e.block).toBeGreaterThan(0n);
      expect(e.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(e.timestamp).toBeGreaterThan(0n);
      expect(e.roundId).toBeGreaterThan(0n);
    }

    // Events must be sorted ascending by block.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].block).toBeGreaterThanOrEqual(events[i - 1].block);
    }
  }, 300_000);
});
