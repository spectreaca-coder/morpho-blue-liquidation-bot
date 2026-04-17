/**
 * NonceManager — tracks the next pending nonce per wallet index.
 *
 * Eliminates repeated eth_getTransactionCount RPC calls on the hot path.
 * Initialized lazily on first use, then incremented locally after each TX.
 * Callers must invoke reset() after a nonce-related send error so the next
 * call re-fetches the true pending nonce from chain.
 */

import { type Account, type Chain, type Transport, type WalletClient } from "viem";
import { getTransactionCount } from "viem/actions";

export class NonceManager {
  private nonces = new Map<number, number>();

  /**
   * Returns the current nonce for the given wallet and increments the local counter.
   * On first use for a wallet index, fetches the pending nonce from chain (1 RPC call).
   * Subsequent calls within the same session are local-only (0 RPC calls).
   *
   * @param walletClient - The viem WalletClient for the wallet.
   * @param walletIndex - Index of the wallet in the pool (used as map key).
   * @returns The nonce to use for the next transaction.
   */
  async getAndIncrement(
    walletClient: WalletClient<Transport, Chain, Account>,
    walletIndex: number,
  ): Promise<number> {
    let nonce = this.nonces.get(walletIndex);
    if (nonce === undefined) {
      // First use: fetch pending nonce from chain (1 RPC call, one-time cost)
      nonce = await getTransactionCount(walletClient, {
        address: walletClient.account.address,
        blockTag: "pending",
      });
      this.nonces.set(walletIndex, nonce);
    }
    const current = nonce;
    this.nonces.set(walletIndex, nonce + 1);
    return current;
  }

  /**
   * Pre-warm the nonce cache for a wallet. Call during startup so the hot path
   * never needs to fetch from chain.
   */
  async preWarm(
    walletClient: WalletClient<Transport, Chain, Account>,
    walletIndex: number,
  ): Promise<void> {
    if (this.nonces.has(walletIndex)) return;
    const nonce = await getTransactionCount(walletClient, {
      address: walletClient.account.address,
      blockTag: "pending",
    });
    // Concurrency guard: getAndIncrement() may have run during the await and
    // already populated a value. Do not overwrite it — that would roll the
    // local counter back to a stale value and cause the next send to reuse
    // a nonce that has already been consumed in-memory.
    if (this.nonces.has(walletIndex)) return;
    this.nonces.set(walletIndex, nonce);
  }

  /**
   * Resets the cached nonce for a wallet so the next call re-fetches from chain.
   * Call this after a nonce-related error (e.g. "nonce too low", "replacement underpriced").
   *
   * @param walletIndex - Index of the wallet whose nonce should be cleared.
   */
  reset(walletIndex: number): void {
    this.nonces.delete(walletIndex);
  }
}
