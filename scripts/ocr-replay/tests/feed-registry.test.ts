import { describe, it, expect } from "vitest";

import { verifyFeeds } from "../src/feed-registry.js";

describe("feed registry", () => {
  it("all 4 feeds on Base return correct description + decimals", async () => {
    const results = await verifyFeeds();
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error("Failed feeds:", JSON.stringify(failed, null, 2));
    }
    expect(failed).toHaveLength(0);
    expect(results).toHaveLength(4);
  }, 30_000);
});
