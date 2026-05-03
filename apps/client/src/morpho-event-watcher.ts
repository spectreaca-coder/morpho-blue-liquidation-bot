import { type Address, type Hex, type Log, type PublicClient } from "viem";
import { watchContractEvent } from "viem/actions";

import { morphoBlueAbi } from "./abis/morpho/morphoBlue.js";
import { healthState } from "./health.js";

const morphoPositionEvents = [
  { eventName: "SupplyCollateral", borrowerField: "onBehalf" },
  { eventName: "WithdrawCollateral", borrowerField: "onBehalf" },
  { eventName: "Borrow", borrowerField: "onBehalf" },
  { eventName: "Repay", borrowerField: "onBehalf" },
  { eventName: "Liquidate", borrowerField: "borrower" },
] as const;

interface MarketPositionEventArgs {
  id?: Hex;
  onBehalf?: Address;
  borrower?: Address;
}

interface StartMorphoEventWatcherArgs {
  chainId: number;
  logTag: string;
  publicClient: PublicClient;
  /**
   * Optional WS-transport client for eth_subscribe-based event streaming.
   * When provided, non-Liquidate events are delivered via native push
   * subscription (≈0 CU ongoing cost). When absent, falls back to HTTP
   * polling at 2s.
   *
   * NOTE: Liquidate events always use HTTP polling regardless of this field.
   * Alchemy WS eth_subscribe can silently drop high-throughput events. Polling is
   * deterministic, but must stay below provider rate limits.
   */
  wsPublicClient?: PublicClient;
  morphoAddress: Address;
  onMarketPositionEvent: (marketId: Hex, borrower: Address) => void;
  onLiquidateEvent?: (log: Log) => void | Promise<void>;
}

/**
 * Polling interval for Liquidate events via HTTP eth_getLogs.
 * Default 2s keeps Base capture deterministic without hammering paid RPC quotas.
 * Non-Liquidate events use WS eth_subscribe when wsPublicClient is provided.
 */
const DEFAULT_LIQUIDATE_POLL_INTERVAL_MS = 2_000;
const MIN_LIQUIDATE_POLL_INTERVAL_MS = 1_000;
const MAX_LIQUIDATE_POLL_INTERVAL_MS = 60_000;
const WATCH_ERROR_LOG_INTERVAL_MS = 60_000;

function getLiquidatePollIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.MORPHO_LIQUIDATE_POLL_INTERVAL_MS ?? `${DEFAULT_LIQUIDATE_POLL_INTERVAL_MS}`,
    10,
  );
  if (!Number.isFinite(parsed)) return DEFAULT_LIQUIDATE_POLL_INTERVAL_MS;
  return Math.min(MAX_LIQUIDATE_POLL_INTERVAL_MS, Math.max(MIN_LIQUIDATE_POLL_INTERVAL_MS, parsed));
}

export function startMorphoEventWatcher(args: StartMorphoEventWatcherArgs): () => void {
  const {
    chainId,
    logTag,
    publicClient,
    wsPublicClient,
    morphoAddress,
    onMarketPositionEvent,
    onLiquidateEvent,
  } = args;

  const useWs = wsPublicClient !== undefined;
  const positionEventTransport = useWs ? "WS subscribe" : "HTTP poll 2000ms";
  const liquidatePollIntervalMs = getLiquidatePollIntervalMs();
  const lastErrorLogMsByEvent = new Map<string, number>();
  console.log(
    `${logTag}MorphoEventWatcher: ${positionEventTransport} (position events) + HTTP poll ${liquidatePollIntervalMs}ms (Liquidate) on chain=${chainId} address=${morphoAddress}`,
  );

  const unwatchers = morphoPositionEvents.map(({ eventName, borrowerField }) => {
    // Liquidate events: always HTTP poll. WS eth_subscribe silently drops events
    // at high throughput (~50K/day on Base). Dedicated HTTP poll gives full capture.
    // All other position events: prefer WS push subscription when available.
    const isLiquidate = eventName === "Liquidate";
    const client = isLiquidate ? publicClient : useWs ? wsPublicClient : publicClient;
    const pollForThisEvent = isLiquidate ? true : !useWs;
    const pollingOpts = pollForThisEvent
      ? { poll: true as const, pollingInterval: isLiquidate ? liquidatePollIntervalMs : 2_000 }
      : {};

    return watchContractEvent(client, {
      address: morphoAddress,
      abi: morphoBlueAbi,
      eventName,
      onLogs: (logs) => {
        for (const log of logs) {
          const eventArgs = log.args as MarketPositionEventArgs;
          const borrower = borrowerField === "borrower" ? eventArgs.borrower : eventArgs.onBehalf;
          if (borrower !== undefined && eventArgs.id !== undefined) {
            onMarketPositionEvent(eventArgs.id, borrower);
          }
          if (eventName === "Liquidate" && onLiquidateEvent !== undefined) {
            try {
              const result = onLiquidateEvent(log as Log);
              if (result instanceof Promise) {
                result.catch((err: unknown) => {
                  console.error(
                    `${logTag}MorphoEventWatcher: onLiquidateEvent error: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
              }
            } catch (err: unknown) {
              console.error(
                `${logTag}MorphoEventWatcher: onLiquidateEvent error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("429") || message.includes("Too Many Requests")) {
          healthState.errors429Count += 1;
        }
        const now = Date.now();
        const lastLogMs = lastErrorLogMsByEvent.get(eventName) ?? 0;
        if (now - lastLogMs < WATCH_ERROR_LOG_INTERVAL_MS) return;
        lastErrorLogMsByEvent.set(eventName, now);
        console.error(`${logTag}MorphoEventWatcher: ${eventName} watch error: ${message}`);
      },
      ...pollingOpts,
    });
  });

  return () => {
    for (const unwatch of unwatchers) {
      unwatch();
    }
  };
}
