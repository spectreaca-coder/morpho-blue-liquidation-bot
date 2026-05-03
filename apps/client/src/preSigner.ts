import type { Account, Address, Chain, Hex, Transport, WalletClient } from "viem";

/**
 * PreSigner caches fully signed raw transactions per borrower/market so the
 * submission path can skip local signing when the claimed nonce still matches.
 */

export interface PreSignedTx {
  signedTx: Hex;
  calldata: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  createdAt: number;
  borrower: Address;
  marketId: Hex;
}

export interface PreSignerConfig {
  /** Max age of cached TX in ms. */
  maxCacheAge: number;
}

const DEFAULT_CONFIG: PreSignerConfig = {
  maxCacheAge: 60_000,
};

export class PreSigner {
  private readonly cache = new Map<string, PreSignedTx>();
  private readonly client: WalletClient<Transport, Chain, Account>;
  private readonly executorAddress: Address;
  private readonly config: PreSignerConfig;

  constructor(
    client: WalletClient<Transport, Chain, Account>,
    executorAddress: Address,
    config?: Partial<PreSignerConfig>,
  ) {
    this.client = client;
    this.executorAddress = executorAddress;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Cache key for a position.
   */
  private key(borrower: Address, marketId: Hex): string {
    return `${borrower.toLowerCase()}:${marketId.toLowerCase()}`;
  }

  /**
   * Pre-sign and cache a raw transaction for later submission.
   */
  async presign(
    borrower: Address,
    marketId: Hex,
    calldata: Hex,
    nonce: number,
    gas: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
  ): Promise<Hex> {
    const key = this.key(borrower, marketId);

    const existing = this.cache.get(key);
    if (
      existing &&
      Date.now() - existing.createdAt < this.config.maxCacheAge &&
      existing.nonce === nonce &&
      existing.calldata === calldata &&
      existing.gas === gas &&
      existing.maxFeePerGas === maxFeePerGas &&
      existing.maxPriorityFeePerGas === maxPriorityFeePerGas
    ) {
      return existing.signedTx;
    }

    const signedTx = await this.client.signTransaction({
      account: this.client.account,
      to: this.executorAddress,
      data: calldata,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId: this.client.chain?.id,
      type: "eip1559" as const,
    });

    this.cache.set(key, {
      signedTx,
      calldata,
      nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      createdAt: Date.now(),
      borrower,
      marketId,
    });

    console.log(
      `[PreSigner] Cached TX for ${borrower} in market ${marketId.slice(0, 10)}... (nonce=${nonce})`,
    );

    return signedTx;
  }

  /**
   * Retrieve a cached raw transaction if it is still fresh.
   */
  get(borrower: Address, marketId: Hex): PreSignedTx | undefined {
    const key = this.key(borrower, marketId);
    const cached = this.cache.get(key);

    if (cached === undefined) return undefined;

    if (Date.now() - cached.createdAt > this.config.maxCacheAge) {
      this.cache.delete(key);
      return undefined;
    }

    return cached;
  }

  /**
   * Return all fresh cached raw transactions.
   */
  getAll(): PreSignedTx[] {
    const now = Date.now();
    const results: PreSignedTx[] = [];

    for (const [key, bundle] of this.cache.entries()) {
      if (now - bundle.createdAt > this.config.maxCacheAge) {
        this.cache.delete(key);
      } else {
        results.push(bundle);
      }
    }

    return results;
  }

  /**
   * Invalidate cache for a position (e.g., after successful liquidation or nonce change).
   */
  invalidate(borrower: Address, marketId: Hex): void {
    const key = this.key(borrower, marketId);
    if (this.cache.delete(key)) {
      console.log(`[PreSigner] Invalidated cache for ${borrower}`);
    }
  }

  /**
   * Invalidate ALL cached TXs (e.g., on nonce change).
   */
  invalidateAll(): void {
    const count = this.cache.size;
    this.cache.clear();
    if (count > 0) console.log(`[PreSigner] Invalidated all ${count} cached TXs`);
  }

  /**
   * Get cache stats for logging.
   */
  stats(): { count: number; oldestAge: number } {
    let oldestAge = 0;
    const now = Date.now();
    for (const bundle of this.cache.values()) {
      const age = now - bundle.createdAt;
      if (age > oldestAge) oldestAge = age;
    }
    return { count: this.cache.size, oldestAge };
  }
}
