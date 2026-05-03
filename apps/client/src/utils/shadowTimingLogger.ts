import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Address, Hex } from "viem";

import { isShadowOnly } from "./shadow-runtime.js";

const DEFAULT_LOG_PATH = "logs/shadow_timing.jsonl";

export type TimingPath = "flashblock" | "poll" | "pending-prewarm" | "cex-presign" | "cex-direct";

export interface CandidateRef {
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
}

export interface OracleCtx {
  oracleAddress: string;
  oracleBlockNumber: number;
}

export interface CexCtx {
  cexPair: string;
  cexPrice: number;
}

interface ShadowTimingRowBase {
  eventId: string;
  oracleAddress: string | null;
  oracleBlockNumber: number | null;
  cexPair: string | null;
  cexPrice: number | null;
  triggerReceiveAt: number;
  handlerDispatchAt: number | null;
  candidateRef: CandidateRef | null;
  calldataReadyAt: number | null;
  signCompleteAt: number | null;
  wouldSubmitAt: number | null;
  cacheHit: boolean | null;
  skippedReason: string | null;
}

export type ShadowTimingRow =
  | (ShadowTimingRowBase & { path: "flashblock" })
  | (ShadowTimingRowBase & { path: "poll" })
  | (ShadowTimingRowBase & { path: "pending-prewarm" })
  | (ShadowTimingRowBase & { path: "cex-presign" })
  | (ShadowTimingRowBase & { path: "cex-direct" });

interface CandidateTimingState {
  ref: CandidateRef;
  calldataReadyAt: number | null;
  signCompleteAt: number | null;
  wouldSubmitAt: number | null;
  cacheHit: boolean | null;
  skippedReason: string | null;
}

export interface EventTimer {
  setHandlerDispatch(): void;
  addCandidate(ref: CandidateRef): void;
  setCalldataReady(ref: CandidateRef): void;
  setSignComplete(ref: CandidateRef, cacheHit?: boolean): void;
  setWouldSubmit(ref: CandidateRef): void;
  setSkipped(ref: CandidateRef, reason: string): void;
  flush(): void;
}

let writesDisabled = false;

const noopTimer: EventTimer = {
  setHandlerDispatch() {},
  addCandidate() {},
  setCalldataReady() {},
  setSignComplete() {},
  setWouldSubmit() {},
  setSkipped() {},
  flush() {},
};

function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

function getLogPath(): string {
  return process.env.SHADOW_TIMING_LOG_PATH || DEFAULT_LOG_PATH;
}

function candidateKey(ref: CandidateRef): string {
  return `${ref.borrower.toLowerCase()}:${ref.marketId.toLowerCase()}`;
}

function writeRows(rows: ShadowTimingRow[]): boolean {
  if (writesDisabled || rows.length === 0) {
    return false;
  }

  const logPath = getLogPath();

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      rows
        .map((row) => JSON.stringify(row))
        .join("\n")
        .concat("\n"),
      "utf8",
    );
    return true;
  } catch (error) {
    writesDisabled = true;
    console.error(
      `[shadow-timing] failed to write ${logPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export function emitTimingRow(row: ShadowTimingRow): boolean {
  return writeRows([row]);
}

export function createEventTimer(
  path: TimingPath,
  oracleCtx?: OracleCtx,
  cexCtx?: CexCtx,
): EventTimer {
  if (!isShadowOnly()) {
    return noopTimer;
  }

  const eventId = randomUUID();
  const triggerReceiveAt = nowMs();
  let handlerDispatchAt: number | null = null;
  const candidates = new Map<string, CandidateTimingState>();

  const ensureCandidate = (ref: CandidateRef): CandidateTimingState => {
    const key = candidateKey(ref);
    const existing = candidates.get(key);
    if (existing) {
      if (existing.ref.collateralSymbol.length === 0 && ref.collateralSymbol.length > 0) {
        existing.ref = ref;
      }
      return existing;
    }

    const state: CandidateTimingState = {
      ref,
      calldataReadyAt: null,
      signCompleteAt: null,
      wouldSubmitAt: null,
      cacheHit: null,
      skippedReason: null,
    };
    candidates.set(key, state);
    return state;
  };

  return {
    setHandlerDispatch(): void {
      handlerDispatchAt = nowMs();
    },

    addCandidate(ref: CandidateRef): void {
      ensureCandidate(ref);
    },

    setCalldataReady(ref: CandidateRef): void {
      ensureCandidate(ref).calldataReadyAt = nowMs();
    },

    setSignComplete(ref: CandidateRef, cacheHit?: boolean): void {
      const state = ensureCandidate(ref);
      state.signCompleteAt = nowMs();
      if (cacheHit !== undefined) {
        state.cacheHit = cacheHit;
      }
    },

    setWouldSubmit(ref: CandidateRef): void {
      ensureCandidate(ref).wouldSubmitAt = nowMs();
    },

    setSkipped(ref: CandidateRef, reason: string): void {
      const state = ensureCandidate(ref);
      state.skippedReason = reason;
      state.wouldSubmitAt = null;
    },

    flush(): void {
      if (candidates.size === 0) {
        return;
      }

      const rows: ShadowTimingRow[] = [];
      for (const candidate of candidates.values()) {
        rows.push({
          eventId,
          path,
          oracleAddress: oracleCtx?.oracleAddress ?? null,
          oracleBlockNumber: oracleCtx?.oracleBlockNumber ?? null,
          cexPair: cexCtx?.cexPair ?? null,
          cexPrice: cexCtx?.cexPrice ?? null,
          triggerReceiveAt,
          handlerDispatchAt,
          candidateRef: candidate.ref,
          calldataReadyAt: candidate.calldataReadyAt,
          signCompleteAt: candidate.signCompleteAt,
          wouldSubmitAt: candidate.wouldSubmitAt,
          cacheHit: candidate.cacheHit,
          skippedReason: candidate.skippedReason,
        });
      }

      writeRows(rows);
    },
  };
}

export function _resetShadowTimingLoggerForTests(): void {
  writesDisabled = false;
}
