/**
 * Canary Mode — Phase 2 production validation with hard safety caps.
 *
 * Purpose: Measure real-world win rate, latency, and P&L by running the bot
 * against live Base chain liquidations with strict loss limits. Produces
 * JSONL event logs and persistent state so a restart preserves cumulative
 * data.
 *
 * Safety model:
 *  - Daily/weekly gas cap (USD)
 *  - Cumulative loss cap (emergency stop)
 *  - Min profit gate (filter out pure detection noise)
 *  - Optional collateral whitelist
 *  - Auto-stop on loss cap breach; persistent `stopped` flag survives restart
 *
 * Metric philosophy (from self-critique 2026-04-11):
 *  - P&L-based, not win-rate-based. One whale win offsets many small reverts.
 *  - Per-event JSONL with full context for post-hoc analysis.
 *  - Latency instrumentation (flashblock → broadcast ms) is the key unknown.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface CanaryConfig {
  /** Master switch. When false, canary is a no-op pass-through. */
  enabled: boolean;
  /** Max gas USD spent today. Further attempts blocked when reached. */
  maxDailyGasUsd: number;
  /** Max gas USD spent this week. */
  maxWeeklyGasUsd: number;
  /** Cumulative net loss cap. When cumulativeProfit drops below -this, permanent stop. */
  maxCumulativeLossUsd: number;
  /** Min expected profit (USD) to attempt. Below this, skip. */
  minProfitGateUsd: number;
  /** Optional collateral whitelist. null means all markets allowed. */
  allowedCollaterals: Set<string> | null;
  /** Minimum samples before any auto-stop heuristic triggers (currently unused — P&L cap is primary stop). */
  autoStopMinSamples: number;
  /** JSONL file path for per-event results. */
  resultLogPath: string;
  /** JSON file path for persistent state (cumulative counters). */
  statePath: string;
}

export type CanaryEventType = "attempt" | "pass" | "revert" | "dropped" | "skipped";

/**
 * Morpho Blue liquidation incentive factor.
 * Docs: https://docs.morpho.org/learn/concepts/liquidation/
 * LIF(lltv) = min(1.15, 1 / (0.3 * lltv + 0.7)), with lltv expressed on [0, 1].
 */
export function estimateLiquidationBonusFactor(lltvWad: bigint): number {
  const BETA = 0.3;
  const MAX_LIF = 1.15;

  if (lltvWad === 0n) return 1.0;

  const lltv = Number(lltvWad) / 1e18;
  const lif = 1 / (BETA * lltv + (1 - BETA));
  return Math.min(MAX_LIF, lif);
}

export function estimateLiquidationProfitUsd(expectedBorrowUsd: number, lltvWad: bigint): number {
  return expectedBorrowUsd * (estimateLiquidationBonusFactor(lltvWad) - 1);
}

export interface CanaryEventRecord {
  /** Epoch ms of record creation. */
  timestamp: number;
  /** YYYY-MM-DD for daily bucketing. */
  eventDate: string;
  type: CanaryEventType;
  borrower: string;
  marketId: string;
  collateralSymbol: string;
  loanSymbol: string;
  /** Raw borrow notional in USD. Estimated profit is derived from this and LLTV. */
  expectedBorrowUsd: number;
  /** Morpho market LLTV in WAD units (1e18). */
  lltvWad: bigint;
  /** Estimated liquidation profit before gas, derived from expectedBorrowUsd and LLTV. */
  estimatedProfitUsd: number;
  /** Actual gas cost paid for this attempt (USD). 0 for skipped. */
  gasCostUsd: number;
  /** Net P&L: estimatedProfit - gasCost on pass, -gasCost on revert, 0 on skip/attempt. */
  actualProfitUsd: number;
  /** On-chain tx hash if broadcasted. */
  txHash?: string;
  /** Gas price paid (gwei). */
  effectiveGasPriceGwei?: number;
  /** Priority fee tip bid (gwei). */
  priorityFeeGwei?: number;
  /** Gas units used by the tx. */
  gasUsed?: string;
  /** Epoch ms of flashblock event reception. */
  flashblockReceivedMs?: number;
  /** Epoch ms when signing started. */
  signStartMs?: number;
  /** Epoch ms when writeContract returned (broadcast complete). */
  broadcastedMs?: number;
  /** Flashblock → broadcast delta (ms). */
  latencyMs?: number;
  /** Why we skipped (if type === skipped). */
  skipReason?: string;
  /** Error message (if type === revert/dropped). */
  errorMessage?: string;
}

interface CanaryState {
  /** Epoch ms when canary first started persisting state. */
  startedAt: number;
  totalAttempts: number;
  totalPass: number;
  totalRevert: number;
  totalSkipped: number;
  /** Sum of all (profit - gas) over life. */
  cumulativeProfitUsd: number;
  /** Sum of all gas USD spent (both wins and losses). */
  cumulativeGasSpentUsd: number;
  /** Per-day gas spent. Key: YYYY-MM-DD. */
  dailyGasSpentUsd: Record<string, number>;
  /** Per-week gas spent. Key: YYYY-MM-DD of Sunday. */
  weeklyGasSpentUsd: Record<string, number>;
  stopped: boolean;
  stoppedReason?: string;
  stoppedAt?: number;
}

export interface CanaryAllowDecision {
  allow: boolean;
  reason?: string;
}

export interface CanaryStats {
  enabled: boolean;
  stopped: boolean;
  stoppedReason?: string;
  totalAttempts: number;
  totalPass: number;
  totalRevert: number;
  totalSkipped: number;
  winRate: number;
  cumulativeProfitUsd: number;
  cumulativeGasSpentUsd: number;
  todayGasSpentUsd: number;
  todayGasCapUsd: number;
  weekGasSpentUsd: number;
  weekGasCapUsd: number;
  maxLossCapUsd: number;
  uptimeMs: number;
}

export class CanaryTracker {
  private config: CanaryConfig;
  private state: CanaryState;

  constructor(config: CanaryConfig) {
    this.config = config;
    this.state = this.loadState();
  }

  get enabled(): boolean {
    return this.config.enabled && !this.state.stopped;
  }

  get stopped(): boolean {
    return this.state.stopped;
  }

  get stoppedReason(): string | undefined {
    return this.state.stoppedReason;
  }

  /**
   * Decide whether to attempt a liquidation. Applies all gates in priority order:
   * stopped → enabled → profit → whitelist → daily cap → weekly cap → loss cap.
   */
  shouldAttempt(params: {
    collateralSymbol: string;
    expectedBorrowUsd: number;
    lltvWad: bigint;
  }): CanaryAllowDecision {
    if (this.state.stopped) {
      return { allow: false, reason: `canary stopped: ${this.state.stoppedReason ?? "unknown"}` };
    }
    if (!this.config.enabled) {
      // Pass-through when canary mode is off.
      return { allow: true };
    }

    const estimatedProfitUsd = estimateLiquidationProfitUsd(
      params.expectedBorrowUsd,
      params.lltvWad,
    );

    if (estimatedProfitUsd < this.config.minProfitGateUsd) {
      return {
        allow: false,
        reason: `profit gate: $${estimatedProfitUsd.toFixed(2)} < $${this.config.minProfitGateUsd}`,
      };
    }

    if (
      this.config.allowedCollaterals &&
      !this.config.allowedCollaterals.has(params.collateralSymbol)
    ) {
      return {
        allow: false,
        reason: `collateral ${params.collateralSymbol} not in whitelist`,
      };
    }

    const today = this.getToday();
    const dailyGas = this.state.dailyGasSpentUsd[today] ?? 0;
    if (dailyGas >= this.config.maxDailyGasUsd) {
      return {
        allow: false,
        reason: `daily gas cap: $${dailyGas.toFixed(2)} >= $${this.config.maxDailyGasUsd}`,
      };
    }

    const weekStart = this.getWeekStart();
    const weeklyGas = this.state.weeklyGasSpentUsd[weekStart] ?? 0;
    if (weeklyGas >= this.config.maxWeeklyGasUsd) {
      return {
        allow: false,
        reason: `weekly gas cap: $${weeklyGas.toFixed(2)} >= $${this.config.maxWeeklyGasUsd}`,
      };
    }

    const currentLoss = -this.state.cumulativeProfitUsd;
    if (currentLoss >= this.config.maxCumulativeLossUsd) {
      this.stop(`cumulative loss: $${currentLoss.toFixed(2)}`);
      return { allow: false, reason: this.state.stoppedReason };
    }

    return { allow: true };
  }

  /**
   * Record an attempt result. Persists state after every update.
   * Skipped events are logged but do not mutate financial counters.
   */
  recordResult(record: CanaryEventRecord): void {
    const normalizedRecord = this.normalizeRecord(record);
    this.appendToLog(normalizedRecord);

    if (normalizedRecord.type === "skipped") {
      this.state.totalSkipped += 1;
      this.saveState();
      return;
    }

    // "attempt" is logged-only (optimistic broadcast). Final counters wait for
    // receipt verification which fires a "pass", "revert", or "dropped" record.
    if (normalizedRecord.type === "attempt") {
      return;
    }

    this.state.totalAttempts += 1;

    if (normalizedRecord.type === "pass") {
      this.state.totalPass += 1;
    } else if (normalizedRecord.type === "revert") {
      this.state.totalRevert += 1;
    }

    this.state.cumulativeProfitUsd += normalizedRecord.actualProfitUsd;
    this.state.cumulativeGasSpentUsd += normalizedRecord.gasCostUsd;

    const date = normalizedRecord.eventDate;
    const weekStart = this.getWeekStart(normalizedRecord.timestamp);
    this.state.dailyGasSpentUsd[date] =
      (this.state.dailyGasSpentUsd[date] ?? 0) + normalizedRecord.gasCostUsd;
    this.state.weeklyGasSpentUsd[weekStart] =
      (this.state.weeklyGasSpentUsd[weekStart] ?? 0) + normalizedRecord.gasCostUsd;

    // Emergency stop after update.
    const currentLoss = -this.state.cumulativeProfitUsd;
    if (currentLoss >= this.config.maxCumulativeLossUsd) {
      this.stop(`cumulative loss hit cap: $${currentLoss.toFixed(2)}`);
    }

    this.saveState();
  }

  /** Manual or emergency stop. Idempotent. */
  stop(reason: string): void {
    if (this.state.stopped) return;
    this.state.stopped = true;
    this.state.stoppedReason = reason;
    this.state.stoppedAt = Date.now();

    console.error(`[canary] STOPPED: ${reason}`);
    this.saveState();
  }

  /** Manual resume (operator only). */
  resume(): void {
    this.state.stopped = false;
    this.state.stoppedReason = undefined;
    this.state.stoppedAt = undefined;
    this.saveState();
  }

  getStats(): CanaryStats {
    const attempts = this.state.totalPass + this.state.totalRevert;
    return {
      enabled: this.config.enabled,
      stopped: this.state.stopped,
      stoppedReason: this.state.stoppedReason,
      totalAttempts: this.state.totalAttempts,
      totalPass: this.state.totalPass,
      totalRevert: this.state.totalRevert,
      totalSkipped: this.state.totalSkipped,
      winRate: attempts > 0 ? this.state.totalPass / attempts : 0,
      cumulativeProfitUsd: this.state.cumulativeProfitUsd,
      cumulativeGasSpentUsd: this.state.cumulativeGasSpentUsd,
      todayGasSpentUsd: this.state.dailyGasSpentUsd[this.getToday()] ?? 0,
      todayGasCapUsd: this.config.maxDailyGasUsd,
      weekGasSpentUsd: this.state.weeklyGasSpentUsd[this.getWeekStart()] ?? 0,
      weekGasCapUsd: this.config.maxWeeklyGasUsd,
      maxLossCapUsd: this.config.maxCumulativeLossUsd,
      uptimeMs: Date.now() - this.state.startedAt,
    };
  }

  private loadState(): CanaryState {
    if (existsSync(this.config.statePath)) {
      try {
        const raw = readFileSync(this.config.statePath, "utf8");
        const parsed = JSON.parse(raw) as CanaryState;
        return parsed;
      } catch (e) {
        console.error(`[canary] failed to load state, starting fresh: ${(e as Error).message}`);
      }
    }
    return {
      startedAt: Date.now(),
      totalAttempts: 0,
      totalPass: 0,
      totalRevert: 0,
      totalSkipped: 0,
      cumulativeProfitUsd: 0,
      cumulativeGasSpentUsd: 0,
      dailyGasSpentUsd: {},
      weeklyGasSpentUsd: {},
      stopped: false,
    };
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.config.statePath), { recursive: true });
      writeFileSync(this.config.statePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch (e) {
      console.error(`[canary] failed to save state: ${(e as Error).message}`);
    }
  }

  private appendToLog(record: CanaryEventRecord): void {
    try {
      mkdirSync(dirname(this.config.resultLogPath), { recursive: true });
      appendFileSync(
        this.config.resultLogPath,
        JSON.stringify(record, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ) + "\n",
        "utf8",
      );
    } catch (e) {
      console.error(`[canary] failed to log result: ${(e as Error).message}`);
    }
  }

  private normalizeRecord(record: CanaryEventRecord): CanaryEventRecord {
    const estimatedProfitUsd = estimateLiquidationProfitUsd(
      record.expectedBorrowUsd,
      record.lltvWad,
    );

    if (record.type === "pass") {
      return {
        ...record,
        estimatedProfitUsd,
        actualProfitUsd: estimatedProfitUsd - record.gasCostUsd,
      };
    }

    if (record.type === "revert") {
      return {
        ...record,
        estimatedProfitUsd,
        actualProfitUsd: -record.gasCostUsd,
      };
    }

    return {
      ...record,
      estimatedProfitUsd,
    };
  }

  private getToday(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Returns Sunday date (YYYY-MM-DD) for the week containing ts (default: now). */
  private getWeekStart(ts?: number): string {
    const d = ts !== undefined ? new Date(ts) : new Date();
    // UTC week — keep consistent across timezones.
    const dayOfWeek = d.getUTCDay();
    const sunday = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayOfWeek),
    );
    return sunday.toISOString().slice(0, 10);
  }
}

/**
 * Load canary config from environment variables. All values are optional;
 * sensible defaults are applied. `CANARY_MODE=true` is required to enable gates.
 *
 * Env vars:
 *   CANARY_MODE                 — "true" to enable gates, anything else = off
 *   CANARY_MAX_DAILY_GAS_USD    — default 5
 *   CANARY_MAX_WEEKLY_GAS_USD   — default 25
 *   CANARY_MAX_LOSS_USD         — default 50 (cumulative stop)
 *   CANARY_MIN_PROFIT_USD       — default 1
 *   CANARY_ALLOWED_COLLATERALS  — comma-separated, empty = all (e.g. "cbBTC,WETH")
 *   CANARY_AUTO_STOP_MIN_SAMPLES — default 20
 *   CANARY_LOG_PATH             — default "logs/canary_results.jsonl"
 *   CANARY_STATE_PATH           — default "logs/canary_state.json"
 */
export function loadCanaryConfigFromEnv(): CanaryConfig {
  const enabled = (process.env.CANARY_MODE ?? "").toLowerCase() === "true";
  const allowedStr = process.env.CANARY_ALLOWED_COLLATERALS ?? "";
  const allowedCollaterals =
    allowedStr.trim().length > 0
      ? new Set(
          allowedStr
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        )
      : null;

  const numEnv = (key: string, fallback: number): number => {
    const v = process.env[key];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    enabled,
    maxDailyGasUsd: numEnv("CANARY_MAX_DAILY_GAS_USD", 5),
    maxWeeklyGasUsd: numEnv("CANARY_MAX_WEEKLY_GAS_USD", 25),
    maxCumulativeLossUsd: numEnv("CANARY_MAX_LOSS_USD", 50),
    minProfitGateUsd: numEnv("CANARY_MIN_PROFIT_USD", 1),
    allowedCollaterals,
    autoStopMinSamples: numEnv("CANARY_AUTO_STOP_MIN_SAMPLES", 20),
    resultLogPath: process.env.CANARY_LOG_PATH ?? "logs/canary_results.jsonl",
    statePath: process.env.CANARY_STATE_PATH ?? "logs/canary_state.json",
  };
}
