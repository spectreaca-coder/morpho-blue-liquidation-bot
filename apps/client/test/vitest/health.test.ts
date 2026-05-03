import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { healthState, startHealthServer } from "../../src/health.js";

describe("Health endpoint", () => {
  let healthServer: Awaited<ReturnType<typeof startHealthServer>>;
  let port: number;

  beforeAll(async () => {
    // Use a random port for testing to avoid conflicts
    port = 3001;
    healthState.flashblockConnected = true;
    healthState.flashblockLastEventMs = Date.now();
    healthServer = await startHealthServer(port, "127.0.0.1");
  });

  afterAll(async () => {
    await healthServer.stop();
  });

  it("should return 200 with status ok", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.flashblock).toMatchObject({ connected: true, stale: false });
  });
});
