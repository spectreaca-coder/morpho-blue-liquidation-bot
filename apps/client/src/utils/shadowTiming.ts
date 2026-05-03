import { randomUUID } from "node:crypto";

import type { Address, Hex } from "viem";

import { appendJsonlRecord, isShadowOnly, nowEpochMs } from "./shadow-runtime.js";

export type ShadowTimingPath =
  | "flashblock"
  | "poll"
  | "pending-prewarm"
  | "cex-presign"
  | "cex-direct";

export interface ShadowCandidateRef {
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
}

export interface ShadowTimingBase {
  eventId: string;
  path: ShadowTimingPath;
  oracleAddress: string | null;
  oracleBlockNumber: number | null;
  cexPair: string | null;
  cexPrice: number | null;
  triggerReceiveAt: number;
  handlerDispatchAt: number;
}

export interface ShadowTimingRecord extends ShadowTimingBase {
  candidateRef: ShadowCandidateRef | null;
  calldataReadyAt: number | null;
  signCompleteAt: number | null;
  wouldSubmitAt: number | null;
  cacheHit: boolean | null;
  skippedReason: string | null;
}

const SHADOW_TIMING_LOG_PATH = "logs/shadow_timing.jsonl";

export function createShadowCandidateRef(
  borrower: Address,
  marketId: Hex,
  collateralSymbol: string,
): ShadowCandidateRef {
  return {
    borrower,
    marketId,
    collateralSymbol,
  };
}

export function createShadowTimingBase(args: {
  eventId?: string;
  path: ShadowTimingPath;
  oracleAddress?: string | null;
  oracleBlockNumber?: number | null;
  cexPair?: string | null;
  cexPrice?: number | null;
  triggerReceiveAt?: number | null;
  handlerDispatchAt?: number | null;
}): ShadowTimingBase | null {
  if (!isShadowOnly()) return null;
  return {
    eventId: args.eventId ?? randomUUID(),
    path: args.path,
    oracleAddress: args.oracleAddress ?? null,
    oracleBlockNumber: args.oracleBlockNumber ?? null,
    cexPair: args.cexPair ?? null,
    cexPrice: args.cexPrice ?? null,
    triggerReceiveAt: args.triggerReceiveAt ?? nowEpochMs(),
    handlerDispatchAt: args.handlerDispatchAt ?? nowEpochMs(),
  };
}

export function createShadowTimingRecord(
  base: ShadowTimingBase,
  overrides: Partial<ShadowTimingRecord> = {},
): ShadowTimingRecord {
  return {
    ...base,
    candidateRef: overrides.candidateRef ?? null,
    calldataReadyAt: overrides.calldataReadyAt ?? null,
    signCompleteAt: overrides.signCompleteAt ?? null,
    wouldSubmitAt: overrides.wouldSubmitAt ?? null,
    cacheHit: overrides.cacheHit ?? null,
    skippedReason: overrides.skippedReason ?? null,
  };
}

export async function emitShadowTimingRecord(record: ShadowTimingRecord | null): Promise<void> {
  if (record === null || !isShadowOnly()) return;
  await appendJsonlRecord(SHADOW_TIMING_LOG_PATH, record, "[shadow-timing]");
}
