import {
  type Account,
  type Chain,
  type FormattedTransactionRequest,
  type Hex,
  type LocalAccount,
  type Transport,
  type UnionOmit,
  type WalletClient,
  formatEther,
  keccak256,
  parseGwei,
  stringToBytes,
} from "viem";
import { estimateGas, getBlockNumber, getTransactionCount } from "viem/actions";

import { submitBundleOrShadow, type ShadowSubmitMetadata } from "./txSubmitter.js";

export namespace Flashbots {
  let nextId = 0;

  export const FLASHBOTS_RELAY = "https://relay.flashbots.net";

  interface FlashbotsRpcResponse {
    result?: {
      bundleHash?: string;
      sealedByBuildersAt?: unknown;
      isHighPriority?: boolean;
      simulatedAt?: string;
    };
    error?: { message?: string } | string;
  }

  function flashbotsErrorMessage(error: FlashbotsRpcResponse["error"], fallback: string): string {
    if (typeof error === "string") return error;
    return error?.message ?? fallback;
  }

  /**
   * Signs a Flashbots bundle with this provider's `authSigner` key.
   * @param bundledTransactions
   * @returns signed bundle
   *
   * @example
   * ```typescript
   * const bundle: Array<FlashbotsBundleRawTransaction> = [
   *    {signedTransaction: "0x02..."},
   *    {signedTransaction: "0x02..."},
   * ]
   * const signedBundle = await fbProvider.signBundle(bundle)
   * const blockNum = await provider.getBlockNumber()
   * const simResult = await fbProvider.simulate(signedBundle, blockNum + 1)
   * ```
   */
  export async function signBundle<client extends WalletClient<Transport, Chain, Account>>(
    bundle: {
      transaction: UnionOmit<FormattedTransactionRequest, "from">;
      client: client;
    }[],
  ) {
    const nonces: Record<string, number> = {};

    const signatures: Hex[] = [];
    for (const { transaction, client } of bundle) {
      const address = client.account.address;

      const nonce =
        transaction.nonce ?? nonces[address] ?? (await getTransactionCount(client, { address }));

      nonces[address] = nonce + 1;
      transaction.nonce ??= nonce;

      transaction.gas ??= await estimateGas(client, transaction); // TODO: Add target block number and timestamp when supported by geth

      signatures.push(await client.signTransaction(transaction));
    }

    return signatures;
  }

  /**
   * Sends a signed flashbots bundle to Flashbots Relay.
   * @param signedBundledTransactions array of raw signed transactions
   * @param targetBlockNumber block to target for bundle inclusion
   * @param opts (optional) settings
   * @returns callbacks for handling results, and the bundle hash
   *
   * @example
   * ```typescript
   * const bundle: Array<FlashbotsBundleRawTransaction> = [
   *    {signedTransaction: "0x02..."},
   *    {signedTransaction: "0x02..."},
   * ]
   * const signedBundle = await fbProvider.signBundle(bundle)
   * const blockNum = await provider.getBlockNumber()
   * const bundleRes = await fbProvider.sendRawBundle(signedBundle, blockNum + 1)
   * const success = (await bundleRes.wait()) === FlashbotsBundleResolution.BundleIncluded
   * ```
   */
  export async function sendRawBundle(
    txs: Hex[],
    targetBlockNumber: bigint,
    account: LocalAccount,
    shadowContext?: ShadowSubmitMetadata,
  ): Promise<{ bundleHash: string }> {
    return submitBundleOrShadow<{ bundleHash: string }>({
      path: "flashbots-bundle",
      ...shadowContext,
      bundle: {
        txCount: txs.length,
        targetBlockNumber: targetBlockNumber.toString(),
        blockCount: shadowContext?.bundle?.blockCount ?? 1,
      },
      metadata: {
        relay: "flashbots",
        ...(shadowContext?.metadata ?? {}),
      },
      extractOutcome: (result) => ({ txHash: result.bundleHash }),
      submit: async () => {
        const body = JSON.stringify({
          method: "eth_sendBundle",
          params: [
            {
              txs,
              blockNumber: `0x${targetBlockNumber.toString(16)}`,
            },
          ],
          id: nextId++,
          jsonrpc: "2.0",
        });

        const response = await fetch(FLASHBOTS_RELAY, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Flashbots-Signature": `${account.address}:${await account.signMessage({
              message: keccak256(stringToBytes(body)),
            })}`,
          },
          body,
        });

        const responseBody = (await response.json()) as FlashbotsRpcResponse;

        if (!response.ok || responseBody.error) {
          throw Error(flashbotsErrorMessage(responseBody.error, "eth_sendBundle failed"));
        }

        return { bundleHash: responseBody.result?.bundleHash ?? "unknown" };
      },
      createSyntheticResult: (syntheticTxHash) => ({ bundleHash: syntheticTxHash }),
    });
  }

  /**
   * Check bundle inclusion status via flashbots_getBundleStatsV2.
   */
  export async function getBundleStats(
    bundleHash: string,
    targetBlockNumber: bigint,
    account: LocalAccount,
  ): Promise<{ isIncluded: boolean; isHighPriority: boolean; simulatedAt?: string }> {
    const body = JSON.stringify({
      method: "flashbots_getBundleStatsV2",
      params: [{ bundleHash, blockNumber: `0x${targetBlockNumber.toString(16)}` }],
      id: nextId++,
      jsonrpc: "2.0",
    });

    const response = await fetch(FLASHBOTS_RELAY, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Flashbots-Signature": `${account.address}:${await account.signMessage({
          message: keccak256(stringToBytes(body)),
        })}`,
      },
      body,
    });

    const responseBody = (await response.json()) as FlashbotsRpcResponse;
    if (!response.ok || responseBody.error) {
      return { isIncluded: false, isHighPriority: false };
    }

    const result = responseBody.result;
    // Finding 4 fix (ultrareview): isSimulated + isHighPriority only confirm the RELAY
    // accepted the bundle with priority — they do NOT confirm on-chain inclusion.
    // A bundle can be simulated with high priority and still lose the block race.
    // Use `sealedByBuildersAt` (non-empty ⇒ at least one builder actually sealed the
    // bundle into a block) as the stronger on-chain inclusion proxy. Documented at
    // https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint#flashbots_getbundlestatsv2
    const sealedByBuilders: unknown = result?.sealedByBuildersAt;
    const isSealed = Array.isArray(sealedByBuilders) && sealedByBuilders.length > 0;
    return {
      isIncluded: isSealed,
      isHighPriority: result?.isHighPriority ?? false,
      simulatedAt: result?.simulatedAt,
    };
  }

  /**
   * Wait for bundle inclusion.
   *
   * Checks Flashbots stats API after all target blocks have passed.
   * Only waits once (~14s) rather than polling per block to avoid blocking
   * concurrent liquidations.
   */
  export async function waitForInclusion<client extends WalletClient<Transport, Chain, Account>>(
    walletClient: client,
    bundleHashes: { hash: string; targetBlock: bigint }[],
    flashbotAccount: LocalAccount,
  ): Promise<{ included: boolean; blockNumber?: bigint }> {
    if (bundleHashes.length === 0) return { included: false };

    const maxTarget = bundleHashes.reduce(
      (max, b) => (b.targetBlock > max ? b.targetBlock : max),
      0n,
    );

    // Wait for all target blocks to pass (~12s per block * TARGET_BLOCKS)
    // Single wait instead of per-block polling to reduce blocking
    const waitMs = TARGET_BLOCKS * 13_000 + 2_000; // extra 2s buffer
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const currentBlock = await getBlockNumber(walletClient);
    if (currentBlock < maxTarget) {
      // Blocks haven't passed yet; can't confirm
      return { included: false };
    }

    // Check each submitted bundle via stats API
    for (const { hash, targetBlock } of bundleHashes) {
      const stats = await getBundleStats(hash, targetBlock, flashbotAccount);
      if (stats.isIncluded) {
        return { included: true, blockNumber: targetBlock };
      }
    }

    return { included: false };
  }

  export const DEFAULT_TIP_BPS = 2500n; // 25%
  export const LOW_PRIORITY_FEE = parseGwei("1");
  export const MAX_WALLET_SPEND_BPS = 8000n; // 80%

  export function calculateCoinbaseTip(
    profitWei: bigint,
    tipBps: bigint = DEFAULT_TIP_BPS,
  ): bigint {
    return (profitWei * tipBps) / 10000n;
  }

  export function capTipToWalletBalance(
    tip: bigint,
    estimatedGasCost: bigint,
    walletBalance: bigint,
    maxSpendBps: bigint = MAX_WALLET_SPEND_BPS,
  ): bigint {
    const maxSpend = (walletBalance * maxSpendBps) / 10000n;
    if (tip + estimatedGasCost > maxSpend) {
      const available = maxSpend > estimatedGasCost ? maxSpend - estimatedGasCost : 0n;
      return available;
    }
    return tip;
  }

  /** Number of consecutive blocks to target with the same bundle. */
  export const TARGET_BLOCKS = 3;

  /**
   * Signs a bundle and returns it for multi-builder submission.
   * Does NOT send — caller decides where to send.
   */
  export async function signAndPrepareBundle<
    client extends WalletClient<Transport, Chain, Account>,
  >(
    liquidationTx: {
      transaction: UnionOmit<FormattedTransactionRequest, "from">;
      client: client;
    },
    flashbotAccount: LocalAccount,
    tipAmountWei: bigint,
    baseFee: bigint,
  ): Promise<{ signedBundle: Hex[]; blockNumber: bigint }> {
    const { client, transaction } = liquidationTx;

    const gasEstimate = transaction.gas ?? (await estimateGas(client, transaction));
    const tipAsPriorityFee = tipAmountWei > 0n ? tipAmountWei / gasEstimate : 0n;
    const effectivePriorityFee = tipAsPriorityFee + LOW_PRIORITY_FEE;

    const enhancedTx = {
      ...transaction,
      gas: gasEstimate,
      maxPriorityFeePerGas: effectivePriorityFee,
      maxFeePerGas: baseFee * 2n + effectivePriorityFee,
    } as UnionOmit<FormattedTransactionRequest, "from">;

    const signedBundle = await signBundle([{ transaction: enhancedTx, client }]);
    const blockNumber = await getBlockNumber(client);

    console.log(
      `[Flashbots] Signed bundle: tip ${formatEther(tipAmountWei)} ETH, priority ${effectivePriorityFee} wei/gas`,
    );

    return { signedBundle, blockNumber };
  }

  export async function sendBundleWithCoinbaseTip<
    client extends WalletClient<Transport, Chain, Account>,
  >(
    liquidationTx: {
      transaction: UnionOmit<FormattedTransactionRequest, "from">;
      client: client;
    },
    flashbotAccount: LocalAccount,
    tipAmountWei: bigint,
    baseFee: bigint,
  ): Promise<{ included: boolean; bundleHashes: { hash: string; targetBlock: bigint }[] }> {
    const { client, transaction } = liquidationTx;

    // Fold tip into priority fee: effective priority = tip / gasUsed + base priority
    const gasEstimate = transaction.gas ?? (await estimateGas(client, transaction));
    const tipAsPriorityFee = tipAmountWei / gasEstimate;
    const effectivePriorityFee = tipAsPriorityFee + LOW_PRIORITY_FEE;

    const enhancedTx = {
      ...transaction,
      gas: gasEstimate,
      maxPriorityFeePerGas: effectivePriorityFee,
      maxFeePerGas: baseFee * 2n + effectivePriorityFee,
    } as UnionOmit<FormattedTransactionRequest, "from">;

    const signedBundle = await signBundle([{ transaction: enhancedTx, client }]);
    const blockNumber = await getBlockNumber(client);

    // Send to next TARGET_BLOCKS consecutive blocks for higher inclusion probability
    const bundleHashes: { hash: string; targetBlock: bigint }[] = [];
    for (let i = 1; i <= TARGET_BLOCKS; i++) {
      const targetBlock = blockNumber + BigInt(i);
      try {
        const { bundleHash } = await sendRawBundle(signedBundle, targetBlock, flashbotAccount);
        bundleHashes.push({ hash: bundleHash, targetBlock });
      } catch (error) {
        console.warn(`[Flashbots] Failed to send bundle for block ${targetBlock}:`, error);
      }
    }

    if (bundleHashes.length === 0) {
      console.error("[Flashbots] All bundle submissions failed");
      return { included: false, bundleHashes: [] };
    }

    console.log(
      `[Flashbots] Sent ${bundleHashes.length} bundles (blocks ${blockNumber + 1n}-${blockNumber + BigInt(TARGET_BLOCKS)}) ` +
        `tip ${formatEther(tipAmountWei)} ETH (priority ${effectivePriorityFee} wei/gas)`,
    );

    // Non-blocking inclusion check: log result when available, don't block the bot.
    // Original behavior was fire-and-forget; we keep that but add observability.
    waitForInclusion(client, bundleHashes, flashbotAccount)
      .then((result) => {
        if (result.included) {
          console.log(`[Flashbots] ✅ Bundle INCLUDED in block ${result.blockNumber}`);
        } else {
          console.warn(
            `[Flashbots] ❌ Bundle NOT included in blocks ${blockNumber + 1n}-${blockNumber + BigInt(TARGET_BLOCKS)}`,
          );
        }
      })
      .catch(() => {}); // Swallow errors — this is observability, not critical path

    return { included: true, bundleHashes }; // Optimistic like original code
  }
}
