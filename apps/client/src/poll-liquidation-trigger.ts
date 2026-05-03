import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { getGasPrice, sendRawTransaction, simulateCalls, watchContractEvent } from "viem/actions";

import { type LiquidatablePosition, type PositionCache } from "./position-cache.js";
import { PreSigner } from "./preSigner.js";
import {
  type PrimaryWalletCoordinator,
  type PrimaryWalletLease,
} from "./primary-wallet-coordinator.js";
import type { ShadowLogger } from "./shadow-logger.js";
import { TxCache, type PrebuiltTx } from "./tx-cache.js";
import { buildBloxroutePromise, loadBloxrouteConfig } from "./utils/bloxrouteSubmit.js";
import { isHarnessBypassActive } from "./utils/harness-filter-bypass.js";
import { createEventTimer, type EventTimer } from "./utils/shadowTimingLogger.js";
import { submitOrShadow } from "./utils/txSubmitter.js";

const POLL_INTERVAL_MS = 5_000;
// Increased 3 → 10: with preSigner (Sprint 42g/44) cached signed tx, each
// submit costs ~10-20ms. Cap 3 was bottleneck in burst (flash crash scenario).
// 10 matches WalletPool (3 primary + headroom) × POLL cadence.
const MAX_CANDIDATES_PER_TICK = 10;
const IN_FLIGHT_REFRESH_TIMEOUT_MS = 10_000;
// Base L2 has base fee ~0.005 gwei. A 0.3 gwei cap is 60x base fee —
// comfortably above any realistic spike, yet 6.6x cheaper than the prior
// 2 gwei ceiling. For a 700k-gas exec_606BaXt this lowers tx-level gas
// from 0.0014 ETH → 0.00021 ETH, making POLL submissions affordable from
// wallets that AutoRefuel has not yet topped up.
const MAX_FEE_FLOOR = 300_000_000n; // 0.3 gwei
const PRIORITY_FEE_FLOOR = 5_000_000n;
const PRIORITY_FEE_CEILING = 500_000_000n; // 0.5 gwei
const ETH_USD_HEURISTIC = 2200;
const TIP_BPS = 2500n; // 25%
export const POLL_GAS_LIMIT = 700_000n;
const EST_GAS_UNITS = POLL_GAS_LIMIT;
const WETH_USD_HEURISTIC = 2200;
const WAD = 1_000_000_000_000_000_000n;

class SimulatedRevertError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SimulatedRevertError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getHexString(value: unknown): Hex | undefined {
  return typeof value === "string" && value.startsWith("0x") ? (value as Hex) : undefined;
}

function getSimulationFailureDetails(error: unknown): { reason: string; selector: string } {
  const cause = isRecord(error) ? error.cause : undefined;
  const shortMessage = isRecord(error) ? getNonEmptyString(error.shortMessage) : undefined;
  const causeReason = isRecord(cause) ? getNonEmptyString(cause.reason) : undefined;
  const message = error instanceof Error ? error.message : getNonEmptyString(error);
  const rawData =
    (isRecord(error) ? getHexString(error.data) : undefined) ??
    (isRecord(cause) ? getHexString(cause.data) : undefined);
  const reasonParts = [shortMessage, causeReason, message].filter(
    (value, index, values): value is string =>
      value !== undefined && values.indexOf(value) === index,
  );

  return {
    reason: reasonParts.join(" | ") || "unknown simulation error",
    selector: rawData?.slice(0, 10) ?? "n/a",
  };
}

function logSimulationRevert(args: {
  logTag: string;
  borrower: Address;
  marketId: Hex;
  error: unknown;
}): SimulatedRevertError {
  const { reason, selector } = getSimulationFailureDetails(args.error);
  console.warn(
    `${args.logTag}[POLL] simulation REVERT borrower=${args.borrower} market=${args.marketId} reason=${reason} selector=${selector}`,
  );
  return new SimulatedRevertError(reason);
}

type PollRefreshCallback = () => Promise<void> | void;

interface AttemptCandidateResult {
  postSubmitRefresh?: Promise<void>;
}

function toTimingCandidateRef(borrower: Address, marketId: Hex, collateralSymbol: string) {
  return {
    borrower,
    marketId,
    collateralSymbol,
  };
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function releaseInFlightAfterRefresh(args: {
  key: string;
  borrower: Address;
  marketId: Hex;
  inFlight: Set<string>;
  logTag: string;
  refreshPromise: Promise<void>;
}): Promise<void> {
  const { borrower, inFlight, key, logTag, marketId, refreshPromise } = args;
  return Promise.race([
    refreshPromise.then(() => "refreshed" as const),
    waitForMs(IN_FLIGHT_REFRESH_TIMEOUT_MS).then(() => "timeout" as const),
  ]).then((outcome) => {
    if (outcome === "timeout") {
      console.warn(
        `${logTag}[POLL] post-submit refresh timeout after ${IN_FLIGHT_REFRESH_TIMEOUT_MS}ms: borrower=${borrower} market=${marketId} — releasing in-flight`,
      );
    }
    inFlight.delete(key);
  });
}

/**
 * Share a fixed fraction of expected liquidation profit with the sequencer instead of
 * using static size tiers. This ties bid aggressiveness to modeled economics and caps
 * tips on large positions while still lifting small but profitable liquidations above floor.
 */
function estimatePriorityFeeWei(prebuilt: PrebuiltTx): bigint {
  return estimatePriorityFeeWeiByProfit(prebuilt);
}

function estimateBorrowUsd(prebuilt: PrebuiltTx): number {
  const loanSymbol = prebuilt.loanSymbol.toLowerCase();
  if (loanSymbol.includes("usdc") || loanSymbol.includes("usdt") || loanSymbol.includes("eurc")) {
    return Number(prebuilt.borrowAssets) / 1e6;
  }
  if (loanSymbol.includes("weth") || loanSymbol.includes("eth")) {
    return (Number(prebuilt.borrowAssets) / 1e18) * WETH_USD_HEURISTIC;
  }
  return 0;
}

function estimatePriorityFeeWeiByProfit(prebuilt: PrebuiltTx): bigint {
  const loanSymbol = prebuilt.loanSymbol.toLowerCase();
  const discount = ((WAD - prebuilt.lltv) * 3n) / 10n;
  const denominator = WAD - discount;
  if (denominator <= 0n) return PRIORITY_FEE_CEILING;

  const uncappedLif = (WAD * WAD) / denominator;
  const lif = uncappedLif > (115n * WAD) / 100n ? (115n * WAD) / 100n : uncappedLif;
  const profitWei = (prebuilt.borrowAssets * (lif - WAD)) / WAD;

  let profitUsdValue = 0;
  if (
    loanSymbol.includes("usdc") ||
    loanSymbol.includes("usdt") ||
    loanSymbol.includes("eurc") ||
    loanSymbol.includes("dai")
  ) {
    profitUsdValue = Number(profitWei) / 1e6;
  } else if (loanSymbol.includes("weth") || loanSymbol.includes("eth")) {
    profitUsdValue = (Number(profitWei) / 1e18) * WETH_USD_HEURISTIC;
  } else {
    return PRIORITY_FEE_FLOOR;
  }

  const tipUsdValue = (profitUsdValue * Number(TIP_BPS)) / 10_000;
  const tipWeiBudget = BigInt(Math.round((tipUsdValue * 1e18) / ETH_USD_HEURISTIC));
  const tipPerGas = tipWeiBudget / EST_GAS_UNITS;

  if (tipPerGas < PRIORITY_FEE_FLOOR) return PRIORITY_FEE_FLOOR;
  if (tipPerGas > PRIORITY_FEE_CEILING) return PRIORITY_FEE_CEILING;
  return tipPerGas;
}

export async function getPollGasParams(
  client: PrimaryWalletCoordinator["client"],
  prebuilt: PrebuiltTx,
): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const gasPrice = await getGasPrice(client);
  const baseMaxFeePerGas = gasPrice * 2n;
  const dynamicTip = estimatePriorityFeeWei(prebuilt);
  const maxPriorityFeePerGas = dynamicTip > PRIORITY_FEE_FLOOR ? dynamicTip : PRIORITY_FEE_FLOOR;
  const dynamicCap =
    baseMaxFeePerGas > maxPriorityFeePerGas
      ? baseMaxFeePerGas
      : baseMaxFeePerGas + maxPriorityFeePerGas;
  const maxFeePerGas = dynamicCap > MAX_FEE_FLOOR ? dynamicCap : MAX_FEE_FLOOR;

  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

async function submitPrebuiltLiquidation(args: {
  chainId: number;
  logTag: string;
  primaryWalletCoordinator: PrimaryWalletCoordinator;
  lease: PrimaryWalletLease;
  publicClient: PublicClient;
  prebuilt: PrebuiltTx;
  preSigner?: PreSigner;
  timer?: EventTimer;
}): Promise<{
  txHash: Hex;
  broadcastedMs: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  sentBlock: bigint;
}> {
  const { chainId, primaryWalletCoordinator, lease, publicClient, prebuilt, preSigner, timer } =
    args;
  const sequencerUrl = chainId === 8453 ? "https://mainnet-sequencer.base.org" : undefined;
  const bloxrouteConfig = loadBloxrouteConfig() ?? null;
  let nonceClaimed = false;

  try {
    const calldata = TxCache.encodeCalldata(prebuilt);
    try {
      const simulation = await simulateCalls(primaryWalletCoordinator.client, {
        account: primaryWalletCoordinator.client.account,
        calls: [{ to: primaryWalletCoordinator.executorAddress, data: calldata }],
      });
      const simulatedCall = simulation.results[0];
      if (simulatedCall.status !== "success") {
        throw logSimulationRevert({
          logTag: args.logTag,
          borrower: prebuilt.borrower,
          marketId: prebuilt.marketId,
          error: simulatedCall.error,
        });
      }
    } catch (error) {
      if (error instanceof SimulatedRevertError) throw error;
      throw logSimulationRevert({
        logTag: args.logTag,
        borrower: prebuilt.borrower,
        marketId: prebuilt.marketId,
        error,
      });
    }

    const { maxFeePerGas, maxPriorityFeePerGas } = await getPollGasParams(
      primaryWalletCoordinator.client,
      prebuilt,
    );
    let signed: Hex | undefined;
    let nonce: number | undefined;
    const cachedSignedTx = preSigner?.get(prebuilt.borrower, prebuilt.marketId);
    const cachedUsable =
      cachedSignedTx !== undefined &&
      cachedSignedTx.calldata === calldata &&
      cachedSignedTx.gas === POLL_GAS_LIMIT &&
      cachedSignedTx.maxFeePerGas >= maxFeePerGas &&
      cachedSignedTx.maxPriorityFeePerGas >= maxPriorityFeePerGas;
    if (cachedUsable) {
      if (primaryWalletCoordinator.claimReservedNonce(lease, cachedSignedTx.nonce)) {
        nonce = cachedSignedTx.nonce;
        signed = cachedSignedTx.signedTx;
        nonceClaimed = true;
        console.log(`${args.logTag}[POLL] using reserved pre-signed tx`);
      } else {
        nonce = await primaryWalletCoordinator.nextNonce(lease);
        nonceClaimed = true;
        if (cachedSignedTx.nonce === nonce) {
          signed = cachedSignedTx.signedTx;
          console.log(`${args.logTag}[POLL] using pre-signed tx`);
        } else {
          console.log(
            `${args.logTag}[POLL] pre-signed tx stale: cachedNonce=${cachedSignedTx.nonce} claimedNonce=${nonce} — signing fresh`,
          );
          preSigner?.invalidate(prebuilt.borrower, prebuilt.marketId);
        }
      }
    }

    if (signed === undefined) {
      if (preSigner && cachedSignedTx === undefined) {
        console.log(`${args.logTag}[POLL] pre-signed tx miss — signing fresh`);
      }
      if (preSigner && cachedSignedTx !== undefined) {
        console.log(`${args.logTag}[POLL] pre-signed tx unusable — signing fresh`);
        preSigner.invalidate(prebuilt.borrower, prebuilt.marketId);
      }

      try {
        if (nonce === undefined) {
          nonce = await primaryWalletCoordinator.nextNonce(lease);
          nonceClaimed = true;
        }
        signed = await primaryWalletCoordinator.client.signTransaction({
          account: primaryWalletCoordinator.client.account,
          to: primaryWalletCoordinator.executorAddress,
          data: calldata,
          gas: POLL_GAS_LIMIT,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
          type: "eip1559" as const,
        });
      } catch (error) {
        if (nonce !== undefined) {
          primaryWalletCoordinator.rollbackNonce(lease, nonce);
        }
        throw error;
      }
    }

    if (nonce === undefined) throw new Error("nonce unavailable after signing");
    if (signed === undefined) throw new Error("signed tx unavailable after signing");

    // DIAGNOSTIC: dump signed tx fields so we can reason about RPC rejections.
    // Runs under isHarnessBypassActive chain-gate — production stays quiet.
    console.log(
      `${args.logTag}[POLL] signed tx: len=${signed.length / 2 - 1}B to=${primaryWalletCoordinator.executorAddress} nonce=${nonce} gas=${POLL_GAS_LIMIT} maxFee=${maxFeePerGas} maxPrio=${maxPriorityFeePerGas} calldataLen=${calldata.length / 2 - 1}B`,
    );

    const candidateRef = toTimingCandidateRef(
      prebuilt.borrower,
      prebuilt.marketId,
      prebuilt.collateralSymbol,
    );
    const pollGasParams = {
      nonce,
      gas: POLL_GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
    timer?.setSignComplete(
      candidateRef,
      cachedSignedTx !== undefined && cachedSignedTx.nonce === nonce,
    );
    timer?.setWouldSubmit(candidateRef);
    const promises: Promise<string>[] = [
      submitOrShadow({
        path: "alchemy",
        triggerPath: "poll",
        candidateRef,
        gasParams: pollGasParams,
        serializedTx: signed,
        submit: () =>
          sendRawTransaction(primaryWalletCoordinator.client, {
            serializedTransaction: signed,
          }),
        createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
      }),
    ];
    const sentBlockPromise = publicClient.getBlockNumber().catch(() => 0n);
    if (sequencerUrl) {
      promises.push(
        submitOrShadow({
          path: "sequencer",
          triggerPath: "poll",
          candidateRef,
          gasParams: pollGasParams,
          serializedTx: signed,
          metadata: { url: sequencerUrl },
          submit: () =>
            fetch(sequencerUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "eth_sendRawTransaction",
                params: [signed],
                id: 1,
              }),
              signal: AbortSignal.timeout(5_000),
            })
              .then((response) => response.json())
              .then((response: unknown) => {
                const result = response as { result?: string };
                if (!result.result?.startsWith("0x")) throw new Error("empty");
                return result.result;
              })
              .catch(() => {
                throw new Error("seq failed");
              }),
          createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
        }),
      );
    }
    if (bloxrouteConfig) {
      promises.push(
        submitOrShadow({
          path: "bloxroute",
          triggerPath: "poll",
          candidateRef,
          gasParams: pollGasParams,
          serializedTx: signed,
          submit: () => buildBloxroutePromise(bloxrouteConfig, signed),
          createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
        }),
      );
    }

    const txHash = await Promise.any(promises);
    preSigner?.invalidate(prebuilt.borrower, prebuilt.marketId);
    return {
      txHash: txHash as Hex,
      broadcastedMs: Date.now(),
      maxPriorityFeePerGas,
      maxFeePerGas,
      sentBlock: await sentBlockPromise,
    };
  } catch (error) {
    if (nonceClaimed) primaryWalletCoordinator.resetNonceCache(lease);
    throw error;
  }
}

const mockOraclePriceUpdatedAbi = [
  {
    anonymous: false,
    type: "event",
    name: "PriceUpdated",
    inputs: [
      { indexed: false, internalType: "uint256", name: "oldPrice", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "newPrice", type: "uint256" },
    ],
  },
] as const;

export function startPollLiquidationTrigger(args: {
  chainId: number;
  logTag: string;
  positionCache: PositionCache;
  txCache: TxCache;
  primaryWalletCoordinator: PrimaryWalletCoordinator;
  publicClient: PublicClient;
  /**
   * Optional WS-transport client for eth_subscribe. When provided, MockOracle
   * PriceUpdated events stream via push subscription (≈0 CU cost + <50ms
   * latency). Falls back to HTTP poll on publicClient when absent.
   */
  wsPublicClient?: PublicClient;
  preSigner?: PreSigner;
  shadowLogger?: ShadowLogger;
  /**
   * HARNESS-ONLY: invoked when MockOracle emits PriceUpdated.  Caller is
   * expected to refresh PositionCache (DIRECT + API) and rebuild TxCache
   * so a fresh cache-hit is available by the time runTick inspects.
   * Awaited before runTick runs so state is fresh on the first check.
   */
  onOraclePriceChange?: PollRefreshCallback;
  /**
   * HARNESS-ONLY: invoked after a POLL liquidation submit succeeds. Caller is
   * expected to refresh PositionCache and rebuild TxCache in the background so
   * the next tick does not reuse calldata for pre-liquidation borrow shares.
   */
  onAttemptSubmitted?: PollRefreshCallback;
}): { interval: ReturnType<typeof setInterval>; stop: () => void } | null {
  const {
    chainId,
    logTag,
    positionCache,
    txCache,
    primaryWalletCoordinator,
    publicClient,
    wsPublicClient,
    preSigner,
    shadowLogger,
    onOraclePriceChange,
    onAttemptSubmitted,
  } = args;

  /**
   * TEST/HARNESS ONLY.
   *
   * This polling trigger is intentionally hard-gated behind HARNESS_BYPASS_FILTERS=1
   * on Base so production keeps using the existing event-driven fast path only until
   * the polling path is validated under harness conditions.
   */
  if (!isHarnessBypassActive(chainId)) return null;

  const inFlight = new Set<string>();
  let tickInProgress = false;
  console.log(`${logTag}[POLL] sprint trigger active — will poll PositionCache every 5s for HF<1`);

  // Sprint 51b: runTick accepts optional oracle context (populated when triggered
  // by MockOracle PriceUpdated event; null for periodic HTTP ticks).
  const runTick = async (harnessOracleCtx?: {
    oracleAddress: string;
    oracleBlockNumber: number;
  }) => {
    if (tickInProgress) return;
    tickInProgress = true;

    // Per-tick timer — one event, potentially N candidates.
    const pollTimer: EventTimer = createEventTimer("poll", harnessOracleCtx);
    pollTimer.setHandlerDispatch();

    try {
      const candidates = positionCache.findNearLiquidation(1.0);
      if (candidates.length === 0) {
        console.log(`${logTag}[POLL] tick: 0 HF<1 positions — skipping`);
        return;
      }

      console.log(
        `${logTag}[POLL] tick: ${candidates.length} HF<1 positions — attempting liquidation`,
      );

      // Filter cache-hit first so cache-miss positions don't starve the
      // candidate budget. Without this, findNearLiquidation's borrowAssets-
      // descending ordering lets a few always-miss whales block smaller
      // (harness/test) positions that DO have a prebuilt tx.
      const hitCandidates: LiquidatablePosition[] = [];
      const missBorrowers: string[] = [];
      for (const candidate of candidates) {
        if (txCache.get(candidate.position.borrower, candidate.position.marketId) !== undefined) {
          hitCandidates.push(candidate);
        } else {
          missBorrowers.push(candidate.position.borrower);
        }
      }
      if (missBorrowers.length > 0) {
        console.log(
          `${logTag}[POLL] skipping ${missBorrowers.length} cache-miss candidate(s) before budget slice`,
        );
      }

      const activeCandidates: LiquidatablePosition[] = [];
      for (const candidate of hitCandidates.slice(0, MAX_CANDIDATES_PER_TICK)) {
        const ref = toTimingCandidateRef(
          candidate.position.borrower,
          candidate.position.marketId,
          candidate.position.collateralSymbol,
        );
        pollTimer.addCandidate(ref);
        const key = `${candidate.position.borrower.toLowerCase()}:${candidate.position.marketId.toLowerCase()}`;
        if (inFlight.has(key)) {
          pollTimer.setSkipped(ref, "in-flight");
          continue;
        }
        activeCandidates.push(candidate);
      }

      if (activeCandidates.length === 0) {
        console.log(
          `${logTag}[POLL] tick: 0 eligible positions (cache-hit=${hitCandidates.length}, in-flight-filtered)`,
        );
        return;
      }

      const lease = primaryWalletCoordinator.tryAcquire(
        `poll:${activeCandidates.map((candidate) => candidate.position.borrower.toLowerCase()).join(",")}`,
      );
      if (lease === null) {
        console.log(`${logTag}[POLL] primary wallet busy — skipping tick`);
        for (const candidate of activeCandidates) {
          pollTimer.setSkipped(
            toTimingCandidateRef(
              candidate.position.borrower,
              candidate.position.marketId,
              candidate.position.collateralSymbol,
            ),
            "busy-wallet",
          );
        }
        pollTimer.flush();
        return;
      }

      try {
        for (const candidate of activeCandidates) {
          const key = `${candidate.position.borrower.toLowerCase()}:${candidate.position.marketId.toLowerCase()}`;
          if (inFlight.has(key)) continue;

          const prebuilt = txCache.get(candidate.position.borrower, candidate.position.marketId);
          if (prebuilt === undefined) {
            console.log(
              `${logTag}[POLL] skipping cache miss: borrower=${candidate.position.borrower} market=${candidate.position.marketId}`,
            );
            pollTimer.setSkipped(
              toTimingCandidateRef(
                candidate.position.borrower,
                candidate.position.marketId,
                candidate.position.collateralSymbol,
              ),
              "no-cache",
            );
            continue;
          }

          pollTimer.setCalldataReady(
            toTimingCandidateRef(
              candidate.position.borrower,
              candidate.position.marketId,
              candidate.position.collateralSymbol,
            ),
          );

          inFlight.add(key);
          let releaseAfterRefresh = false;
          try {
            const { postSubmitRefresh } = await attemptCandidate({
              candidate,
              prebuilt,
              chainId,
              logTag,
              primaryWalletCoordinator,
              lease,
              publicClient,
              preSigner,
              shadowLogger,
              onAttemptSubmitted,
              timer: pollTimer,
            });
            if (postSubmitRefresh) {
              releaseAfterRefresh = true;
              void releaseInFlightAfterRefresh({
                key,
                borrower: candidate.position.borrower,
                marketId: candidate.position.marketId,
                inFlight,
                logTag,
                refreshPromise: postSubmitRefresh,
              });
            }
          } finally {
            if (!releaseAfterRefresh) inFlight.delete(key);
          }
        }
      } finally {
        primaryWalletCoordinator.release(lease);
        // Sprint 51b: flush after all candidates processed (success and failure paths).
        pollTimer.flush();
      }
    } finally {
      tickInProgress = false;
    }
  };

  // Harness real-time trigger: MockOracle PriceUpdated → immediate runTick.
  // Without this, oracle moves wait up to POLL_INTERVAL_MS (5s) before we react.
  // runTick has its own tickInProgress guard so concurrent calls are safe.
  const harnessOracleEnv = process.env.HARNESS_WETH_MARKET_ORACLE;
  let unwatch: (() => void) | undefined;
  if (harnessOracleEnv) {
    let oracleAddress: Address;
    try {
      oracleAddress = getAddress(harnessOracleEnv);
    } catch {
      console.error(
        `${logTag}[POLL] HARNESS_WETH_MARKET_ORACLE not a valid address: ${harnessOracleEnv} — oracle watcher disabled`,
      );
      oracleAddress = "0x0000000000000000000000000000000000000000" as Address;
    }
    if (oracleAddress !== "0x0000000000000000000000000000000000000000") {
      const useWs = wsPublicClient !== undefined;
      const watchClient = useWs ? wsPublicClient : publicClient;
      const transportLabel = useWs ? "WS subscribe" : "HTTP poll 1000ms";
      console.log(
        `${logTag}[POLL] subscribing (${transportLabel}) to MockOracle PriceUpdated at ${oracleAddress} — will fire runTick on price change`,
      );
      unwatch = watchContractEvent(watchClient, {
        address: oracleAddress,
        abi: mockOraclePriceUpdatedAbi,
        eventName: "PriceUpdated",
        onLogs: (logs) => {
          for (const log of logs) {
            const args = log.args as { oldPrice?: bigint; newPrice?: bigint };
            console.log(
              `${logTag}[POLL] oracle event: PriceUpdated old=${args.oldPrice} new=${args.newPrice} block=${log.blockNumber} → refresh+runTick`,
            );
            // Sprint 51b: oracle context for the MockOracle-triggered tick.
            const oracleCtx = {
              oracleAddress: oracleAddress as string,
              oracleBlockNumber: Number(log.blockNumber ?? 0),
            };
            // Refresh state before ticking so the newly-underwater position has
            // a cache-hit.  If the caller wired onOraclePriceChange (harness),
            // wait for it; otherwise fall through to runTick immediately.
            const cb = onOraclePriceChange;
            if (cb) {
              void Promise.resolve()
                .then(() => cb())
                .catch((err: unknown) => {
                  console.error(
                    `${logTag}[POLL] onOraclePriceChange error: ${err instanceof Error ? err.message : String(err)}`,
                  );
                })
                .finally(() => {
                  void runTick(oracleCtx);
                });
            } else {
              void runTick(oracleCtx);
            }
          }
        },
        onError: (err) => {
          console.error(
            `${logTag}[POLL] oracle watch error: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
        // WS client → eth_subscribe (push, <50ms latency, ≈0 CU ongoing).
        // HTTP client → eth_getLogs poll (1s — 250ms burned free-tier quota).
        ...(useWs ? {} : { poll: true as const, pollingInterval: 1_000 }),
      });
    }
  }

  void runTick();
  const interval = setInterval(() => {
    void runTick();
  }, POLL_INTERVAL_MS);
  return {
    interval,
    stop: () => {
      clearInterval(interval);
      if (unwatch) unwatch();
    },
  };
}

async function attemptCandidate(args: {
  candidate: LiquidatablePosition;
  prebuilt: PrebuiltTx;
  chainId: number;
  logTag: string;
  primaryWalletCoordinator: PrimaryWalletCoordinator;
  lease: PrimaryWalletLease;
  publicClient: PublicClient;
  preSigner?: PreSigner;
  shadowLogger?: ShadowLogger;
  onAttemptSubmitted?: PollRefreshCallback;
  timer?: EventTimer;
}): Promise<AttemptCandidateResult> {
  const {
    candidate,
    prebuilt,
    chainId,
    logTag,
    primaryWalletCoordinator,
    lease,
    publicClient,
    preSigner,
    shadowLogger,
    onAttemptSubmitted,
    timer,
  } = args;

  console.log(
    `${logTag}[POLL] attempting liquidation: borrower=${candidate.position.borrower} market=${candidate.position.marketId} HF=${candidate.position.apiHealthFactor.toFixed(4)}`,
  );

  try {
    const { txHash, broadcastedMs, maxPriorityFeePerGas, maxFeePerGas, sentBlock } =
      await submitPrebuiltLiquidation({
        chainId,
        logTag,
        primaryWalletCoordinator,
        lease,
        publicClient,
        prebuilt,
        preSigner,
        timer,
      });
    console.log(`${logTag}[POLL] liquidation SUBMITTED: tx=${txHash}`);
    shadowLogger?.recordAttempt({
      borrower: prebuilt.borrower,
      marketId: prebuilt.marketId,
      collateralSymbol: prebuilt.collateralSymbol,
      loanSymbol: prebuilt.loanSymbol ?? "",
      ourTxHash: txHash,
      ourTipWei: maxPriorityFeePerGas,
      ourMaxFeePerGasWei: maxFeePerGas,
      ourSentBlock: sentBlock,
      ourSentMs: broadcastedMs,
      expectedProfitUsd: estimateBorrowUsd(prebuilt),
    });
    if (!onAttemptSubmitted) return {};

    return {
      postSubmitRefresh: Promise.resolve()
        .then(() => onAttemptSubmitted())
        .catch((error: unknown) => {
          console.error(
            `${logTag}[POLL] onAttemptSubmitted error: ${error instanceof Error ? error.message : String(error)}`,
          );
          return new Promise<void>(() => {});
        }),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Promise.any throws AggregateError; surface individual reasons so we can diagnose
    // whether every channel (main RPC, sequencer, bloxroute) rejected for the same reason
    // (e.g. insufficient gas, stale nonce, reverted tx) or different reasons.
    let detail = msg;
    if (error instanceof AggregateError && Array.isArray(error.errors)) {
      detail = `${msg} — causes: [${error.errors
        .map((e, i) => `#${i}=${e instanceof Error ? e.message : String(e)}`)
        .join(" | ")}]`;
    }
    console.error(
      `${logTag}[POLL] liquidation error: borrower=${candidate.position.borrower} market=${candidate.position.marketId} — ${detail}`,
    );
    const failedTx = error instanceof SimulatedRevertError ? "none-simulated-revert" : "none";
    console.log(`${logTag}[POLL] liquidation FAILED: tx=${failedTx}`);
    return {};
  }
}
