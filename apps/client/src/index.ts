import {
  MARKETS_FETCHING_COOLDOWN_PERIOD,
  POSITION_LIQUIDATION_COOLDOWN_ENABLED,
  POSITION_LIQUIDATION_COOLDOWN_PERIOD,
  ALWAYS_REALIZE_BAD_DEBT,
  type ChainConfig,
} from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { createPricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
  fallback,
  http,
  webSocket,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { watchBlocks } from "viem/actions";

import { AutoRefuel } from "./auto-refuel";
import { LiquidationBot, type LiquidationBotInputs } from "./bot";
import { CanaryTracker, estimateLiquidationProfitUsd, loadCanaryConfigFromEnv } from "./canary";
import {
  CexPredictor,
  ORACLE_TO_CEX_MAP,
  calculateTriggerPrice,
  type ThresholdCrossing,
  type LiquidationThreshold,
} from "./cex-predictor";
import { CompetitorIntelLogger } from "./competitorIntelLogger.js";
import { discord } from "./discord-notifier";
import { FlashblockHandler } from "./flashblock-handler";
import { FlashblockWatcher, BASE_AGGREGATORS } from "./flashblock-watcher";
import { SKIP_SYMBOLS, MIN_BORROW_USDC_6DEC, MIN_BORROW_WETH_18DEC } from "./liquidation-constants";
import { startMorphoEventWatcher } from "./morpho-event-watcher";
import { NonceManager } from "./nonce-manager";
import {
  AlchemySubmitter,
  AnkrSubmitter,
  BloxrouteSubmitter,
  ParallelSubmitter,
} from "./parallel-submitter.js";
import {
  POLL_GAS_LIMIT,
  getPollGasParams,
  startPollLiquidationTrigger,
} from "./poll-liquidation-trigger.js";
import { PositionCache } from "./position-cache";
import { PreSigner } from "./preSigner.js";
import { PrimaryWalletCoordinator } from "./primary-wallet-coordinator";
import { ShadowLogger } from "./shadow-logger";
import { TxCache } from "./tx-cache";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms";
import { getMinBorrowUsdc6Dec, isHarnessBypassActive } from "./utils/harness-filter-bypass.js";
import { MORPHO_BLUE } from "./utils/morphoConstants";
import { createEventTimer } from "./utils/shadowTimingLogger.js";
import { WalletPool } from "./wallet-pool";

export const launchBot = (config: ChainConfig, dataProvider: DataProvider) => {
  const logTag = `[${config.chain.name} client]: `;
  console.log(`${logTag}Starting up`);

  type BotWalletClient = WalletClient<Transport, Chain, Account>;
  const client = createWalletClient({
    chain: config.chain,
    transport: config.fallbackRpcUrl
      ? fallback([http(config.rpcUrl), http(config.fallbackRpcUrl)])
      : http(config.rpcUrl),
    account: privateKeyToAccount(config.liquidationPrivateKey),
  }) as BotWalletClient;
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: config.fallbackRpcUrl
      ? fallback([http(config.rpcUrl), http(config.fallbackRpcUrl)])
      : http(config.rpcUrl),
  });

  // WS client for event subscriptions (MockOracle, Morpho events).
  // eth_subscribe is near-zero CU cost vs HTTP polling.
  // Falls back to undefined if no WS URL configured → watchers use HTTP poll.
  const wsPublicClient = config.wsUrl
    ? createPublicClient({ chain: config.chain, transport: webSocket(config.wsUrl) })
    : undefined;
  if (wsPublicClient) {
    console.log(`${logTag}WS event subscription client ready: ${config.wsUrl}`);
  }

  // WALLET POOL — multi-wallet support
  // Primary wallet (index 0) always exists. Additional wallets are optional:
  // LIQUIDATION_PRIVATE_KEY_{chainId}_1, EXECUTOR_ADDRESS_{chainId}_1, etc.
  const defaultAffinities: string[][] = [
    ["btc", "wbtc", "cbbtc"], // Wallet 0: BTC markets
    ["eth", "weth", "wsteth", "cbeth"], // Wallet 1: ETH markets
    ["xrp", "ada", "ltc", "link", "sol"], // Wallet 2: altcoin overflow
  ];
  const walletAffinities = config.walletAffinities ?? defaultAffinities;

  const walletEntries: {
    client: BotWalletClient;
    executorAddress: Address;
    marketAffinity: string[];
  }[] = [
    {
      client,
      executorAddress: config.executorAddress,
      marketAffinity: walletAffinities[0] ?? [],
    },
  ];

  // Load additional wallets from env (optional)
  for (let i = 1; i <= 10; i++) {
    const pkEnvKey = `LIQUIDATION_PRIVATE_KEY_${config.chainId}_${i}`;
    const execEnvKey = `EXECUTOR_ADDRESS_${config.chainId}_${i}`;
    const pk = process.env[pkEnvKey];
    const exec = process.env[execEnvKey];

    if (pk === undefined || exec === undefined) break; // Stop at first missing pair

    const additionalClient = createWalletClient({
      chain: config.chain,
      transport: config.fallbackRpcUrl
        ? fallback([http(config.rpcUrl), http(config.fallbackRpcUrl)])
        : http(config.rpcUrl),
      account: privateKeyToAccount(pk as Hex),
    }) as BotWalletClient;

    walletEntries.push({
      client: additionalClient,
      executorAddress: exec as Address,
      marketAffinity: walletAffinities[i] ?? [],
    });
    console.log(`${logTag}Additional wallet[${i}] loaded: executor=${exec}`);
  }

  const walletPool = new WalletPool(walletEntries, logTag);
  const primaryWalletCoordinator = new PrimaryWalletCoordinator(
    client,
    config.executorAddress,
    logTag,
  );
  const executorAddresses = new Set<Address>([config.executorAddress.toLowerCase() as Address]);
  const executorPrefix = `EXECUTOR_ADDRESS_${config.chainId}`;
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(executorPrefix) || !value) continue;
    executorAddresses.add(value.toLowerCase() as Address);
  }
  const shadowLogger = new ShadowLogger({
    logPath: "logs/shadow_events.jsonl",
    publicClient,
    morphoAddress: MORPHO_BLUE,
    ourExecutorAddresses: executorAddresses,
    logTag,
  });

  const competitorIntel = new CompetitorIntelLogger({ publicClient });

  // PARALLEL SUBMITTER — raw signed-tx lane used by CEX presigned hot path.
  const parallelSubmitter = new ParallelSubmitter({
    submitters: [new AlchemySubmitter(publicClient), new BloxrouteSubmitter(), new AnkrSubmitter()],
    logger: competitorIntel,
    logTag,
  });
  // Banner reflects post-construction state of each submitter, not raw env vars.
  // Previous version checked `process.env.RPC_URL_FALLBACK_8453 ? ", ankr"` but
  // AnkrSubmitter nullifies its rpcUrl when the URL is the unauthenticated
  // `rpc.ankr.com/base` endpoint — so the banner could advertise "ankr" while
  // AnkrSubmitter.send() always returned "disabled". `isEnabled()` introspects
  // the actual instance state.
  const enabledPaths = parallelSubmitter
    .getSubmitters()
    .filter((s) => s.isEnabled())
    .map((s) => s.name)
    .join(", ");
  console.log(`${logTag}[ParallelSubmitter] enabled paths: ${enabledPaths}`);

  // LIQUIDITY VENUES
  const liquidityVenues = config.liquidityVenues.map((liquidityVenueName) =>
    createLiquidityVenue(liquidityVenueName),
  );

  // PRICERS
  const pricers = config.pricers
    ? config.pricers.map((pricerName) => createPricer(pricerName))
    : undefined;

  // FLASHBOTS

  let flashbotAccount = undefined;
  if (config.useFlashbots) {
    const flashbotsPrivateKey = process.env.FLASHBOTS_PRIVATE_KEY;

    if (flashbotsPrivateKey === undefined) {
      throw new Error(`${logTag} FLASHBOTS_PRIVATE_KEY is not set`);
    }

    flashbotAccount = privateKeyToAccount(process.env.FLASHBOTS_PRIVATE_KEY as Hex);
  }

  let positionLiquidationCooldownMechanism = undefined;
  if (POSITION_LIQUIDATION_COOLDOWN_ENABLED) {
    positionLiquidationCooldownMechanism = new PositionLiquidationCooldownMechanism(
      POSITION_LIQUIDATION_COOLDOWN_PERIOD,
    );
  }

  const marketsFetchingCooldownMechanism = new MarketsFetchingCooldownMechanism(
    MARKETS_FETCHING_COOLDOWN_PERIOD,
  );

  // NONCE MANAGER — retained for secondary wallets. wallet[0] nonces are owned by
  // PrimaryWalletCoordinator and must not be pre-warmed or reset externally.
  const nonceManager = new NonceManager();

  // CANARY TRACKER — Phase 2 production validation gate.
  // Controlled by env (CANARY_MODE=true to enable). Pass-through when disabled.
  const canary = new CanaryTracker(loadCanaryConfigFromEnv());
  if (canary.enabled) {
    const stats = canary.getStats();
    console.log(
      `${logTag}CANARY ENABLED: dailyCap=$${stats.todayGasCapUsd} weeklyCap=$${stats.weekGasCapUsd} lossCap=$${stats.maxLossCapUsd} cumulativeProfit=$${stats.cumulativeProfitUsd.toFixed(2)}`,
    );
    if (canary.stopped) {
      console.error(`${logTag}CANARY STOPPED (persistent state): ${canary.stoppedReason}`);
    }
  }

  const inputs: LiquidationBotInputs = {
    logTag,
    chainId: config.chainId,
    client,
    wNative: config.wNative,
    vaultWhitelist: config.vaultWhitelist,
    additionalMarketsWhitelist: config.additionalMarketsWhitelist,
    executorAddress: config.executorAddress,
    treasuryAddress: config.treasuryAddress ?? client.account.address,
    dataProvider,
    liquidityVenues,
    pricers,
    marketsFetchingCooldownMechanism,
    positionLiquidationCooldownMechanism,
    flashbotAccount,
    shadowLogger,
    alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
    useL2PriorityBidding: config.useL2PriorityBidding,
    primaryWalletCoordinator,
    canary,
    quoteGateEnabled: config.quoteGateEnabled,
    quoteGateBufferBps: config.quoteGateBufferBps,
  };

  const bot = new LiquidationBot(inputs);

  // FAST PATH — PositionCache + CEX Predictor (all chains with useFastPath)
  if (config.useFastPath) {
    const harnessPollEnabled = isHarnessBypassActive(config.chainId);
    // Position cache must be created before CEX predictor (used in CEX callback)
    const marketIds = [...config.additionalMarketsWhitelist.map((id) => id as string)];
    const positionCache = new PositionCache(
      logTag,
      config.chainId,
      marketIds.length > 0 ? marketIds : undefined,
      publicClient,
    );
    positionCache.start(30_000);

    const preSigner = new PreSigner(
      primaryWalletCoordinator.client,
      primaryWalletCoordinator.executorAddress,
      { maxCacheAge: 12 * 60_000 },
    );
    console.log(
      `${logTag}PreSigner: created for executor=${primaryWalletCoordinator.executorAddress}`,
    );

    // TX CACHE — pre-builds liquidation calldata for near-liquidation positions
    const txCache = new TxCache({
      logTag,
      chainId: config.chainId,
      client,
      positionCache,
      executorAddress: config.executorAddress,
      treasuryAddress: config.treasuryAddress ?? client.account.address,
      liquidityVenues,
      liquidationBufferBps: config.liquidationBufferBps,
      quoteGateEnabled: config.quoteGateEnabled,
      quoteRaceEnabled: config.quoteRaceEnabled,
      quoteGateBufferBps: config.quoteGateBufferBps,
      // Pre-sign every freshly built TX into PreSigner cache. Additive — does
      // not submit. Was previously gated by `harnessPollEnabled` (= false in
      // prod), which left the cache permanently empty and made every fast-path
      // hit `cold_no_cache`. Identical silent-failure pattern as the
      // ORACLE_TO_CEX_MAP bug (commit c669e77): a dev/test toggle baked into
      // the production wire. Verified 2026-05-04 — fix unblocks PreSigner cache
      // for FlashblockHandler, poll-liquidation-trigger, and CEX ARM #1.
      onBuildComplete: async (prebuilt) => {
        const nonce = await primaryWalletCoordinator.reserveNonce(
          `presign:${prebuilt.borrower.toLowerCase()}:${prebuilt.marketId}`,
          30_000,
        );
        const { maxFeePerGas, maxPriorityFeePerGas } = await getPollGasParams(
          primaryWalletCoordinator.client,
          prebuilt,
        );
        try {
          await preSigner.presign(
            prebuilt.borrower,
            prebuilt.marketId,
            TxCache.encodeCalldata(prebuilt),
            nonce,
            POLL_GAS_LIMIT,
            maxFeePerGas,
            maxPriorityFeePerGas,
          );
        } catch (error) {
          primaryWalletCoordinator.releaseReservedNonce(nonce);
          throw error;
        }
      },
    });
    const stopMorphoWatcher = startMorphoEventWatcher({
      chainId: config.chainId,
      logTag,
      publicClient,
      wsPublicClient,
      morphoAddress: MORPHO_BLUE,
      onMarketPositionEvent: (marketId, borrower) => {
        preSigner.invalidate(borrower, marketId);
        void txCache.rebuildOne(borrower, marketId);
      },
      onLiquidateEvent: (log) => void competitorIntel.recordLiquidateEvent(log),
    });

    // NONCE MANAGER — pre-warm secondary wallets only. wallet[0] is owned by
    // PrimaryWalletCoordinator and lazily reads pending nonce under its lease.
    walletEntries.forEach((entry, index) => {
      if (index === 0) return;
      nonceManager.preWarm(entry.client, index).catch((e: unknown) => {
        console.error("[notify]", e instanceof Error ? e.message : e);
      });
    });

    // Refresh TxCache — hybrid strategy:
    // 1. Timer: every 30 minutes (background, keeps cache warm)
    // 2. Event-driven: when Flashblock detects >1% price move (instant freshness when it matters)
    let lastTxCacheRefreshMs = 0;
    const TX_CACHE_COOLDOWN_MS = 60_000; // Don't rebuild more than once per minute
    const refreshTxCache = async (trigger?: string, force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastTxCacheRefreshMs < TX_CACHE_COOLDOWN_MS) return;
      lastTxCacheRefreshMs = now;
      const candidates = positionCache.findNearLiquidation(1.05);
      if (candidates.length === 0) return;

      const positions = candidates.map((c) => c.position);
      try {
        await txCache.build(positions);
        walletEntries.forEach((w, i) => {
          if (i !== 0)
            nonceManager.preWarm(w.client, i).catch((e: unknown) => {
              console.error("[nonce-prewarm]", e instanceof Error ? e.message : e);
            });
        });
        if (trigger) {
          console.log(`${logTag}TxCache: event-driven refresh (${trigger})`);
        }
      } catch (err: unknown) {
        console.error(`${logTag}TxCache build error:`, err instanceof Error ? err.message : err);
      }
    };
    const refreshState = async (trigger: string): Promise<void> => {
      try {
        await positionCache.forceRefresh();
      } catch (err) {
        console.error(
          `${logTag}[POLL] positionCache.forceRefresh error:`,
          err instanceof Error ? err.message : err,
        );
      }
      await refreshTxCache(trigger, true /* force — bypass cooldown */);
    };
    setTimeout(() => {
      void refreshTxCache();
    }, 10_000);
    setInterval(() => {
      void refreshTxCache();
    }, 10 * 60_000); // 10-min fallback: event-driven (Sprint 43) covers state changes, but WS disconnect or missed Morpho log requires periodic full sweep. 30min was too long for crash scenarios — $$ lost during silent window.

    // TEST/HARNESS ONLY: polling trigger for markets that do not emit OCR2
    // aggregator updates into FlashblockWatcher. The hard env+chain gate keeps
    // production behavior unchanged until this path is validated.
    let pollHandle: { interval: ReturnType<typeof setInterval>; stop: () => void } | null = null;
    if (harnessPollEnabled) {
      pollHandle =
        startPollLiquidationTrigger({
          chainId: config.chainId,
          logTag,
          positionCache,
          txCache,
          primaryWalletCoordinator,
          publicClient,
          wsPublicClient,
          preSigner,
          shadowLogger,
          // HARNESS: on MockOracle PriceUpdated, refresh PositionCache (DIRECT+API)
          // then rebuild TxCache so the now-underwater custom market position has
          // calldata ready when runTick fires moments later.
          onOraclePriceChange: () => refreshState("MockOracle.PriceUpdated"),
          onAttemptSubmitted: () => refreshState("POLL.submitSuccess"),
        }) ?? null;
    }

    // GRACEFUL SHUTDOWN — clean up WS subscriptions and polling intervals.
    const shutdown = () => {
      console.log(`${logTag}Graceful shutdown: stopping watchers`);
      stopMorphoWatcher();
      pollHandle?.stop();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Track in-flight liquidation attempts for the CEX Predictor path
    const inFlightBorrowersCex = new Set<string>();
    // Will be set when FlashblockHandler is created (if L2 bidding is enabled)
    let flashblockHandler: FlashblockHandler | null = null;
    const meetsPredictorMinBorrow = (borrowAssets: bigint, loanDecimals: number): boolean => {
      const defaultMinBorrow = loanDecimals <= 8 ? MIN_BORROW_USDC_6DEC : MIN_BORROW_WETH_18DEC;
      const minBorrow = getMinBorrowUsdc6Dec(config.chainId, defaultMinBorrow);
      return borrowAssets >= minBorrow;
    };

    const predictor = new CexPredictor(logTag, (crossings: ThresholdCrossing[]) => {
      if (crossings.length === 0) return;
      // Skip CEX fire if Flashblock batch is in flight OR a wallet is acquired (nonce race prevention).
      // primaryWalletCoordinator.isBusy covers wallet[0]; walletPool.isAnyAcquired() covers
      // secondary wallet paths that still use the pool.
      if (
        flashblockHandler?.isBatchInFlight ||
        primaryWalletCoordinator.isBusy ||
        walletPool.isAnyAcquired()
      ) {
        console.log(`${logTag}CEX ALERT: wallet busy — skipping to avoid nonce collision`);
        return;
      }
      const top = crossings[0]!;
      console.log(
        `${logTag}⚡ CEX ALERT: ${top.threshold.collateralSymbol} $${top.currentCexPrice.toFixed(2)} ` +
          `crossed trigger $${top.threshold.triggerCexPrice.toFixed(2)} (${top.dropPercent.toFixed(2)}% below) — ` +
          `${crossings.length} positions at risk`,
      );
      void (async () => {
        // Sprint 51b: cex-presign timer wrapping the presign batch loop.
        const cexPresignTimer = createEventTimer("cex-presign", undefined, {
          cexPair: top.threshold.collateralSymbol,
          cexPrice: top.currentCexPrice,
        });
        cexPresignTimer.setHandlerDispatch();
        try {
          const affectedMarketIds = new Set(
            crossings.map((crossing) => crossing.threshold.marketId.toLowerCase()),
          );
          const presignCandidates = positionCache
            .findNearLiquidation(1.05)
            .filter((candidate) => {
              if (!affectedMarketIds.has(candidate.position.marketId.toLowerCase())) return false;
              return meetsPredictorMinBorrow(
                candidate.borrowAssets,
                candidate.position.loanDecimals,
              );
            })
            .slice(0, 3);

          if (presignCandidates.length === 0) return;

          for (const candidate of presignCandidates) {
            cexPresignTimer.addCandidate({
              borrower: candidate.position.borrower,
              marketId: candidate.position.marketId,
              collateralSymbol: candidate.position.collateralSymbol,
            });
          }

          const results = await Promise.allSettled(
            presignCandidates.map(async (candidate) => {
              const { borrower, marketId } = candidate.position;
              const prebuilt = txCache.get(borrower, marketId);
              if (prebuilt === undefined) {
                cexPresignTimer.setSkipped(
                  { borrower, marketId, collateralSymbol: candidate.position.collateralSymbol },
                  "no-cache",
                );
                return;
              }

              cexPresignTimer.setCalldataReady({
                borrower,
                marketId,
                collateralSymbol: candidate.position.collateralSymbol,
              });

              const { maxFeePerGas, maxPriorityFeePerGas } = await getPollGasParams(
                primaryWalletCoordinator.client,
                prebuilt,
              );
              const nonce = await primaryWalletCoordinator.reserveNonce(
                `cex-presign:${borrower.toLowerCase()}:${marketId}`,
                30_000,
              );
              let signedTx: Hex;
              try {
                signedTx = await preSigner.presign(
                  borrower,
                  marketId,
                  TxCache.encodeCalldata(prebuilt),
                  nonce,
                  POLL_GAS_LIMIT,
                  maxFeePerGas,
                  maxPriorityFeePerGas,
                );
              } catch (error) {
                primaryWalletCoordinator.releaseReservedNonce(nonce);
                throw error;
              }
              cexPresignTimer.setSignComplete(
                { borrower, marketId, collateralSymbol: candidate.position.collateralSymbol },
                false,
              );
              cexPresignTimer.setWouldSubmit({
                borrower,
                marketId,
                collateralSymbol: candidate.position.collateralSymbol,
              });
              console.log(`${logTag}CEX→PreSigner: cached+submitting signed tx for ${borrower}`);
              // ARM #1: submit immediately after presign; consume nonce so cex-direct won't double-submit.
              if (primaryWalletCoordinator.consumeReservedNonce(nonce)) {
                parallelSubmitter
                  .send(signedTx)
                  .then((result) => {
                    if (result.rpcStatus !== "accepted") {
                      primaryWalletCoordinator.resetNonceCacheForExternalSubmit();
                      throw new Error(result.errorMessage ?? `submit rejected via ${result.path}`);
                    }
                    preSigner.invalidate(borrower, marketId);
                    primaryWalletCoordinator.resetNonceCacheForExternalSubmit();
                    shadowLogger.recordAttempt({
                      borrower,
                      marketId,
                      collateralSymbol: candidate.position.collateralSymbol,
                      loanSymbol: candidate.position.loanSymbol ?? "",
                      ourTxHash: result.txHash,
                      ourTipWei: maxPriorityFeePerGas,
                      ourMaxFeePerGasWei: maxFeePerGas,
                      ourSentBlock: 0n,
                      ourSentMs: Date.now(),
                      expectedProfitUsd: estimateLiquidationProfitUsd(
                        candidate.position.loanDecimals <= 8
                          ? Number(candidate.borrowAssets) / 1e6
                          : 0,
                        candidate.position.lltv,
                      ),
                    });
                    console.log(
                      `${logTag}CEX→PreSigner ARM#1: submitted tx=${result.txHash} via ${result.path}`,
                    );
                  })
                  .catch((e: unknown) => {
                    primaryWalletCoordinator.resetNonceCacheForExternalSubmit();
                    console.error(
                      `${logTag}CEX→PreSigner ARM#1 submit error:`,
                      e instanceof Error ? e.message : e,
                    );
                  });
              }
            }),
          );

          results.forEach((result) => {
            if (result.status === "rejected") {
              console.error(
                `${logTag}CEX→PreSigner error:`,
                result.reason instanceof Error ? result.reason.message : result.reason,
              );
            }
          });
        } catch (error: unknown) {
          console.error(
            `${logTag}CEX→PreSigner error:`,
            error instanceof Error ? error.message : error,
          );
        } finally {
          // Sprint 51b: flush all presign candidates.
          cexPresignTimer.flush();
        }
      })();
      // Fast-path: attempt liquidation on near-liquidation positions
      // Apply same filters as Flashblock path to avoid unprofitable/unsupported liquidations.
      const candidates = positionCache.findNearLiquidation().filter((c) => {
        if (SKIP_SYMBOLS.has(c.position.collateralSymbol.toLowerCase())) return false;
        return meetsPredictorMinBorrow(c.borrowAssets, c.position.loanDecimals);
      });
      if (candidates.length > 0) {
        // Sprint 51b: cex-direct timer for the fastLiquidate submission path.
        const cexDirectTimer = createEventTimer("cex-direct", undefined, {
          cexPair: top.threshold.collateralSymbol,
          cexPrice: top.currentCexPrice,
        });
        cexDirectTimer.setHandlerDispatch();
        for (const candidate of candidates.slice(0, 5)) {
          cexDirectTimer.addCandidate({
            borrower: candidate.position.borrower,
            marketId: candidate.position.marketId,
            collateralSymbol: candidate.position.collateralSymbol,
          });
        }
        for (const candidate of candidates.slice(0, 5)) {
          const borrowerKey = candidate.position.borrower.toLowerCase();
          if (inFlightBorrowersCex.has(borrowerKey)) {
            cexDirectTimer.setSkipped(
              {
                borrower: candidate.position.borrower,
                marketId: candidate.position.marketId,
                collateralSymbol: candidate.position.collateralSymbol,
              },
              "in-flight",
            );
            continue;
          }
          inFlightBorrowersCex.add(borrowerKey);
          cexDirectTimer.setWouldSubmit({
            borrower: candidate.position.borrower,
            marketId: candidate.position.marketId,
            collateralSymbol: candidate.position.collateralSymbol,
          });
          const cachedSignedTx = preSigner.get(
            candidate.position.borrower,
            candidate.position.marketId,
          );
          if (
            cachedSignedTx !== undefined &&
            primaryWalletCoordinator.consumeReservedNonce(cachedSignedTx.nonce)
          ) {
            parallelSubmitter
              .send(cachedSignedTx.signedTx)
              .then((result) => {
                if (result.rpcStatus !== "accepted") {
                  primaryWalletCoordinator.resetNonceCacheForExternalSubmit();
                  throw new Error(result.errorMessage ?? `submit rejected via ${result.path}`);
                }
                preSigner.invalidate(candidate.position.borrower, candidate.position.marketId);
                shadowLogger.recordAttempt({
                  borrower: candidate.position.borrower,
                  marketId: candidate.position.marketId,
                  collateralSymbol: candidate.position.collateralSymbol,
                  loanSymbol: candidate.position.loanSymbol ?? "",
                  ourTxHash: result.txHash,
                  ourTipWei: cachedSignedTx.maxPriorityFeePerGas,
                  ourMaxFeePerGasWei: cachedSignedTx.maxFeePerGas,
                  ourSentBlock: 0n,
                  ourSentMs: Date.now(),
                  expectedProfitUsd: estimateLiquidationProfitUsd(
                    candidate.position.loanDecimals <= 8 ? Number(candidate.borrowAssets) / 1e6 : 0,
                    candidate.position.lltv,
                  ),
                });
                console.log(
                  `${logTag}CEX→ParallelSubmitter: submitted presigned tx=${result.txHash} via ${result.path}`,
                );
              })
              .catch((e: unknown) => {
                primaryWalletCoordinator.resetNonceCacheForExternalSubmit();
                console.error(
                  `${logTag}CEX presigned submit error:`,
                  e instanceof Error ? e.message : e,
                );
              })
              .finally(() => inFlightBorrowersCex.delete(borrowerKey));
            continue;
          }
          // ARM #2: cold fallback — try parallelSubmitter with fresh sign first; fastLiquidate is last resort.
          const coldPrebuilt = txCache.get(
            candidate.position.borrower,
            candidate.position.marketId,
          );
          if (coldPrebuilt !== undefined) {
            void (async () => {
              try {
                const { maxFeePerGas: coldMaxFee, maxPriorityFeePerGas: coldMaxTip } =
                  await getPollGasParams(primaryWalletCoordinator.client, coldPrebuilt);
                const coldNonce = await primaryWalletCoordinator.reserveNonce(
                  `cex-cold:${candidate.position.borrower.toLowerCase()}:${candidate.position.marketId}`,
                  15_000,
                );
                let coldSignedTx: Hex;
                try {
                  coldSignedTx = await preSigner.presign(
                    candidate.position.borrower,
                    candidate.position.marketId,
                    TxCache.encodeCalldata(coldPrebuilt),
                    coldNonce,
                    POLL_GAS_LIMIT,
                    coldMaxFee,
                    coldMaxTip,
                  );
                } catch (signErr) {
                  primaryWalletCoordinator.releaseReservedNonce(coldNonce);
                  throw signErr;
                }
                if (!primaryWalletCoordinator.consumeReservedNonce(coldNonce)) {
                  throw new Error("cold nonce already consumed");
                }
                const coldResult = await parallelSubmitter.send(coldSignedTx);
                if (coldResult.rpcStatus !== "accepted") {
                  primaryWalletCoordinator.resetNonceCacheForExternalSubmit();
                  throw new Error(
                    coldResult.errorMessage ?? `cold submit rejected via ${coldResult.path}`,
                  );
                }
                preSigner.invalidate(candidate.position.borrower, candidate.position.marketId);
                primaryWalletCoordinator.resetNonceCacheForExternalSubmit();
                shadowLogger.recordAttempt({
                  borrower: candidate.position.borrower,
                  marketId: candidate.position.marketId,
                  collateralSymbol: candidate.position.collateralSymbol,
                  loanSymbol: candidate.position.loanSymbol ?? "",
                  ourTxHash: coldResult.txHash,
                  ourTipWei: coldMaxTip,
                  ourMaxFeePerGasWei: coldMaxFee,
                  ourSentBlock: 0n,
                  ourSentMs: Date.now(),
                  expectedProfitUsd: estimateLiquidationProfitUsd(
                    candidate.position.loanDecimals <= 8 ? Number(candidate.borrowAssets) / 1e6 : 0,
                    candidate.position.lltv,
                  ),
                });
                console.log(
                  `${logTag}CEX ARM#2 cold submit: tx=${coldResult.txHash} via ${coldResult.path}`,
                );
              } catch (coldErr: unknown) {
                console.error(
                  `${logTag}CEX ARM#2 cold submit failed, falling back to fastLiquidate:`,
                  coldErr instanceof Error ? coldErr.message : coldErr,
                );
                await bot
                  .fastLiquidate(
                    candidate.position,
                    candidate.seizableCollateral,
                    candidate.borrowAssets,
                  )
                  .catch((e: unknown) => {
                    console.error(
                      `${logTag}CEX fast liquidate error:`,
                      e instanceof Error ? e.message : e,
                    );
                  });
              } finally {
                inFlightBorrowersCex.delete(borrowerKey);
              }
            })();
          } else {
            bot
              .fastLiquidate(
                candidate.position,
                candidate.seizableCollateral,
                candidate.borrowAssets,
              )
              .catch((e: unknown) => {
                console.error(
                  `${logTag}CEX fast liquidate error:`,
                  e instanceof Error ? e.message : e,
                );
              })
              .finally(() => inFlightBorrowersCex.delete(borrowerKey));
          }
        }
        cexDirectTimer.flush();
      } else {
        // No near-liquidation positions cached — skip.
        // bot.run() was here as fallback but costs 50K CU per call.
        // PositionCache updates every 30s; if no near-liquidation now, wait for next update.
        console.log(`${logTag}CEX ALERT: no near-liquidation positions in cache — skipping`);
      }
    });
    predictor.start();
    console.log(`${logTag}CEX Predictor enabled`);

    // Periodically load at-risk positions into the threshold table
    const loadThresholds = async () => {
      try {
        const query = JSON.stringify({
          query: `{
            marketPositions(
              where: {
                chainId_in: [${config.chainId}],
                healthFactor_gte: 0.9,
                healthFactor_lte: 1.30,
                borrowShares_gte: 1
              },
              first: 500
            ) {
              items {
                user { address }
                market {
                  uniqueKey
                  oracleAddress
                  lltv
                  collateralAsset { symbol decimals }
                  loanAsset { symbol decimals }
                }
                borrowAssets
                collateral
                healthFactor
              }
            }
          }`,
        });

        const response = await fetch("https://blue-api.morpho.org/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: query,
          signal: AbortSignal.timeout(30_000),
        });

        const data = (await response.json()) as {
          data?: {
            marketPositions?: {
              items?: {
                user: { address: string };
                market: {
                  uniqueKey: string;
                  oracleAddress: string;
                  lltv: string;
                  collateralAsset: { symbol: string; decimals: number };
                  loanAsset: { symbol: string; decimals: number };
                };
                borrowAssets: string;
                collateral: string;
                healthFactor: number;
              }[];
            };
          };
        };

        const items = data.data?.marketPositions?.items ?? [];
        if (items.length === 0) return;

        const newThresholds: LiquidationThreshold[] = [];

        for (const item of items) {
          const oracleAddr = item.market.oracleAddress.toLowerCase();
          const cexMapping = ORACLE_TO_CEX_MAP[oracleAddr];
          if (!cexMapping) continue; // No CEX mapping for this oracle

          const collateral = BigInt(item.collateral);
          const borrowAssets = BigInt(item.borrowAssets);
          const lltv = BigInt(item.market.lltv);

          if (collateral === 0n || borrowAssets === 0n) continue;

          const { triggerOraclePrice, triggerCexPrice } = calculateTriggerPrice(
            collateral,
            borrowAssets,
            lltv,
            0n, // oracleScaleFactor not used currently
            item.market.collateralAsset.decimals,
            item.market.loanAsset.decimals,
          );

          if (triggerCexPrice <= 0 || !isFinite(triggerCexPrice)) continue;

          newThresholds.push({
            borrower: item.user.address as Address,
            marketId: item.market.uniqueKey as Hex,
            triggerOraclePrice,
            triggerCexPrice,
            collateralSymbol: item.market.collateralAsset.symbol,
            cexPair: cexMapping.pair,
            seizableCollateral: collateral,
            borrowAssets,
            lltv,
          });
        }

        if (newThresholds.length > 0) {
          predictor.updateThresholds(newThresholds);
        }
      } catch (err: unknown) {
        console.error(
          `${logTag}CEX threshold load error:`,
          err instanceof Error ? err.message : err,
        );
      }
    };

    // Load thresholds immediately, then every 30 seconds
    void loadThresholds();
    setInterval(() => {
      void loadThresholds();
    }, 30_000);

    // FLASHBLOCK WATCHER — Base only (Flashblocks is a Base-specific feature)
    if (config.useL2PriorityBidding) {
      flashblockHandler = new FlashblockHandler(
        logTag,
        config,
        bot,
        positionCache,
        txCache,
        primaryWalletCoordinator,
        canary,
        shadowLogger,
        preSigner,
        config.pendingPrewarmFeeds,
      );

      // Wire event-driven TxCache refresh to the handler
      flashblockHandler.onSignificantPriceMove = (trigger: string) => {
        void refreshTxCache(trigger);
      };

      // Wire flash crash detection → immediate PositionCache + TxCache reload
      flashblockHandler.onFlashCrashDetected = () => {
        console.log(`${logTag}🚨 Flash crash: reloading PositionCache + TxCache immediately`);
        positionCache.reload(); // immediate API fetch, no interval duplication
        setTimeout(() => {
          void refreshTxCache();
        }, 3_000); // rebuild TxCache 3s after cache refresh
      };

      const flashblockWatcher = new FlashblockWatcher(logTag, BASE_AGGREGATORS, (event) => {
        flashblockHandler!.handleOracleUpdate(event);
      });
      flashblockWatcher.start();
      console.log(
        `${logTag}FlashblockWatcher enabled — monitoring ${BASE_AGGREGATORS.length} aggregator addresses`,
      );

      // Safety net: if Flashblock goes silent for 10 min, run bot.run() once.
      // Chainlink heartbeat is max 1 hour, so 10 min silence likely = WS issue.
      let lastSafetyNetRunMs = 0;
      setInterval(() => {
        void (async () => {
          const now = Date.now();
          const silenceMs = now - flashblockHandler!.lastFlashblockEventMs;
          const safetyNetCooldownMs = 10 * 60_000;
          if (silenceMs > safetyNetCooldownMs && now - lastSafetyNetRunMs > safetyNetCooldownMs) {
            lastSafetyNetRunMs = now;
            console.log(
              `${logTag}⚠️ Flashblock silent ${Math.floor(silenceMs / 60_000)}min — safety net bot.run()`,
            );
            discord
              .notifyError(
                "FlashblockWatcher",
                `Silent ${Math.floor(silenceMs / 60_000)}min — WS may be disconnected`,
              )
              .catch((e: unknown) => {
                console.error("[notify]", e instanceof Error ? e.message : e);
              });
            try {
              await bot.run();
            } catch (e: unknown) {
              console.error(`${logTag}Safety net error:`, e instanceof Error ? e.message : e);
            }
          }
        })();
      }, 5 * 60_000);
    }
  }

  // bot.run() fallback — DISABLED when fast path is active to save RPC CUs.
  // Fast path (FlashblockWatcher + CEX Predictor + PositionCache) handles
  // oracle-triggered liquidations with near-zero RPC usage. bot.run() does
  // heavy on-chain multicalls (~50K CU per run) to catch interest-accrual
  // liquidations, which are extremely rare. Enable only on chains without fast path.
  if (!config.useFastPath) {
    const blockInterval = config.blockInterval ?? 1;
    let count = 0;

    const watchClient = config.wsUrl
      ? createPublicClient({ chain: config.chain, transport: webSocket(config.wsUrl) })
      : client;

    if (config.wsUrl) {
      console.log(`${logTag}Using WebSocket for block detection: ${config.wsUrl}`);
    }

    const startWatching = () => {
      watchBlocks(watchClient, {
        onBlock: () => {
          if (count % blockInterval === 0) {
            bot.run().catch((e: unknown) => {
              console.error(`${logTag} uncaught error in bot.run():`, e);
            });
          }
          count++;
        },
        onError: (error) => {
          const retryDelay = config.watchBlocksRetryDelayMs ?? 5_000;
          console.error(
            `${logTag} watchBlocks error, restarting watcher in ${retryDelay}ms:`,
            error,
          );
          setTimeout(startWatching, retryDelay);
        },
      });
    };

    startWatching();
  } else {
    console.log(`${logTag}bot.run() fallback DISABLED — fast path is active (saves ~50K CU/run)`);
    // Periodic safety net: run bot.run() every 30 minutes to catch positions
    // that fall outside the PositionCache window (deep bad debt, interest accrual).
    // Cost: ~50K CU per run = ~1.5M CU/month = 5% of Alchemy free tier.
    setInterval(() => {
      void (async () => {
        try {
          console.log(`${logTag}Periodic bot.run() safety net...`);
          await bot.run();
        } catch (e: unknown) {
          console.error(`${logTag}Periodic bot.run() error:`, e instanceof Error ? e.message : e);
        }
      })();
    }, 30 * 60_000);
  }

  // AUTO-REFUEL: convert USDC profits → ETH gas when balance is low.
  // Only on Base (L2 gas is cheap, swap is cheap). ETH L1 gas refuel is manual.
  if (config.chainId === 8453 && process.env.SHADOW_ONLY !== "true") {
    // Flash-loan architecture: the wallet only holds gas money. Reserve is
    // `700K gas * maxFeePerGas`, which we cap at 5 gwei (whale tier) → 0.0035 ETH.
    // Refuel target covers ~2 whale TXs back-to-back before the next 30-min tick.
    const autoRefuel = new AutoRefuel({
      logTag,
      rpcUrl: config.rpcUrl,
      minEthWei: 3_000_000_000_000_000n, // 0.003 ETH (~$6.6) → trigger (1 whale TX remaining)
      refuelAmountWei: 8_000_000_000_000_000n, // 0.008 ETH (~$17.6) → target (~2-3 whale TXs)
      maxUsdcSpend: 25_000_000n, // 25 USDC cap matches 0.008 ETH target at ~$3.3k/ETH
      intervalMs: 30 * 60_000, // check every 30 min
      primaryWalletCoordinator,
    });
    for (const entry of walletEntries) {
      autoRefuel.addWallet(entry.client, walletEntries.indexOf(entry));
    }
    autoRefuel.start();
  } else if (config.chainId === 8453) {
    console.log(`${logTag}AutoRefuel disabled in shadow-only mode`);
  }

  // Discord startup notification
  discord.notifyStartup("v18", walletEntries.length, [config.chain.name]).catch((e: unknown) => {
    console.error("[notify]", e instanceof Error ? e.message : e);
  });
};
