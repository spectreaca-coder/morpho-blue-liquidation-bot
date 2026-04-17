import type { Hex, LocalAccount } from "viem";
import { keccak256, stringToBytes } from "viem";

/**
 * Builder relay endpoint configuration.
 */
export interface BuilderConfig {
  /** Human-readable builder name for logging. */
  name: string;
  /** JSON-RPC endpoint URL. */
  url: string;
}

/**
 * Result of submitting a bundle to a single builder.
 */
export interface BuilderSubmitResult {
  /** Builder name. */
  builder: string;
  /** Whether the submission was accepted (HTTP 200 + no error). */
  accepted: boolean;
  /** Bundle hash returned by the builder (if accepted). */
  bundleHash?: string;
  /** Error message (if rejected or failed). */
  error?: string;
  /** Response time in milliseconds. */
  latencyMs: number;
}

/**
 * Aggregated result from submitting to all builders.
 */
export interface MultiBuilderResult {
  /** Results from each builder. */
  results: BuilderSubmitResult[];
  /** Count of builders that accepted the bundle. */
  acceptedCount: number;
  /** Count of builders that rejected or errored. */
  rejectedCount: number;
}

/** Default block builder relays for ETH mainnet. */
export const DEFAULT_BUILDERS: BuilderConfig[] = [
  { name: "flashbots", url: "https://relay.flashbots.net" },
  { name: "titan", url: "https://rpc.titanbuilder.xyz" },
  { name: "rsync", url: "https://rsync-builder.xyz" },
  { name: "beaverbuild", url: "https://rpc.beaverbuild.org" },
];

/**
 * JSON-RPC request ID counter (module-scoped).
 */
let nextRpcId = 0;

/**
 * Signs and builds the X-Flashbots-Signature header value.
 *
 * All major builders use the same authentication scheme as Flashbots:
 * the header value is `{signerAddress}:{signature}` where the signature
 * is over keccak256(body).
 *
 * @param body - The raw JSON-RPC request body string
 * @param account - The signing account (same auth signer used for Flashbots)
 * @returns The full header value string
 */
async function buildSignatureHeader(body: string, account: LocalAccount): Promise<string> {
  const bodyHash = keccak256(stringToBytes(body));
  const signature = await account.signMessage({ message: bodyHash });
  return `${account.address}:${signature}`;
}

/**
 * Submits a signed bundle to a single builder relay.
 *
 * @param builder - Builder configuration
 * @param body - Pre-serialized JSON-RPC request body
 * @param signatureHeader - Pre-computed X-Flashbots-Signature header
 * @returns Submission result
 */
async function submitToBuilder(
  builder: BuilderConfig,
  body: string,
  signatureHeader: string,
): Promise<BuilderSubmitResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(builder.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Flashbots-Signature": signatureHeader,
      },
      body,
      signal: AbortSignal.timeout(5_000), // 5 second timeout per builder
    });

    const latencyMs = Date.now() - startTime;
    const responseBody = (await response.json()) as Record<string, unknown>;

    if (!response.ok || responseBody.error) {
      const errorObj = responseBody.error as Record<string, unknown> | string | undefined;
      const errorMsg =
        typeof errorObj === "string"
          ? errorObj
          : typeof errorObj === "object" && errorObj !== null
            ? ((errorObj.message as string) ?? JSON.stringify(errorObj))
            : `HTTP ${response.status}`;

      return {
        builder: builder.name,
        accepted: false,
        error: errorMsg,
        latencyMs,
      };
    }

    const result = responseBody.result as Record<string, unknown> | undefined;
    return {
      builder: builder.name,
      accepted: true,
      bundleHash: (result?.bundleHash as string) ?? "unknown",
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      builder: builder.name,
      accepted: false,
      error: errorMsg,
      latencyMs,
    };
  }
}

/**
 * Multi-builder bundle submitter.
 *
 * Sends eth_sendBundle to multiple block builders simultaneously using
 * Promise.allSettled for maximum inclusion probability. All major MEV
 * builders (Flashbots, Titan, rsync, beaverbuild) support the same
 * eth_sendBundle JSON-RPC method with X-Flashbots-Signature authentication.
 *
 * Usage:
 * ```typescript
 * const submitter = new MultiBuilderSubmitter(flashbotAccount);
 * const result = await submitter.sendBundle(signedTxs, targetBlock);
 * console.log(`Accepted by ${result.acceptedCount}/${result.results.length} builders`);
 * ```
 */
export class MultiBuilderSubmitter {
  private readonly account: LocalAccount;
  private readonly builders: BuilderConfig[];

  /**
   * Creates a new multi-builder submitter.
   *
   * @param account - LocalAccount used to sign the X-Flashbots-Signature header.
   *                  This is the same auth signer used for Flashbots relay.
   * @param builders - Builder configurations (defaults to all major ETH mainnet builders)
   */
  constructor(account: LocalAccount, builders: BuilderConfig[] = DEFAULT_BUILDERS) {
    this.account = account;
    this.builders = builders;
  }

  /**
   * Sends a signed bundle to all configured builders in parallel.
   *
   * The bundle is submitted via eth_sendBundle JSON-RPC to every builder
   * simultaneously. Results are collected via Promise.allSettled so a
   * single builder failure does not block others.
   *
   * @param signedTransactions - Array of signed transaction hex strings
   * @param targetBlockNumber - The block number to target for inclusion
   * @returns Aggregated results from all builders
   */
  async sendBundle(
    signedTransactions: Hex[],
    targetBlockNumber: bigint,
  ): Promise<MultiBuilderResult> {
    const body = JSON.stringify({
      method: "eth_sendBundle",
      params: [
        {
          txs: signedTransactions,
          blockNumber: `0x${targetBlockNumber.toString(16)}`,
        },
      ],
      id: nextRpcId++,
      jsonrpc: "2.0",
    });

    // Sign once, reuse for all builders (same signature scheme)
    const signatureHeader = await buildSignatureHeader(body, this.account);

    // Submit to all builders in parallel
    const settled = await Promise.allSettled(
      this.builders.map((builder) => submitToBuilder(builder, body, signatureHeader)),
    );

    const results: BuilderSubmitResult[] = settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") {
        return outcome.value;
      }
      // Promise.allSettled rejection (should not happen since submitToBuilder catches)
      return {
        builder: this.builders[index]?.name ?? "unknown",
        accepted: false,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        latencyMs: 0,
      };
    });

    const acceptedCount = results.filter((r) => r.accepted).length;
    const rejectedCount = results.length - acceptedCount;

    // Log summary
    const acceptedBuilders = results
      .filter((r) => r.accepted)
      .map((r) => `${r.builder}(${r.latencyMs}ms)`)
      .join(", ");
    const rejectedBuilders = results
      .filter((r) => !r.accepted)
      .map((r) => `${r.builder}(${r.error})`)
      .join(", ");

    if (acceptedCount > 0) {
      console.log(
        `[MultiBuilder] Bundle accepted by ${acceptedCount}/${results.length}: ${acceptedBuilders}`,
      );
    }
    if (rejectedCount > 0) {
      console.warn(
        `[MultiBuilder] Bundle rejected by ${rejectedCount}/${results.length}: ${rejectedBuilders}`,
      );
    }

    return { results, acceptedCount, rejectedCount };
  }

  /**
   * Sends a signed bundle to all builders for multiple consecutive blocks.
   *
   * This maximizes inclusion probability by targeting N consecutive blocks,
   * similar to the existing Flashbots.sendBundleWithCoinbaseTip pattern.
   *
   * @param signedTransactions - Array of signed transaction hex strings
   * @param startBlockNumber - First block to target
   * @param blockCount - Number of consecutive blocks to target (default: 3)
   * @returns Array of results, one per target block
   */
  async sendBundleToConsecutiveBlocks(
    signedTransactions: Hex[],
    startBlockNumber: bigint,
    blockCount = 3,
  ): Promise<{ targetBlock: bigint; result: MultiBuilderResult }[]> {
    const allResults: { targetBlock: bigint; result: MultiBuilderResult }[] = [];

    // Submit to all target blocks in parallel
    const submissions = Array.from({ length: blockCount }, (_, i) => {
      const targetBlock = startBlockNumber + BigInt(i);
      return this.sendBundle(signedTransactions, targetBlock).then((result) => ({
        targetBlock,
        result,
      }));
    });

    const settled = await Promise.allSettled(submissions);

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        allResults.push(outcome.value);
      }
    }

    // Summary log
    const totalAccepted = allResults.reduce((sum, r) => sum + r.result.acceptedCount, 0);
    const totalSubmissions = allResults.reduce((sum, r) => sum + r.result.results.length, 0);
    console.log(
      `[MultiBuilder] Total: ${totalAccepted}/${totalSubmissions} accepted across ${allResults.length} blocks ` +
        `(${startBlockNumber}..${startBlockNumber + BigInt(blockCount - 1)})`,
    );

    return allResults;
  }
}
