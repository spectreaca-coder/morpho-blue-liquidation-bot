import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { keccak256, stringToHex, type Hex } from "viem";

const MAX_LOG_BYTES = 50 * 1024 * 1024;
const wallClockBaseMs = Date.now();
const performanceBaseMs = performance.now();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isShadowOnly(): boolean {
  return process.env.SHADOW_ONLY === "true";
}

export function nowEpochMs(): number {
  return wallClockBaseMs + (performance.now() - performanceBaseMs);
}

async function rotateIfNeeded(logPath: string): Promise<void> {
  try {
    const info = await stat(logPath);
    if (info.size < MAX_LOG_BYTES) return;
    await rename(logPath, `${logPath}.${Date.now()}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

/**
 * Vitest detection. Vitest sets `process.env.VITEST` automatically. Callers
 * exercising submitOrShadow / submit paths during tests would otherwise
 * pollute the production logs/shadow_submit_intent.jsonl on the host file
 * system (CWD-relative path). No-op the writer in test mode unless the
 * caller explicitly opts in via DISABLE_TEST_LOG_GUARD=true.
 */
function isVitestEnv(): boolean {
  if (process.env.DISABLE_TEST_LOG_GUARD === "true") return false;
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

export async function appendJsonlRecord(
  logPath: string,
  record: unknown,
  logPrefix: string,
): Promise<void> {
  if (isVitestEnv()) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await rotateIfNeeded(logPath);
    await appendFile(logPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.error(`${logPrefix} failed to write ${logPath}: ${getErrorMessage(error)}`);
  }
}

export function makeSyntheticTxHash(seed: string): Hex {
  return keccak256(stringToHex(seed));
}
