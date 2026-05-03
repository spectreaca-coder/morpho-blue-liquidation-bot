import type { Address, Hex } from "viem";

import {
  appendJsonlRecord,
  isShadowOnly,
  makeSyntheticTxHash,
  nowEpochMs,
} from "./shadow-runtime.js";

/** Public alias for isShadowOnly(). Hot-reload friendly (reads env each call). */
export function isShadowMode(): boolean {
  return isShadowOnly();
}

export type ShadowSubmitPath =
  | "alchemy"
  | "sequencer"
  | "bloxroute"
  | "write-contract"
  | "flashbots-bundle";

export interface ShadowCandidateRef {
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
}

export interface ShadowGasParams {
  nonce?: number;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface ShadowWriteArgs {
  address?: Address;
  functionName?: string;
}

export interface ShadowBundleArgs {
  txCount: number;
  targetBlockNumber?: string;
  blockCount?: number;
}

export interface ShadowSubmitMetadata {
  eventId?: string | null;
  triggerPath?: string | null;
  candidateRef?: ShadowCandidateRef | null;
  gasParams?: ShadowGasParams | null;
  serializedTx?: Hex | null;
  writeArgs?: ShadowWriteArgs | null;
  bundle?: ShadowBundleArgs | null;
  metadata?: Record<string, unknown> | null;
}

interface ShadowSubmitIntentRecord {
  type: "shadow_submit_intent";
  timestamp: number;
  eventId: string | null;
  path: ShadowSubmitPath;
  triggerPath: string | null;
  candidateRef: ShadowCandidateRef | null;
  gasParams: {
    nonce?: number;
    gas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  } | null;
  serializedTx: Hex | null;
  writeArgs: ShadowWriteArgs | null;
  bundle: ShadowBundleArgs | null;
  metadata: Record<string, unknown> | null;
  syntheticTxHash: Hex;
  shadowMode: true;
}

/**
 * Live-mode intent record — emitted BEFORE the actual submit fires.
 * Mirrors the shadow record's payload so forensic tooling can union-parse
 * both via the `type` discriminator. Schema-stable for downstream analysis.
 */
interface LiveSubmitIntentRecord {
  type: "live_submit_intent";
  timestamp: number;
  eventId: string | null;
  path: ShadowSubmitPath;
  triggerPath: string | null;
  candidateRef: ShadowCandidateRef | null;
  gasParams: {
    nonce?: number;
    gas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  } | null;
  serializedTx: Hex | null;
  writeArgs: ShadowWriteArgs | null;
  bundle: ShadowBundleArgs | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Live-mode outcome record — emitted AFTER the submit returns or throws.
 * Linkable to the preceding intent via (eventId, path, candidateRef, ts proximity).
 *
 * `txHash` is best-effort: populated only when the caller supplies an
 * `extractOutcome` callback that can pull a hash out of the generic result.
 * Generic `submitOrShadow<T>` cannot otherwise know the shape of T.
 */
interface LiveSubmitOutcomeRecord {
  type: "live_submit_outcome";
  timestamp: number;
  eventId: string | null;
  path: ShadowSubmitPath;
  triggerPath: string | null;
  candidateRef: ShadowCandidateRef | null;
  latencyMs: number;
  status: "accepted" | "error";
  txHash: string | null;
  errorMessage: string | null;
}

interface SubmitOrShadowArgs<T> extends ShadowSubmitMetadata {
  eventId?: string | null;
  path: ShadowSubmitPath;
  submit: () => Promise<T>;
  createSyntheticResult: (syntheticTxHash: Hex) => T | Promise<T>;
  /**
   * Optional callback to pull a tx hash out of the live submit result for
   * outcome logging. If omitted, outcome records still emit but with
   * `txHash: null`. Strictly informational — never affects control flow.
   */
  extractOutcome?: (result: T) => { txHash?: string | null };
}

const SHADOW_INTENT_LOG_PATH = "logs/shadow_submit_intent.jsonl";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  try {
    return String(err).slice(0, 500);
  } catch {
    return "<unprintable error>";
  }
}

// NOTE: submitOrShadow() covers direct write/send paths. ParallelSubmitter is a live
// raw-transaction lane for already signed CEX prewarm transactions; it must only be
// fed fully signed txs from paths that already made the shadow/live decision.

function serializeGasParams(gasParams: ShadowGasParams | null | undefined) {
  if (!gasParams) return null;
  return {
    nonce: gasParams.nonce,
    gas: gasParams.gas?.toString(),
    maxFeePerGas: gasParams.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas?.toString(),
  };
}

export async function submitOrShadow<T>(args: SubmitOrShadowArgs<T>): Promise<T> {
  if (!isShadowOnly()) {
    // LIVE PATH — emit intent + outcome records around the real submit so we
    // get continuous forensic coverage. Logging never affects submit semantics:
    // log failures degrade silently inside appendJsonlRecord (console.error)
    // and the original result/error from submit() is always what propagates.
    const startedAt = nowEpochMs();
    const intent: LiveSubmitIntentRecord = {
      type: "live_submit_intent",
      timestamp: startedAt,
      eventId: args.eventId ?? null,
      path: args.path,
      triggerPath: args.triggerPath ?? null,
      candidateRef: args.candidateRef ?? null,
      gasParams: serializeGasParams(args.gasParams),
      serializedTx: args.serializedTx ?? null,
      writeArgs: args.writeArgs ?? null,
      bundle: args.bundle ?? null,
      metadata: args.metadata ?? null,
    };
    // Fire intent log without blocking submit on disk I/O.
    void appendJsonlRecord(SHADOW_INTENT_LOG_PATH, intent, "[live-submit]");

    try {
      const result = await args.submit();
      let txHash: string | null = null;
      if (args.extractOutcome) {
        try {
          const extracted = args.extractOutcome(result);
          txHash = extracted?.txHash ?? null;
        } catch {
          // Extractor faulted — keep txHash null, swallow.
        }
      } else if (typeof result === "string" && (result as string).startsWith("0x")) {
        // Common case: direct write/send paths return a Hex tx hash. Capture it
        // without forcing every caller to wire extractOutcome.
        txHash = result as string;
      }
      const outcomeOk: LiveSubmitOutcomeRecord = {
        type: "live_submit_outcome",
        timestamp: nowEpochMs(),
        eventId: args.eventId ?? null,
        path: args.path,
        triggerPath: args.triggerPath ?? null,
        candidateRef: args.candidateRef ?? null,
        latencyMs: nowEpochMs() - startedAt,
        status: "accepted",
        txHash,
        errorMessage: null,
      };
      void appendJsonlRecord(SHADOW_INTENT_LOG_PATH, outcomeOk, "[live-submit]");
      return result;
    } catch (err) {
      const outcomeErr: LiveSubmitOutcomeRecord = {
        type: "live_submit_outcome",
        timestamp: nowEpochMs(),
        eventId: args.eventId ?? null,
        path: args.path,
        triggerPath: args.triggerPath ?? null,
        candidateRef: args.candidateRef ?? null,
        latencyMs: nowEpochMs() - startedAt,
        status: "error",
        txHash: null,
        errorMessage: getErrorMessage(err),
      };
      void appendJsonlRecord(SHADOW_INTENT_LOG_PATH, outcomeErr, "[live-submit]");
      throw err;
    }
  }

  const syntheticTxHash = makeSyntheticTxHash(
    JSON.stringify({
      path: args.path,
      eventId: args.eventId ?? null,
      triggerPath: args.triggerPath ?? null,
      candidateRef: args.candidateRef ?? null,
      gasParams: serializeGasParams(args.gasParams),
      serializedTx: args.serializedTx ?? null,
      writeArgs: args.writeArgs ?? null,
      bundle: args.bundle ?? null,
      metadata: args.metadata ?? null,
      ts: nowEpochMs(),
    }),
  );

  const record: ShadowSubmitIntentRecord = {
    type: "shadow_submit_intent",
    timestamp: nowEpochMs(),
    eventId: args.eventId ?? null,
    path: args.path,
    triggerPath: args.triggerPath ?? null,
    candidateRef: args.candidateRef ?? null,
    gasParams: serializeGasParams(args.gasParams),
    serializedTx: args.serializedTx ?? null,
    writeArgs: args.writeArgs ?? null,
    bundle: args.bundle ?? null,
    metadata: args.metadata ?? null,
    syntheticTxHash,
    shadowMode: true,
  };

  await appendJsonlRecord(SHADOW_INTENT_LOG_PATH, record, "[shadow-submit]");
  return args.createSyntheticResult(syntheticTxHash);
}

export async function submitBundleOrShadow<T>(args: SubmitOrShadowArgs<T>): Promise<T> {
  return submitOrShadow(args);
}
