import type { Account, Address, Chain, Transport, WalletClient } from "viem";
import { getTransactionCount } from "viem/actions";

export interface PrimaryWalletLease {
  readonly owner: string;
  readonly token: symbol;
}

export class PrimaryWalletCoordinator {
  private activeLease: PrimaryWalletLease | null = null;
  private readonly releasedLeases = new WeakSet<PrimaryWalletLease>();
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

    if (this.nextCachedNonce === undefined) {
      this.nextCachedNonce = await getTransactionCount(this.client, {
        address: this.client.account.address,
        blockTag: "pending",
      });
    }

    const nonce = this.nextCachedNonce;
    this.nextCachedNonce += 1;
    return nonce;
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

  private assertActive(lease: PrimaryWalletLease, operation: string): void {
    if (this.activeLease !== lease || this.releasedLeases.has(lease)) {
      throw new Error(
        `${this.logTag}PrimaryWalletCoordinator: ${operation} requires the active wallet[0] lease`,
      );
    }
  }
}
