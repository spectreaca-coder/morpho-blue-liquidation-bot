import { describe, expect, it, vi } from "vitest";

import {
  buildBloxroutePromise,
  loadBloxrouteConfig,
  sendViaBloxroute,
  type BloxrouteConfig,
} from "../src/utils/bloxrouteSubmit.js";

const SIGNED_TX =
  "0x02f86c82021080843b9aca0084773594008252089400000000000000000000000000000000000000008080c001a0b2f8a1c5c2e4d8a5b4c3f2e1d0c9b8a7f6e5d4c3b2a19081716151413121110a07f6e5d4c3b2a19081716151413121110b2f8a1c5c2e4d8a5b4c3f2e1d0c9b8a7";
const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111";

function makeConfig(overrides: Partial<BloxrouteConfig> = {}): BloxrouteConfig {
  return {
    url: "https://eth-protect.rpc.blxrbdn.com/",
    authHeader: "test-token",
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("bloxrouteSubmit", () => {
  it("loadBloxrouteConfig returns null when auth is unset", () => {
    const config = loadBloxrouteConfig({
      envOverride: {
        BLOXROUTE_BASE_URL: "https://eth-protect.rpc.blxrbdn.com",
      },
    });

    expect(config).toBeNull();
  });

  it("loadBloxrouteConfig returns default URL when only auth is set", () => {
    const config = loadBloxrouteConfig({
      envOverride: {
        BLOXROUTE_BASE_AUTH: " dashboard-token ",
      },
    });

    expect(config).toEqual({
      // H1 fix: Base default is api.blxrbdn.com, not the mainnet ETH endpoint
      // eth-protect.rpc.blxrbdn.com which silently rejects chainId=8453 txs.
      url: "https://api.blxrbdn.com/",
      authHeader: "dashboard-token",
      timeoutMs: 5_000,
    });
  });

  it("loadBloxrouteConfig uses override URL when allowlisted", () => {
    const config = loadBloxrouteConfig({
      envOverride: {
        BLOXROUTE_BASE_AUTH: "token",
        BLOXROUTE_BASE_URL: "https://staging.rpc.blxrbdn.com/path",
        BLOXROUTE_TIMEOUT_MS: "1234",
      },
    });

    expect(config).toEqual({
      url: "https://staging.rpc.blxrbdn.com/path",
      authHeader: "token",
      timeoutMs: 1234,
    });
  });

  it("loadBloxrouteConfig throws when override URL is not allowlisted", () => {
    expect(() =>
      loadBloxrouteConfig({
        envOverride: {
          BLOXROUTE_BASE_AUTH: "token",
          BLOXROUTE_BASE_URL: "https://evil.com",
        },
      }),
    ).toThrowError("BLOXROUTE_BASE_URL not in allowlist");
  });

  it("sendViaBloxroute posts auth header and returns tx hash result", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return {
        json: vi.fn(async () => ({ result: TX_HASH })),
      } as Pick<Response, "json"> as Response;
    });

    const result = await sendViaBloxroute({
      config: makeConfig(),
      signedTx: SIGNED_TX,
      fetchImpl,
    });

    expect(result).toBe(TX_HASH);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("https://eth-protect.rpc.blxrbdn.com/");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "test-token",
    });
    const bodyStr = init?.body as string | undefined;
    expect(typeof bodyStr).toBe("string");
    expect(JSON.parse(bodyStr ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [SIGNED_TX],
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sendViaBloxroute throws when rpc response has error message", async () => {
    const fetchImpl = vi.fn(async () => {
      return {
        json: vi.fn(async () => ({ error: { message: "rate limited" } })),
      } as Pick<Response, "json"> as Response;
    });

    await expect(buildBloxroutePromise(makeConfig(), SIGNED_TX, fetchImpl)).rejects.toThrowError(
      "bloxroute: rate limited",
    );
  });

  it("sendViaBloxroute throws on fetch rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("timeout");
    });

    await expect(
      sendViaBloxroute({
        config: makeConfig(),
        signedTx: SIGNED_TX,
        fetchImpl,
      }),
    ).rejects.toThrowError("bloxroute: timeout");
  });
});
