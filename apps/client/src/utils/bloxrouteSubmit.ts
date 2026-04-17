/**
 * bloXroute Base Protect RPC submission helper.
 *
 * Drop-in eth_sendRawTransaction to bloXroute's private BDN for Base (chain 8453).
 * Configured via env:
 *   - BLOXROUTE_BASE_AUTH   (required)  — auth header value from bloXroute dashboard
 *   - BLOXROUTE_BASE_URL    (optional)  — overrides default endpoint; must be *.blxrbdn.com
 *
 * Safety:
 *   - Accepts ONLY pre-signed raw transaction hex (0x-prefixed). No signing here.
 *   - URL allowlist: host must end with .blxrbdn.com to prevent exfil via poisoned config.
 *   - Fails fast via AbortSignal (default 5s). Never blocks the hot path.
 */

const DEFAULT_BLOXROUTE_BASE_URL = "https://eth-protect.rpc.blxrbdn.com";
const DEFAULT_BLOXROUTE_TIMEOUT_MS = 5_000;

export interface BloxrouteConfig {
  url: string;
  authHeader: string;
  timeoutMs: number;
}

function validateBloxrouteUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("BLOXROUTE_BASE_URL not in allowlist");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (!hostname.endsWith(".blxrbdn.com") && hostname !== "blxrbdn.com")
  ) {
    throw new Error("BLOXROUTE_BASE_URL not in allowlist");
  }

  return parsed.toString();
}

function parseTimeoutMs(value: string | undefined): number {
  if (!value) return DEFAULT_BLOXROUTE_TIMEOUT_MS;
  const timeoutMs = Number.parseInt(value, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_BLOXROUTE_TIMEOUT_MS;
  return timeoutMs;
}

function normalizeAuthHeader(rawAuth: string): string {
  const trimmed = rawAuth.trim();
  if (trimmed.length === 0) {
    throw new Error("BLOXROUTE_BASE_AUTH missing");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("BLOXROUTE_BASE_AUTH contains whitespace");
  }
  return trimmed;
}

export function loadBloxrouteConfig(opts?: {
  envOverride?: NodeJS.ProcessEnv;
}): BloxrouteConfig | null {
  const env = opts?.envOverride ?? process.env;
  const rawAuth = env.BLOXROUTE_BASE_AUTH;
  if (!rawAuth) return null;

  const url = validateBloxrouteUrl(env.BLOXROUTE_BASE_URL ?? DEFAULT_BLOXROUTE_BASE_URL);
  const authHeader = normalizeAuthHeader(rawAuth);
  const timeoutMs = parseTimeoutMs(env.BLOXROUTE_TIMEOUT_MS);

  return {
    url,
    authHeader,
    timeoutMs,
  };
}

export async function sendViaBloxroute(args: {
  config: BloxrouteConfig;
  signedTx: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<`0x${string}`> {
  const { config, signedTx, fetchImpl } = args;
  const runFetch = fetchImpl ?? fetch;

  try {
    const response = await runFetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.authHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [signedTx],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    const payload = (await response.json()) as {
      result?: unknown;
      error?: { message?: unknown };
    };

    if (typeof payload.result === "string" && payload.result.startsWith("0x")) {
      return payload.result as `0x${string}`;
    }

    if (typeof payload.error?.message === "string" && payload.error.message.length > 0) {
      throw new Error(`bloxroute: ${payload.error.message}`);
    }

    throw new Error("bloxroute: empty result");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("bloxroute: ")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`bloxroute: ${message}`);
  }
}

export function buildBloxroutePromise(
  config: BloxrouteConfig,
  signedTx: `0x${string}`,
  fetchImpl?: typeof fetch,
): Promise<`0x${string}`> {
  return sendViaBloxroute({ config, signedTx, fetchImpl });
}
