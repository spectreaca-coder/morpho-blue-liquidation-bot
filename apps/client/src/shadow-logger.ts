import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Address, Hex, PublicClient } from "viem";

const LIQUIDATE_TOPIC0 = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";
const DEFAULT_ENRICHMENT_DELAY_MS = 35_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_PENDING = 100;

type Outcome = "WON" | "LOST" | "NO_LIQ";
type WinnerToRole = "morpho_direct" | "our_executor" | "unknown_private_relay" | "eoa_or_unknown";
type CodeState = "code" | "empty";

interface ShadowLoggerParams {
  logPath: string;
  publicClient: PublicClient;
  morphoAddress: Address;
  ourExecutorAddresses: Set<Address>;
  enrichmentDelayMs?: number;
  maxConcurrent?: number;
  maxPending?: number;
  logTag?: string;
}

export interface ShadowAttemptParams {
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
  loanSymbol: string;
  ourTxHash: Hex;
  ourTipWei: bigint;
  ourMaxFeePerGasWei: bigint;
  ourSentBlock: bigint;
  ourSentMs: number;
  expectedProfitUsd: number;
  flashblockReceivedMs?: number;
}

interface ShadowAttemptEvent {
  type: "shadow_attempt";
  timestamp: number;
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
  loanSymbol: string;
  ourTxHash: Hex;
  ourTipGwei: number;
  ourMaxFeePerGasGwei: number;
  sentBlock: string;
  ourSentMs: number;
  expectedProfitUsd: number;
  flashblockReceivedMs?: number;
}

interface ShadowOutcomeEvent {
  type: "shadow_outcome";
  timestamp: number;
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
  loanSymbol: string;
  ourTxHash: Hex;
  ourTipGwei: number;
  outcome: Outcome;
  winnerTxHash?: Hex;
  winnerAddress?: Address;
  winnerToAddress?: Address;
  winnerToRole?: WinnerToRole;
  winnerTipGwei?: number;
  winnerEffectiveGasPriceGwei?: number;
  winnerGasUsed?: string;
  lagMs?: number;
  lagBlocks?: number;
  sentBlock: string;
  sealedBlock?: string;
  expectedProfitUsd: number;
  flashblockReceivedMs?: number;
}

interface ShadowEnrichErrorEvent {
  type: "shadow_enrich_error";
  timestamp: number;
  borrower: Address;
  marketId: Hex;
  collateralSymbol: string;
  loanSymbol: string;
  ourTxHash: Hex;
  error: string;
}

function normalizeAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}

function toBorrowerTopic(borrower: Address): Hex {
  return `0x${borrower.toLowerCase().slice(2).padStart(64, "0")}`;
}

function toHexBlock(blockNumber: bigint): Hex {
  return `0x${blockNumber.toString(16)}`;
}

function hexToBigInt(value: Hex | undefined): bigint | undefined {
  return value ? BigInt(value) : undefined;
}

function toGwei(wei: bigint): number {
  return Number(wei) / 1e9;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ShadowLogger {
  private readonly logPath: string;
  private readonly publicClient: PublicClient;
  private readonly morphoAddress: Address;
  private readonly ourExecutorAddresses: Set<Address>;
  private readonly enrichmentDelayMs: number;
  private readonly maxConcurrent: number;
  private readonly maxPending: number;
  private readonly logTag: string;
  private readonly ready: Promise<void>;
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private readonly pendingQueue: ShadowAttemptParams[] = [];
  private readonly codeCache = new Map<Address, CodeState>();

  private stopped = false;
  private activeEnrichments = 0;

  constructor(params: ShadowLoggerParams) {
    this.logPath = params.logPath;
    this.publicClient = params.publicClient;
    this.morphoAddress = normalizeAddress(params.morphoAddress);
    this.ourExecutorAddresses = new Set(
      [...params.ourExecutorAddresses].map((address) => normalizeAddress(address)),
    );
    this.enrichmentDelayMs = params.enrichmentDelayMs ?? DEFAULT_ENRICHMENT_DELAY_MS;
    this.maxConcurrent = params.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxPending = params.maxPending ?? DEFAULT_MAX_PENDING;
    this.logTag = params.logTag ?? "[shadow]";
    this.ready = mkdir(dirname(this.logPath), { recursive: true }).then(() => undefined);
  }

  recordAttempt(params: ShadowAttemptParams): void {
    if (this.stopped) return;

    this.writeEvent({
      type: "shadow_attempt",
      timestamp: Date.now(),
      borrower: params.borrower,
      marketId: params.marketId,
      collateralSymbol: params.collateralSymbol,
      loanSymbol: params.loanSymbol,
      ourTxHash: params.ourTxHash,
      ourTipGwei: toGwei(params.ourTipWei),
      ourMaxFeePerGasGwei: toGwei(params.ourMaxFeePerGasWei),
      sentBlock: params.ourSentBlock.toString(),
      ourSentMs: params.ourSentMs,
      expectedProfitUsd: params.expectedProfitUsd,
      flashblockReceivedMs: params.flashblockReceivedMs,
    });

    if (this.pendingTimers.size + this.activeEnrichments >= this.maxPending) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (this.stopped) return;
      this.pendingQueue.push(params);
      this.drainQueue();
    }, this.enrichmentDelayMs);

    this.pendingTimers.add(timer);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.pendingQueue.length = 0;
  }

  private drainQueue(): void {
    while (
      !this.stopped &&
      this.activeEnrichments < this.maxConcurrent &&
      this.pendingQueue.length > 0
    ) {
      const attempt = this.pendingQueue.shift();
      if (!attempt) return;
      this.activeEnrichments += 1;
      void this.runEnrichment(attempt).finally(() => {
        this.activeEnrichments -= 1;
        this.drainQueue();
      });
    }
  }

  private async runEnrichment(attempt: ShadowAttemptParams): Promise<void> {
    try {
      await this.enrichAttempt(attempt);
    } catch (error) {
      this.writeEvent({
        type: "shadow_enrich_error",
        timestamp: Date.now(),
        borrower: attempt.borrower,
        marketId: attempt.marketId,
        collateralSymbol: attempt.collateralSymbol,
        loanSymbol: attempt.loanSymbol,
        ourTxHash: attempt.ourTxHash,
        error: getErrorMessage(error),
      });
    }
  }

  private async enrichAttempt(attempt: ShadowAttemptParams): Promise<void> {
    const currentBlock = await this.publicClient.getBlockNumber();
    const fromBlock = attempt.ourSentBlock > 3n ? attempt.ourSentBlock - 3n : 0n;
    const borrowerTopic = toBorrowerTopic(attempt.borrower);
    // Finding 8 fix: filter by marketId at topic1 so a cross-market liquidation
    // of the same borrower in a different pool is not mis-attributed as our winner.
    // Morpho Liquidate event: topics = [sig, indexed id, indexed caller, indexed borrower]
    const rawLogs = await this.publicClient.request({
      method: "eth_getLogs",
      params: [
        {
          address: this.morphoAddress,
          fromBlock: toHexBlock(fromBlock),
          toBlock: toHexBlock(currentBlock),
          topics: [LIQUIDATE_TOPIC0, attempt.marketId, null, borrowerTopic],
        },
      ],
    });
    const logs = [...rawLogs].sort((left, right) => {
      const blockDiff = Number(
        (hexToBigInt(left.blockNumber) ?? 0n) - (hexToBigInt(right.blockNumber) ?? 0n),
      );
      if (blockDiff !== 0) return blockDiff;
      const txIndexDiff = Number(
        (hexToBigInt(left.transactionIndex) ?? 0n) - (hexToBigInt(right.transactionIndex) ?? 0n),
      );
      if (txIndexDiff !== 0) return txIndexDiff;
      return Number((hexToBigInt(left.logIndex) ?? 0n) - (hexToBigInt(right.logIndex) ?? 0n));
    });

    const ourTipGwei = toGwei(attempt.ourTipWei);
    if (logs.length === 0) {
      this.writeEvent({
        type: "shadow_outcome",
        timestamp: Date.now(),
        borrower: attempt.borrower,
        marketId: attempt.marketId,
        collateralSymbol: attempt.collateralSymbol,
        loanSymbol: attempt.loanSymbol,
        ourTxHash: attempt.ourTxHash,
        ourTipGwei,
        outcome: "NO_LIQ",
        sentBlock: attempt.ourSentBlock.toString(),
        expectedProfitUsd: attempt.expectedProfitUsd,
        flashblockReceivedMs: attempt.flashblockReceivedMs,
      });
      return;
    }

    const ownLog = logs.find((log) => log.transactionHash === attempt.ourTxHash);
    if (ownLog?.transactionHash) {
      const txData = await this.getWinnerData(ownLog.transactionHash);
      this.writeEvent({
        type: "shadow_outcome",
        timestamp: Date.now(),
        borrower: attempt.borrower,
        marketId: attempt.marketId,
        collateralSymbol: attempt.collateralSymbol,
        loanSymbol: attempt.loanSymbol,
        ourTxHash: attempt.ourTxHash,
        ourTipGwei: txData.tipWei !== undefined ? toGwei(txData.tipWei) : ourTipGwei,
        outcome: "WON",
        winnerTxHash: ownLog.transactionHash,
        winnerAddress: txData.from,
        winnerToAddress: txData.to,
        winnerToRole: await this.classifyWinnerToRole(txData.to),
        winnerTipGwei: txData.tipWei !== undefined ? toGwei(txData.tipWei) : undefined,
        winnerEffectiveGasPriceGwei: toGwei(txData.effectiveGasPrice),
        winnerGasUsed: txData.gasUsed.toString(),
        sentBlock: attempt.ourSentBlock.toString(),
        sealedBlock: txData.blockNumber.toString(),
        expectedProfitUsd: attempt.expectedProfitUsd,
        flashblockReceivedMs: attempt.flashblockReceivedMs,
      });
      return;
    }

    const winnerLog = logs[0];
    if (!winnerLog?.transactionHash) {
      this.writeEvent({
        type: "shadow_outcome",
        timestamp: Date.now(),
        borrower: attempt.borrower,
        marketId: attempt.marketId,
        collateralSymbol: attempt.collateralSymbol,
        loanSymbol: attempt.loanSymbol,
        ourTxHash: attempt.ourTxHash,
        ourTipGwei,
        outcome: "NO_LIQ",
        sentBlock: attempt.ourSentBlock.toString(),
        expectedProfitUsd: attempt.expectedProfitUsd,
        flashblockReceivedMs: attempt.flashblockReceivedMs,
      });
      return;
    }

    const winnerData = await this.getWinnerData(winnerLog.transactionHash);
    const winnerBlock = await this.publicClient.getBlock({ blockNumber: winnerData.blockNumber });
    const blockTimestampMs = Number(winnerBlock.timestamp) * 1000;
    this.writeEvent({
      type: "shadow_outcome",
      timestamp: Date.now(),
      borrower: attempt.borrower,
      marketId: attempt.marketId,
      collateralSymbol: attempt.collateralSymbol,
      loanSymbol: attempt.loanSymbol,
      ourTxHash: attempt.ourTxHash,
      ourTipGwei,
      outcome: "LOST",
      winnerTxHash: winnerLog.transactionHash,
      winnerAddress: winnerData.from,
      winnerToAddress: winnerData.to,
      winnerToRole: await this.classifyWinnerToRole(winnerData.to),
      winnerTipGwei: winnerData.tipWei !== undefined ? toGwei(winnerData.tipWei) : undefined,
      winnerEffectiveGasPriceGwei: toGwei(winnerData.effectiveGasPrice),
      winnerGasUsed: winnerData.gasUsed.toString(),
      lagMs: blockTimestampMs - attempt.ourSentMs,
      lagBlocks: Number(winnerData.blockNumber - attempt.ourSentBlock),
      sentBlock: attempt.ourSentBlock.toString(),
      sealedBlock: winnerData.blockNumber.toString(),
      expectedProfitUsd: attempt.expectedProfitUsd,
      flashblockReceivedMs: attempt.flashblockReceivedMs,
    });
  }

  private async getWinnerData(txHash: Hex): Promise<{
    from: Address;
    to: Address | undefined;
    tipWei?: bigint;
    effectiveGasPrice: bigint;
    gasUsed: bigint;
    blockNumber: bigint;
  }> {
    const [tx, receipt] = await Promise.all([
      this.publicClient.getTransaction({ hash: txHash }),
      this.publicClient.getTransactionReceipt({ hash: txHash }),
    ]);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const baseFeePerGas = block.baseFeePerGas ?? 0n;
    const tipWei =
      receipt.effectiveGasPrice > baseFeePerGas ? receipt.effectiveGasPrice - baseFeePerGas : 0n;

    return {
      from: normalizeAddress(tx.from),
      to: tx.to ? normalizeAddress(tx.to) : undefined,
      tipWei,
      effectiveGasPrice: receipt.effectiveGasPrice,
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
    };
  }

  private async classifyWinnerToRole(to: Address | undefined): Promise<WinnerToRole | undefined> {
    if (!to) return undefined;
    if (to === this.morphoAddress) return "morpho_direct";
    if (this.ourExecutorAddresses.has(to)) return "our_executor";

    try {
      const cached = this.codeCache.get(to);
      if (cached === "code") return "unknown_private_relay";
      if (cached === "empty") return "eoa_or_unknown";

      const code = await this.publicClient.getCode({ address: to });
      const state: CodeState = code && code !== "0x" ? "code" : "empty";
      this.codeCache.set(to, state);
      return state === "code" ? "unknown_private_relay" : "eoa_or_unknown";
    } catch {
      return "eoa_or_unknown";
    }
  }

  private writeEvent(
    event: ShadowAttemptEvent | ShadowOutcomeEvent | ShadowEnrichErrorEvent,
  ): void {
    void this.ready
      .then(() => appendFile(this.logPath, `${JSON.stringify(event)}\n`))
      .catch((error: unknown) => {
        const message = getErrorMessage(error);
        console.error(`${this.logTag} append failed: ${message}`);
      });
  }
}
