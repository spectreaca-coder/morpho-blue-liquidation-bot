import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { type Address, type Hex, type Log, type PublicClient, decodeEventLog } from "viem";

import { morphoBlueAbi } from "./abis/morpho/morphoBlue.js";

const DEFAULT_LOG_PATH = "logs/competitor_intel.jsonl";
const SUBMIT_ATTEMPTS_LOG_PATH = "logs/submit_attempts.jsonl";

export interface SubmitAttemptRecord {
  ts: number;
  txHash: string;
  path: "alchemy" | "bloxroute" | "ankr";
  submitMs: number;
  responseMs: number;
  rpcStatus: "accepted" | "rejected" | "error";
  errorMessage?: string;
}

interface CompetitorIntelLoggerArgs {
  publicClient: PublicClient;
  logPath?: string;
}

interface CompetitorIntelRecord {
  ts: number;
  blockNumber: string;
  blockTimestamp: string;
  txHash: string;
  winner: string;
  marketId: string;
  borrower: string;
  repaidShares: string;
  seizedAssets: string;
  gasUsed: string;
  effectiveGasPriceWei: string;
  baseFeePerGasWei: string;
  tipPaidWei: string;
  maxPriorityFeePerGasWei: string;
  maxFeePerGasWei: string;
  calldataLen: number;
  selector: string;
  nonce: number;
  status: "success" | "reverted";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CompetitorIntelLogger {
  private readonly publicClient: PublicClient;
  private readonly logPath: string;
  private readonly submitAttemptsLogPath: string;
  private readonly ready: Promise<void>;
  private readonly submitAttemptsReady: Promise<void>;

  constructor(args: CompetitorIntelLoggerArgs) {
    this.publicClient = args.publicClient;
    this.logPath = args.logPath ?? DEFAULT_LOG_PATH;
    this.submitAttemptsLogPath = SUBMIT_ATTEMPTS_LOG_PATH;
    this.ready = mkdir(dirname(this.logPath), { recursive: true }).then(() => undefined);
    this.submitAttemptsReady = mkdir(dirname(this.submitAttemptsLogPath), { recursive: true }).then(
      () => undefined,
    );
  }

  async recordLiquidateEvent(log: Log): Promise<void> {
    try {
      const txHash = log.transactionHash;
      const blockHash = log.blockHash;

      if (!txHash || !blockHash) return;

      // Decode event args from the log
      let marketId = "0x";
      let borrower = "0x";
      let repaidShares = "0";
      let seizedAssets = "0";

      try {
        const decoded = decodeEventLog({
          abi: morphoBlueAbi,
          eventName: "Liquidate",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data,
        });
        const args = decoded.args as {
          id?: Hex;
          borrower?: Address;
          repaidShares?: bigint;
          seizedAssets?: bigint;
        };
        marketId = args.id ?? "0x";
        borrower = args.borrower ?? "0x";
        repaidShares = (args.repaidShares ?? 0n).toString();
        seizedAssets = (args.seizedAssets ?? 0n).toString();
      } catch {
        // If decode fails, continue with defaults — we still want tx/block data
      }

      const [tx, receipt, block] = await Promise.all([
        this.publicClient.getTransaction({ hash: txHash }),
        this.publicClient.getTransactionReceipt({ hash: txHash }),
        this.publicClient.getBlock({ blockHash: blockHash }),
      ]);

      const baseFeePerGas = block.baseFeePerGas ?? 0n;
      const effectiveGasPrice = receipt.effectiveGasPrice;
      const tipPaidWei = effectiveGasPrice > baseFeePerGas ? effectiveGasPrice - baseFeePerGas : 0n;

      const input = tx.input ?? "0x";
      const calldataLen = (input.length - 2) / 2; // hex string -> bytes
      const selector = input.length >= 10 ? input.slice(0, 10) : "0x";

      const record: CompetitorIntelRecord = {
        ts: Date.now(),
        blockNumber: block.number?.toString() ?? "0",
        blockTimestamp: block.timestamp.toString(),
        txHash,
        winner: tx.from.toLowerCase(),
        marketId,
        borrower,
        repaidShares,
        seizedAssets,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: effectiveGasPrice.toString(),
        baseFeePerGasWei: baseFeePerGas.toString(),
        tipPaidWei: tipPaidWei.toString(),
        maxPriorityFeePerGasWei: (tx.maxPriorityFeePerGas ?? 0n).toString(),
        maxFeePerGasWei: (tx.maxFeePerGas ?? 0n).toString(),
        calldataLen,
        selector,
        nonce: tx.nonce,
        status: receipt.status === "success" ? "success" : "reverted",
      };

      await this.ready;
      await appendFile(this.logPath, `${JSON.stringify(record)}\n`);
    } catch (error: unknown) {
      console.error(`[competitorIntel] recordLiquidateEvent failed: ${getErrorMessage(error)}`);
    }
  }

  async recordSubmitAttempt(record: SubmitAttemptRecord): Promise<void> {
    try {
      await this.submitAttemptsReady;
      await appendFile(this.submitAttemptsLogPath, `${JSON.stringify(record)}\n`);
    } catch (error: unknown) {
      console.error(`[competitorIntel] recordSubmitAttempt failed: ${getErrorMessage(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.ready;
  }
}
