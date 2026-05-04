import type { Hex, PublicClient } from "viem";

import type { CompetitorIntelLogger } from "./competitorIntelLogger.js";
import { isShadowOnly } from "./utils/shadow-runtime.js";

export interface SubmitResult {
  path: "alchemy" | "bloxroute" | "ankr";
  txHash: Hex;
  submitMs: number;
  responseMs: number;
  rpcStatus: "accepted" | "rejected" | "error";
  errorMessage?: string;
}

export interface RpcSubmitter {
  name: "alchemy" | "bloxroute" | "ankr";
  send(signedTx: Hex): Promise<SubmitResult>;
  /**
   * True iff this submitter has all the configuration needed to actually fire.
   * Used by the startup banner to report only the paths that will run, instead
   * of guessing from raw env vars (which could lie — e.g. an Ankr URL that the
   * submitter then nullifies internally for being unauthenticated).
   */
  isEnabled(): boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnauthenticatedAnkrBaseUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.hostname === "rpc.ankr.com" && url.pathname === "/base";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AlchemySubmitter — wraps existing publicClient.sendRawTransaction
// ---------------------------------------------------------------------------
export class AlchemySubmitter implements RpcSubmitter {
  readonly name = "alchemy";
  private readonly publicClient: PublicClient;

  constructor(publicClient: PublicClient) {
    this.publicClient = publicClient;
  }

  isEnabled(): boolean {
    return this.publicClient !== undefined;
  }

  async send(signedTx: Hex): Promise<SubmitResult> {
    const submitMs = Date.now();
    if (isShadowOnly()) {
      return {
        path: this.name,
        txHash: "0xshadow" as Hex,
        submitMs,
        responseMs: 0,
        rpcStatus: "accepted",
        errorMessage: "shadow_skip",
      };
    }
    try {
      const txHash = await this.publicClient.sendRawTransaction({
        serializedTransaction: signedTx,
      });
      return {
        path: this.name,
        txHash,
        submitMs,
        responseMs: Date.now() - submitMs,
        rpcStatus: "accepted",
      };
    } catch (error: unknown) {
      return {
        path: this.name,
        txHash: "0x",
        submitMs,
        responseMs: Date.now() - submitMs,
        rpcStatus: "error",
        errorMessage: getErrorMessage(error),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// BloxrouteSubmitter — HTTP POST to bloXroute Base relay
// ---------------------------------------------------------------------------
export class BloxrouteSubmitter implements RpcSubmitter {
  readonly name = "bloxroute";
  private readonly endpoint: string;
  private readonly authHeader: string | undefined;

  constructor() {
    this.endpoint =
      process.env.BLXR_BASE_RPC ?? process.env.BLOXROUTE_BASE_URL ?? "https://api.blxrbdn.com";
    this.authHeader = process.env.BLXR_AUTH_HEADER ?? process.env.BLOXROUTE_BASE_AUTH;
  }

  isEnabled(): boolean {
    return this.authHeader !== undefined && this.authHeader.length > 0;
  }

  async send(signedTx: Hex): Promise<SubmitResult> {
    const submitMs = Date.now();
    if (isShadowOnly()) {
      return {
        path: this.name,
        txHash: "0xshadow" as Hex,
        submitMs,
        responseMs: 0,
        rpcStatus: "accepted",
        errorMessage: "shadow_skip",
      };
    }

    if (!this.authHeader) {
      return {
        path: this.name,
        txHash: "0x",
        submitMs,
        responseMs: 0,
        rpcStatus: "error",
        errorMessage: "disabled: missing auth",
      };
    }

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_sendRawTransaction",
          params: [signedTx],
          id: 1,
        }),
      });

      const responseMs = Date.now() - submitMs;
      const json = (await res.json()) as { result?: string; error?: { message?: string } };

      if (json.result) {
        return {
          path: this.name,
          txHash: json.result as Hex,
          submitMs,
          responseMs,
          rpcStatus: "accepted",
        };
      }

      const errMsg = json.error?.message ?? `HTTP ${res.status}`;
      return {
        path: this.name,
        txHash: "0x",
        submitMs,
        responseMs,
        rpcStatus: "rejected",
        errorMessage: errMsg,
      };
    } catch (error: unknown) {
      return {
        path: this.name,
        txHash: "0x",
        submitMs,
        responseMs: Date.now() - submitMs,
        rpcStatus: "error",
        errorMessage: getErrorMessage(error),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// AnkrSubmitter — wraps RPC_URL_FALLBACK_8453 if set
// ---------------------------------------------------------------------------
export class AnkrSubmitter implements RpcSubmitter {
  readonly name = "ankr";
  private readonly rpcUrl: string | undefined;

  constructor() {
    const rawUrl = process.env.RPC_URL_FALLBACK_8453;
    this.rpcUrl = isUnauthenticatedAnkrBaseUrl(rawUrl) ? undefined : rawUrl;
  }

  isEnabled(): boolean {
    return this.rpcUrl !== undefined;
  }

  async send(signedTx: Hex): Promise<SubmitResult> {
    const submitMs = Date.now();
    if (isShadowOnly()) {
      return {
        path: this.name,
        txHash: "0xshadow" as Hex,
        submitMs,
        responseMs: 0,
        rpcStatus: "accepted",
        errorMessage: "shadow_skip",
      };
    }

    if (!this.rpcUrl) {
      return {
        path: this.name,
        txHash: "0x",
        submitMs,
        responseMs: 0,
        rpcStatus: "error",
        errorMessage: "disabled: missing RPC_URL_FALLBACK_8453",
      };
    }

    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_sendRawTransaction",
          params: [signedTx],
          id: 1,
        }),
      });

      const responseMs = Date.now() - submitMs;
      const json = (await res.json()) as { result?: string; error?: { message?: string } };

      if (json.result) {
        return {
          path: this.name,
          txHash: json.result as Hex,
          submitMs,
          responseMs,
          rpcStatus: "accepted",
        };
      }

      const errMsg = json.error?.message ?? `HTTP ${res.status}`;
      return {
        path: this.name,
        txHash: "0x",
        submitMs,
        responseMs,
        rpcStatus: "rejected",
        errorMessage: errMsg,
      };
    } catch (error: unknown) {
      return {
        path: this.name,
        txHash: "0x",
        submitMs,
        responseMs: Date.now() - submitMs,
        rpcStatus: "error",
        errorMessage: getErrorMessage(error),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// ParallelSubmitter — race all submitters; first accepted wins
// ---------------------------------------------------------------------------
export class ParallelSubmitter {
  private readonly submitters: RpcSubmitter[];
  private readonly logger: CompetitorIntelLogger | undefined;
  private readonly logTag: string;

  constructor(args: {
    submitters: RpcSubmitter[];
    logger?: CompetitorIntelLogger;
    logTag: string;
  }) {
    this.submitters = args.submitters;
    this.logger = args.logger;
    this.logTag = args.logTag;
  }

  /**
   * Fire all submitters concurrently. Returns the first accepted result.
   * Losers and errors are logged silently — nonce collisions are expected and OK.
   * Never throws: if all fail, returns the first available result (error).
   */
  async send(signedTx: Hex): Promise<SubmitResult> {
    // Capture last-resort fallback result for all-fail scenario
    let lastResult: SubmitResult | undefined;

    const promises = this.submitters.map((s) =>
      s.send(signedTx).then((result) => {
        // Fire-and-forget logging for every path
        if (this.logger) {
          void this.logger.recordSubmitAttempt({
            ts: result.submitMs,
            txHash: result.txHash,
            path: result.path,
            submitMs: result.submitMs,
            responseMs: result.responseMs,
            rpcStatus: result.rpcStatus,
            errorMessage: result.errorMessage,
          });
        }
        lastResult = result;
        if (result.rpcStatus !== "accepted") {
          // Reject so Promise.any skips this path; wrap in Error to satisfy lint rule
          throw new Error(`path=${result.path} rpcStatus=${result.rpcStatus}`);
        }
        return result;
      }),
    );

    try {
      return await Promise.any(promises);
    } catch {
      // All paths failed — return the last captured result, or a synthetic error
      if (lastResult) {
        console.error(
          `${this.logTag}[ParallelSubmitter] all paths failed; last result: path=${lastResult.path} err=${lastResult.errorMessage ?? "unknown"}`,
        );
        return lastResult;
      }
      // Submitters list was empty (shouldn't happen)
      return {
        path: "alchemy",
        txHash: "0x",
        submitMs: Date.now(),
        responseMs: 0,
        rpcStatus: "error",
        errorMessage: "no submitters configured",
      };
    }
  }

  getSubmitters(): RpcSubmitter[] {
    return [...this.submitters];
  }
}
