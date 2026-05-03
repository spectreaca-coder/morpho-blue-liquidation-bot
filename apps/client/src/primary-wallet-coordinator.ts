import type { Account, Address, Chain, Transport, WalletClient } from "viem";
import { getTransactionCount } from "viem/actions";

export interface PrimaryWalletLease {
  readonly owner: string;
  readonly token: symbol;
}

export class PrimaryWalletCoordinator {
  private activeLease: PrimaryWalletLease | null = null;
  private readonly releasedLeases = new WeakSet<PrimaryWalletLease>();
  private readonly nonceReservations = new Map<number, { owner: string; expiresAt: number }>();
  private nextCachedNonce: number | undefined;

  constructor(
    public readonly client: WalletClient<Transport, Chain, Account>,
    public readonly executorAddress: Address,
    private readonly logTag: string,
  ) {}

  tryAcquire(owner: string): PrimaryWalletLease | null {
    if (this.activeLease !== null) return null;

    const lease: PrimaryWalletLease = { owner, token: Symbol(owner) };
    this.activeLease = lease;
    return lease;
  }

  async nextNonce(lease: PrimaryWalletLease): Promise<number> {
    this.assertActive(lease, "nextNonce");
    this.pruneExpiredReservations();

    if (this.nextCachedNonce === undefined) {
      this.nextCachedNonce = await getTransactionCount(this.client, {
        address: this.client.account.address,
        blockTag: "pending",
      });
    }

    const nonce = this.nextCachedNonce;
    const reservation = this.nonceReservations.get(nonce);
    if (reservation !== undefined) {
      throw new Error(
        `${this.logTag}PrimaryWalletCoordinator: nonce ${nonce} is reserved by ${reservation.owner}`,
      );
    }

    this.nextCachedNonce += 1;
    return nonce;
  }

  async reserveNonce(owner: string, ttlMs: number): Promise<number> {
    this.pruneExpiredReservations();

    if (this.nextCachedNonce === undefined) {
      this.nextCachedNonce = await getTransactionCount(this.client, {
        address: this.client.account.address,
        blockTag: "pending",
      });
    }

    let nonce = this.nextCachedNonce;
    while (this.nonceReservations.has(nonce)) nonce += 1;
    this.nonceReservations.set(nonce, { owner, expiresAt: Date.now() + ttlMs });
    this.nextCachedNonce = nonce + 1;
    return nonce;
  }

  claimReservedNonce(lease: PrimaryWalletLease, nonce: number): boolean {
    this.assertActive(lease, "claimReservedNonce");
    this.pruneExpiredReservations();
    if (!this.nonceReservations.delete(nonce)) return false;
    return true;
  }

  consumeReservedNonce(nonce: number): boolean {
    this.pruneExpiredReservations();
    return this.nonceReservations.delete(nonce);
  }

  releaseReservedNonce(nonce: number): void {
    if (this.nonceReservations.delete(nonce)) {
      this.nextCachedNonce = undefined;
    }
  }

  resetNonceCacheForExternalSubmit(): void {
    this.nextCachedNonce = undefined;
  }

  rollbackNonce(lease: PrimaryWalletLease, nonce: number): void {
    this.assertActive(lease, "rollbackNonce");

    if (this.nextCachedNonce === nonce + 1) {
      this.nextCachedNonce = nonce;
      return;
    }

    console.warn(
      `${this.logTag}PrimaryWalletCoordinator: nonce rollback for ${lease.owner} ` +
        `could not prove local state (nonce=${nonce}, cached=${this.nextCachedNonce ?? "unset"}) — resetting cache`,
    );
    this.nextCachedNonce = undefined;
  }

  resetNonceCache(lease: PrimaryWalletLease): void {
    this.assertActive(lease, "resetNonceCache");
    this.nextCachedNonce = undefined;
    this.nonceReservations.clear();
  }

  release(lease: PrimaryWalletLease): void {
    if (this.releasedLeases.has(lease)) return;

    this.releasedLeases.add(lease);
    if (this.activeLease !== lease) return;

    this.activeLease = null;
  }

  get isBusy(): boolean {
    return this.activeLease !== null;
  }

  get hasReservedNonces(): boolean {
    this.pruneExpiredReservations();
    return this.nonceReservations.size > 0;
  }

  private pruneExpiredReservations(): void {
    const now = Date.now();
    let pruned = false;
    for (const [nonce, reservation] of this.nonceReservations) {
      if (reservation.expiresAt <= now) {
        this.nonceReservations.delete(nonce);
        pruned = true;
      }
    }
    if (pruned) this.nextCachedNonce = undefined;
  }

  private assertActive(lease: PrimaryWalletLease, operation: string): void {
    if (this.activeLease !== lease || this.releasedLeases.has(lease)) {
      throw new Error(
        `${this.logTag}PrimaryWalletCoordinator: ${operation} requires the active wallet[0] lease`,
      );
    }
  }
}
