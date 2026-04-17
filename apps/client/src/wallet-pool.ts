/**
 * WalletPool — multi-wallet management for concurrent liquidation execution.
 *
 * Manages a pool of wallet+executor pairs so multiple liquidation TXs can be
 * sent simultaneously without nonce collisions. Supports market affinity
 * (preferred wallet per market type) with idle-wallet fallback.
 *
 * In single-wallet mode (default, backward compatible), the pool holds exactly
 * one entry and behaves identically to the previous single-client approach.
 */

import type { Account, Address, Chain, Transport, WalletClient } from "viem";

export interface WalletEntry {
  /** The viem WalletClient used to sign and send transactions. */
  client: WalletClient<Transport, Chain, Account>;
  /** On-chain executor contract address this wallet is authorized to call. */
  executorAddress: Address;
  /**
   * Lower-case substring patterns for collateral symbols this wallet prefers.
   * e.g. ["btc", "wbtc", "cbbtc"] — matched case-insensitively against market symbols.
   * Empty array = no affinity (used as general-purpose overflow wallet).
   */
  marketAffinity: string[];
  /** True while a TX is in-flight; wallet will not be acquired again until released. */
  inFlight: boolean;
  /** Index in the pool array, used for logging. */
  index: number;
}

export class WalletPool {
  private readonly wallets: WalletEntry[];
  private readonly logTag: string;
  /** Auto-release safety net: release a wallet if no explicit release after this many ms. */
  private readonly autoReleaseTimeout: number = 10_000;
  /** Active auto-release timers keyed by wallet index. */
  private readonly releaseTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * Creates a WalletPool.
   *
   * @param entries - Array of wallet entries. Must contain at least one entry.
   * @param logTag - Log prefix inherited from the chain client (e.g. "[Base client]: ").
   */
  constructor(
    entries: {
      client: WalletClient<Transport, Chain, Account>;
      executorAddress: Address;
      marketAffinity: string[];
    }[],
    logTag: string,
  ) {
    if (entries.length === 0) {
      throw new Error("WalletPool requires at least one wallet entry.");
    }

    this.logTag = logTag;
    this.wallets = entries.map((e, i) => ({
      client: e.client,
      executorAddress: e.executorAddress,
      marketAffinity: e.marketAffinity.map((s) => s.toLowerCase()),
      inFlight: false,
      index: i,
    }));

    console.log(
      `${this.logTag}WalletPool: ${this.wallets.length} wallet(s) configured ` +
        `(addresses: ${this.wallets.map((w) => w.executorAddress).join(", ")})`,
    );
  }

  /** Total number of wallets in the pool. */
  get size(): number {
    return this.wallets.length;
  }

  /** Number of currently idle (not in-flight) wallets. */
  get idleCount(): number {
    return this.wallets.filter((w) => !w.inFlight).length;
  }

  /**
   * Acquires an idle wallet for the given market symbol patterns.
   *
   * Selection priority:
   *   1. First idle wallet whose marketAffinity contains any of the given patterns.
   *   2. Any idle wallet (overflow — ignores affinity).
   *   3. null — all wallets busy, caller should skip this opportunity.
   *
   * The acquired wallet is marked inFlight immediately. An auto-release timer is
   * set as a safety net in case the caller fails to call release().
   *
   * @param symbolPatterns - Lower-case collateral symbol substrings to match affinity.
   *                         Pass undefined or [] to use any idle wallet.
   * @returns The acquired WalletEntry, or null if no idle wallet is available.
   */
  acquire(symbolPatterns?: string[]): WalletEntry | null {
    const normalizedPatterns = (symbolPatterns ?? []).map((s) => s.toLowerCase());

    // Pass 1: wallet with matching affinity
    let chosen: WalletEntry | null = null;

    if (normalizedPatterns.length > 0) {
      for (const wallet of this.wallets) {
        if (wallet.inFlight) continue;
        const hasAffinity = wallet.marketAffinity.some((affinity) =>
          normalizedPatterns.some(
            (pattern) => affinity.includes(pattern) || pattern.includes(affinity),
          ),
        );
        if (hasAffinity) {
          chosen = wallet;
          break;
        }
      }
    }

    // Pass 2: any idle wallet (overflow)
    if (chosen === null) {
      for (const wallet of this.wallets) {
        if (!wallet.inFlight) {
          chosen = wallet;
          break;
        }
      }
    }

    if (chosen === null) {
      console.log(
        `${this.logTag}WalletPool: all ${this.wallets.length} wallet(s) in-flight — skipping opportunity`,
      );
      return null;
    }

    chosen.inFlight = true;

    // Auto-release safety net
    const timer = setTimeout(() => {
      if (chosen.inFlight) {
        console.log(
          `${this.logTag}WalletPool: auto-releasing wallet[${chosen.index}] ` +
            `(executor ${chosen.executorAddress}) after ${this.autoReleaseTimeout}ms timeout`,
        );
        this.release(chosen);
      }
    }, this.autoReleaseTimeout);
    this.releaseTimers.set(chosen.index, timer);

    console.log(
      `${this.logTag}WalletPool: acquired wallet[${chosen.index}] ` +
        `(executor ${chosen.executorAddress}) — ` +
        `${this.idleCount} idle remaining`,
    );

    return chosen;
  }

  /**
   * Releases a wallet back to the pool (marks it idle).
   * Safe to call multiple times — idempotent.
   *
   * @param wallet - The WalletEntry previously returned by acquire().
   */
  release(wallet: WalletEntry): void {
    if (!wallet.inFlight) return; // Already released — idempotent

    wallet.inFlight = false;

    // Clear the auto-release timer if it exists
    const timer = this.releaseTimers.get(wallet.index);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.releaseTimers.delete(wallet.index);
    }

    console.log(
      `${this.logTag}WalletPool: released wallet[${wallet.index}] ` +
        `(executor ${wallet.executorAddress}) — ` +
        `${this.idleCount} idle now`,
    );
  }

  /**
   * Returns true if any wallet is currently acquired (in-flight).
   * Used by the CEX predictor path to avoid nonce races when the Flashblock
   * batch path has acquired a wallet but hasn't yet set isBatchInFlight.
   */
  isAnyAcquired(): boolean {
    return this.wallets.some((w) => w.inFlight);
  }

  /**
   * Returns the primary (index 0) wallet entry without marking it in-flight.
   * Used for the bot.fastLiquidate() path which manages its own nonce/lifecycle.
   */
  get primary(): WalletEntry {
    return this.wallets[0]!;
  }
}
