import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import {
  estimateUniswapV3MaxSwapIn,
  type UniswapV3PoolSnapshot,
  LiquidityVenue,
} from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  AccrualPosition,
  ChainAddresses,
  getChainAddresses,
  type IMarketParams,
  MarketUtils,
  PreLiquidationPosition,
} from "@morpho-org/blue-sdk";
import { executorAbi } from "executooor-viem";
import {
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  LocalAccount,
  maxUint256,
  parseGwei,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import {
  getBalance,
  getBlock,
  getGasPrice,
  getTransactionReceipt,
  readContract,
  simulateCalls,
  writeContract,
} from "viem/actions";

import { estimateLiquidationProfitUsd, type CanaryTracker } from "./canary.js";
import { discord } from "./discord-notifier.js";
import { maxSafeSeize } from "./poolCap.js";
import type { CachedPosition } from "./position-cache.js";
import {
  type PrimaryWalletCoordinator,
  type PrimaryWalletLease,
} from "./primary-wallet-coordinator";
import type { ShadowLogger } from "./shadow-logger";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms.js";
import { fetchWhitelistedVaults } from "./utils/fetch-whitelisted-vaults.js";
import { Flashbots } from "./utils/flashbots.js";
import { isHarnessBypassActive, getProfitGateUsd } from "./utils/harness-filter-bypass.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";
import { resolveShareLiquidationPlan } from "./utils/morphoLiquidation.js";
import { MultiBuilderSubmitter } from "./utils/multiBuilder.js";
import { isShadowMode, submitOrShadow } from "./utils/txSubmitter.js";

const CBXRP_FAST_PATH_SEIZE_BPS = 500n;
const BPS = 10_000n;
const ETH_USD_FALLBACK = 3500n;
const USD_SCALE = 1_000_000n;

export interface LiquidationBotInputs {
  logTag: string;
  chainId: number;
  client: WalletClient<Transport, Chain, Account>;
  wNative: Address;
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  executorAddress: Address;
  treasuryAddress: Address;
  dataProvider: DataProvider;
  liquidityVenues: LiquidityVenue[];
  alwaysRealizeBadDebt: boolean;
  useL2PriorityBidding?: boolean;
  pricers?: Pricer[];
  positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  flashbotAccount?: LocalAccount;
  tipBps?: bigint;
  primaryWalletCoordinator: PrimaryWalletCoordinator;
  shadowLogger?: ShadowLogger;
  /** Phase 2 canary gate. Optional; when absent, all attempts pass through. */
  canary?: CanaryTracker;
}

export class LiquidationBot {
  private logTag: string;
  private chainId: number;
  private client: WalletClient<Transport, Chain, Account>;
  private chainAddresses: ChainAddresses;
  private wNative: Address;
  private vaultWhitelist: Address[] | "morpho-api";
  private additionalMarketsWhitelist: Hex[];
  private executorAddress: Address;
  private treasuryAddress: Address;
  private dataProvider: DataProvider;
  private liquidityVenues: LiquidityVenue[];
  private pricers?: Pricer[];
  private positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  private marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  private flashbotAccount?: LocalAccount;
  private tipBps?: bigint;
  private useL2PriorityBidding: boolean;
  private coveredMarkets: Hex[];
  private alwaysRealizeBadDebt: boolean;
  private multiBuilder?: MultiBuilderSubmitter;
  private primaryWalletCoordinator: PrimaryWalletCoordinator;
  private shadowLogger?: ShadowLogger;
  private canary?: CanaryTracker;
  private isRunning = false;

  /**
   * Shared gas-price cache across all liquidate()/preLiquidate() calls in a
   * single run() tick. Without this, a 147-position Promise.all spawns 147
   * parallel eth_gasPrice RPC calls, which public RPCs (esp. Arbitrum public
   * arb1.arbitrum.io) rate-limit into 42+ HttpRequestError fanouts. Keep TTL
   * short (5s) so we still adapt to price changes between cycles. Shared
   * in-flight promise prevents thundering-herd refetch on cold cache.
   */
  private cachedGasPrice: { value: bigint; fetchedAt: number } | null = null;
  private gasPriceInFlight: Promise<bigint> | null = null;
  private static readonly GAS_PRICE_CACHE_TTL_MS = 5_000;

  /**
   * In-memory per-(market,borrower) on-chain-revert counter. Bad-debt positions
   * that pass the optimistic-L2 quote-gate bypass but revert on-chain (e.g. swap
   * output << repay amount) keep cycling through the 1-hour cooldown forever,
   * draining gas. After REVERT_HARD_STOP_THRESHOLD on-chain reverts, hard-skip
   * the (market, borrower) pair for the rest of this process. Reset by restart.
   * Counter is incremented inside verifyCanaryReceipt when status === reverted.
   */
  private positionOnChainRevertCount = new Map<string, number>();
  private static readonly REVERT_HARD_STOP_THRESHOLD = 3;

  constructor(inputs: LiquidationBotInputs) {
    this.logTag = inputs.logTag;
    this.chainId = inputs.chainId;
    this.client = inputs.client;
    this.chainAddresses = getChainAddresses(inputs.chainId);
    this.wNative = inputs.wNative;
    this.vaultWhitelist = inputs.vaultWhitelist;
    this.additionalMarketsWhitelist = inputs.additionalMarketsWhitelist;
    this.executorAddress = inputs.executorAddress;
    this.treasuryAddress = inputs.treasuryAddress;
    this.dataProvider = inputs.dataProvider;
    this.liquidityVenues = inputs.liquidityVenues;
    this.pricers = inputs.pricers;
    this.positionLiquidationCooldownMechanism = inputs.positionLiquidationCooldownMechanism;
    this.marketsFetchingCooldownMechanism = inputs.marketsFetchingCooldownMechanism;
    this.flashbotAccount = inputs.flashbotAccount;
    this.tipBps = inputs.tipBps;
    this.useL2PriorityBidding = inputs.useL2PriorityBidding ?? false;
    this.coveredMarkets = [];
    this.alwaysRealizeBadDebt = inputs.alwaysRealizeBadDebt;
    this.primaryWalletCoordinator = inputs.primaryWalletCoordinator;
    this.shadowLogger = inputs.shadowLogger;
    this.canary = inputs.canary;
    if (inputs.flashbotAccount && inputs.chainId === 1) {
      this.multiBuilder = new MultiBuilderSubmitter(inputs.flashbotAccount, inputs.chainId);
    }
    if (isHarnessBypassActive(this.chainId)) {
      console.log(`${this.logTag}[HARNESS] filter bypass ACTIVE on Base (env=1)`);
    }
  }

  async run() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.fetchMarkets();
      const { liquidatablePositions, preLiquidatablePositions } =
        await this.dataProvider.fetchLiquidatablePositions(this.client, this.coveredMarkets);
      await Promise.all([
        ...liquidatablePositions.map((position) => this.liquidate(position)),
        ...preLiquidatablePositions.map((position) => this.preLiquidate(position)),
      ]);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Optimistic fast-path liquidation — skips simulation, sends TX directly.
   *
   * Revert cost on Base: ~$0.001. Saves ~200ms vs simulation path.
   * 936 reverts = $1 cost; a single successful liquidation covers thousands of reverts.
   *
   * For L1 (ETH mainnet with Flashbots), falls back to handleTx with simulation
   * since reverts waste bundle inclusion and gas is expensive.
   */
  async fastLiquidate(
    pos: CachedPosition,
    seizableCollateral: bigint,
    borrowAssets: bigint,
  ): Promise<boolean> {
    const lease = this.primaryWalletCoordinator.tryAcquire(
      `fastLiquidate:${pos.borrower.toLowerCase()}:${pos.marketId}`,
    );
    if (lease === null) {
      console.log(
        `${this.logTag}fastLiquidate: primary wallet busy — skipping ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol}`,
      );
      return false;
    }

    try {
      return await this.fastLiquidateWithLease(lease, pos, seizableCollateral, borrowAssets);
    } finally {
      this.primaryWalletCoordinator.release(lease);
    }
  }

  private async fastLiquidateWithLease(
    lease: PrimaryWalletLease,
    pos: CachedPosition,
    seizableCollateral: bigint,
    borrowAssets: bigint,
  ): Promise<boolean> {
    const marketParams = {
      loanToken: pos.loanToken,
      collateralToken: pos.collateralToken,
      oracle: pos.oracle,
      irm: pos.irm,
      lltv: pos.lltv,
    };

    const marketId = pos.marketId;
    if (!this.checkCooldown(marketId, pos.borrower)) return false;
    if (this.isPositionHardSkipped(marketId, pos.borrower)) {
      console.log(
        `${this.logTag}Fast skip: hard-stop (>=3 on-chain reverts) ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol}`,
      );
      return false;
    }

    const badDebtPosition = seizableCollateral === pos.collateral;

    const { executorAddress } = this;
    const encoder = new LiquidationEncoder(executorAddress, this.client);
    const morpho = this.chainAddresses.morpho;
    const market = {
      loanToken: marketParams.loanToken,
      collateralToken: marketParams.collateralToken,
      oracle: marketParams.oracle,
      irm: marketParams.irm,
      lltv: BigInt(marketParams.lltv),
    };

    // Compute safe repaidShares using Morpho math to avoid underflow.
    // Morpho's liquidate(seizedAssets) can underflow when computed repaidShares > borrower's shares.
    // Instead, use the repaidShares path: compute shares from target seized amount.
    const decreasedSeizable = await this.capFastPathSeizableCollateral(
      pos,
      this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition),
    );

    // Read oracle price for share calculation
    let oraclePrice: bigint;
    try {
      oraclePrice = await readContract(this.client, {
        address: marketParams.oracle,
        abi: [
          {
            name: "price",
            type: "function",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "uint256" }],
          },
        ] as const,
        functionName: "price",
      });
    } catch {
      console.warn(
        `${this.logTag}Fast liquidate: cannot read oracle price for ${pos.collateralSymbol}/${pos.loanSymbol}`,
      );
      return false;
    }

    const liquidationPlan = resolveShareLiquidationPlan({
      borrowShares: pos.borrowShares,
      collateral: pos.collateral,
      totalBorrowAssets: pos.totalBorrowAssets,
      totalBorrowShares: pos.totalBorrowShares,
      price: oraclePrice,
      lltv: pos.lltv,
      targetSeizedAssets: decreasedSeizable,
    });

    if (liquidationPlan === null) {
      console.warn(
        `${this.logTag}Fast liquidate: no safe repaidShares plan for ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol}`,
      );
      return false;
    }

    // Step 1: Build collateral->loan conversion using predicted seized amount
    if (
      !(await this.convertCollateralToLoan(marketParams, liquidationPlan.seizedAssets, encoder))
    ) {
      console.warn(
        `${this.logTag}Fast liquidate: no venue for ${pos.collateralSymbol}->${pos.loanSymbol}`,
      );
      return false;
    }
    const collateralToLoanCalls = encoder.flush();

    // Step 2: Repay amount based on predicted repaidAssets (not full borrowAssets)
    const repayAmount = (liquidationPlan.repaidAssets * 101n) / 100n;

    // Step 3: Build flash loan liquidation using repaidShares (avoids underflow)
    encoder.erc20Approve(marketParams.loanToken, morpho, 0n);
    encoder.erc20Approve(marketParams.loanToken, morpho, maxUint256);
    encoder.morphoBlueLiquidate(
      morpho,
      market,
      pos.borrower,
      0n,
      liquidationPlan.repaidShares,
      collateralToLoanCalls,
    );

    const flashLoanCallbackCalls = encoder.flush();

    // Wrap in flash loan
    const KNOWN_NON_STANDARD = new Set([
      "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    ]);
    const isNonStandard = KNOWN_NON_STANDARD.has(marketParams.loanToken.toLowerCase());

    if (isNonStandard) {
      const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address;
      encoder.erc20Approve(marketParams.loanToken, BALANCER_VAULT, 0n);
      encoder.erc20Approve(marketParams.loanToken, BALANCER_VAULT, repayAmount);
      const vaultApprovals = encoder.flush();
      encoder.balancerFlashLoan(
        BALANCER_VAULT,
        [{ asset: marketParams.loanToken, amount: repayAmount }],
        [...flashLoanCallbackCalls, ...vaultApprovals],
      );
    } else {
      encoder.blueFlashLoan(morpho, marketParams.loanToken, repayAmount, flashLoanCallbackCalls);
    }

    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);
    const calls = encoder.flush();

    const functionData = {
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [calls],
    } as const;

    try {
      if (this.useL2PriorityBidding) {
        // OPTIMISTIC L2 PATH — skip simulation, send immediately
        // Zero extra RPC calls. Revert cost ~$0.001, saves ~200ms.
        // Base Flashblocks: FIFO between flashblocks, priority fee within same flashblock.
        // H1: tier priority fee by estimated borrow USD. See FlashblockHandler for calibration.
        const loanSym = (pos.loanSymbol ?? "").toLowerCase();
        let usd = 0;
        if (loanSym.includes("usdc") || loanSym.includes("usdt") || loanSym.includes("eurc")) {
          usd = Number(borrowAssets) / 1e6;
        } else if (loanSym.includes("weth") || loanSym.includes("eth")) {
          usd = await this.usdValueFromEthAmount(borrowAssets);
        }
        // Session 35: Fee tier recalibrated based on Base competitor forensic analysis.
        // Top 2 whale hunters (B949a5, 3d7BEe) median effective tip = 0.005 gwei.
        // Our previous 2 gwei whale tier was 400x overkill. New tier: match competitors'
        // baseline at 0.005 gwei, let headroom be allocated by max-fee cap. If we lose,
        // investigate same-block reaction latency before increasing tip.
        //
        // Profit gate: $1 minimum (our operational cost ~$0.002/TX, so any profitable
        // event is worth pursuing). Previously $100 implicit via no-bid on small tiers.
        //
        // Tier (USD borrow value → base tip):
        //   <$10:        skip entirely (spray bot territory, pure noise)
        //   $10–$100:    0.005 gwei (floor, match competitor median)
        //   $100–$1K:    0.01 gwei
        //   $1K–$10K:    0.02 gwei
        //   $10K+:       0.05 gwei (10x floor, still 40x cheaper than old 2 gwei)
        const estimatedProfitUsd = estimateLiquidationProfitUsd(usd, pos.lltv);
        if (estimatedProfitUsd < getProfitGateUsd(this.chainId, 1)) {
          console.log(
            `${this.logTag}Fast skip: profit gate (profit=${estimatedProfitUsd.toFixed(2)} borrowUsd=${usd.toFixed(2)}) ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol}`,
          );
          return false;
        }
        // Canary gate (Phase 2): loss caps, collateral whitelist, stopped flag.
        // Pass-through when canary is absent or disabled.
        if (this.canary) {
          const decision = this.canary.shouldAttempt({
            collateralSymbol: pos.collateralSymbol,
            expectedBorrowUsd: usd,
            lltvWad: pos.lltv,
          });
          if (!decision.allow) {
            console.log(
              `${this.logTag}Canary skip: ${decision.reason} ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol}`,
            );
            this.canary.recordResult({
              timestamp: Date.now(),
              eventDate: new Date().toISOString().slice(0, 10),
              type: "skipped",
              borrower: pos.borrower,
              marketId: pos.marketId,
              collateralSymbol: pos.collateralSymbol,
              loanSymbol: pos.loanSymbol ?? "",
              expectedBorrowUsd: usd,
              lltvWad: pos.lltv,
              estimatedProfitUsd,
              gasCostUsd: 0,
              actualProfitUsd: 0,
              skipReason: decision.reason,
            });
            return false;
          }
        }
        const dynamicTip =
          usd >= 10_000
            ? 50_000_000n // 0.05 gwei
            : usd >= 1_000
              ? 20_000_000n // 0.02 gwei
              : usd >= 100
                ? 10_000_000n // 0.01 gwei
                : 5_000_000n; // 0.005 gwei — competitor median baseline
        // EIP-1559: maxFeePerGas must be >= baseFee + priorityFee.
        // Sprint D1 (2026-04-11) raised this to 2 gwei to clear baseFee spikes; comment
        // claimed wallets had 0.0007+ ETH and 2 gwei × 250K = 0.0005 ETH would pass.
        // 2026-05-04 reality check: actual gasLimit is ~700K (flash-loan + multi-hop swap),
        // not 250K. 2 gwei × 700K = 0.0014 ETH, exceeding W2's 0.0013 ETH balance and
        // causing every fastLiquidate to revert with "total cost exceeds balance".
        //
        // Lower to 1 gwei: 1 gwei × 700K = 0.0007 ETH, fits within bootstrap balances.
        // Base baseFee under normal load is <0.1 gwei; 1 gwei still gives 10x headroom.
        // If congestion-driven rejects reappear, raise once wallets are funded.
        const dynamicMaxFee = 1_000_000_000n; // 1 gwei (bootstrap-friendly cap)
        const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
        let txHash: Hex;
        const signStartMs = Date.now();
        try {
          txHash = await submitOrShadow({
            path: "write-contract",
            triggerPath: "fastLiquidate",
            candidateRef: {
              borrower: pos.borrower,
              marketId: pos.marketId,
              collateralSymbol: pos.collateralSymbol ?? "",
            },
            gasParams: {
              nonce,
              maxFeePerGas: dynamicMaxFee,
              maxPriorityFeePerGas: dynamicTip,
            },
            writeArgs: {
              address: encoder.address,
              functionName: functionData.functionName,
            },
            submit: () =>
              writeContract(this.client, {
                address: encoder.address,
                ...functionData,
                gas: 700_000n,
                maxPriorityFeePerGas: dynamicTip,
                maxFeePerGas: dynamicMaxFee,
                nonce,
              }),
            createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
          });
        } catch (error) {
          this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
          this.markPositionUsed(marketId, pos.borrower);
          // Canary: record pre-broadcast failure as revert with minimal cost.
          if (this.canary) {
            const msg = error instanceof Error ? error.message : String(error);
            this.canary.recordResult({
              timestamp: Date.now(),
              eventDate: new Date().toISOString().slice(0, 10),
              type: "revert",
              borrower: pos.borrower,
              marketId: pos.marketId,
              collateralSymbol: pos.collateralSymbol,
              loanSymbol: pos.loanSymbol ?? "",
              expectedBorrowUsd: usd,
              lltvWad: pos.lltv,
              estimatedProfitUsd: 0,
              gasCostUsd: 0, // no on-chain gas — failed before broadcast
              actualProfitUsd: 0,
              priorityFeeGwei: Number(dynamicTip) / 1e9,
              errorMessage: msg.slice(0, 200),
            });
          }
          throw error;
        }
        const broadcastedMs = Date.now();
        const shadowMode = isShadowMode();

        console.log(
          shadowMode
            ? `${this.logTag}⚡ SHADOW INTENT ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol} syntheticTx=${txHash} (not broadcast)`
            : `${this.logTag}⚡ OPTIMISTIC SENT ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol} tx=${txHash}`,
        );
        this.shadowLogger?.recordAttempt({
          borrower: pos.borrower,
          marketId: pos.marketId,
          collateralSymbol: pos.collateralSymbol ?? "",
          loanSymbol: pos.loanSymbol ?? "",
          ourTxHash: txHash,
          ourTipWei: dynamicTip,
          ourMaxFeePerGasWei: dynamicMaxFee,
          ourSentBlock: 0n,
          ourSentMs: broadcastedMs,
          expectedProfitUsd: estimatedProfitUsd,
        });
        this.markPositionUsed(marketId, pos.borrower);
        discord
          .notifyTxFired(
            `${pos.collateralSymbol}/${pos.loanSymbol}`,
            pos.borrower,
            txHash,
            0,
            shadowMode,
          )
          .catch(() => {});

        // Canary: log broadcast as "attempt" (no counter update). Final P&L is
        // recorded by verifyCanaryReceipt after receipt arrives.
        if (this.canary) {
          this.canary.recordResult({
            timestamp: broadcastedMs,
            eventDate: new Date(broadcastedMs).toISOString().slice(0, 10),
            type: "attempt",
            borrower: pos.borrower,
            marketId: pos.marketId,
            collateralSymbol: pos.collateralSymbol,
            loanSymbol: pos.loanSymbol ?? "",
            expectedBorrowUsd: usd,
            lltvWad: pos.lltv,
            estimatedProfitUsd,
            gasCostUsd: 0,
            actualProfitUsd: 0,
            txHash,
            priorityFeeGwei: Number(dynamicTip) / 1e9,
            signStartMs,
            broadcastedMs,
            latencyMs: broadcastedMs - signStartMs,
          });

          // Fire-and-forget receipt verification. Shadow-only mode produces a
          // synthetic tx hash, so there is intentionally no receipt to verify.
          if (!shadowMode) {
            this.verifyCanaryReceipt(txHash, {
              borrower: pos.borrower,
              marketId: pos.marketId,
              collateralSymbol: pos.collateralSymbol,
              loanSymbol: pos.loanSymbol ?? "",
              expectedBorrowUsd: usd,
              lltvWad: pos.lltv,
              priorityFeeGwei: Number(dynamicTip) / 1e9,
            }).catch((e: unknown) => {
              console.log(
                `${this.logTag}Canary receipt verify failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            });
          }
        }
        return true;
      } else if (this.flashbotAccount) {
        // ETH L1 with Flashbots — use simulation (reverts are expensive on L1)
        const success = await this.handleTx(
          encoder,
          calls,
          marketParams,
          pos.borrower,
          badDebtPosition,
          false,
          lease,
        );
        if (success) {
          console.log(
            `${this.logTag}FAST LIQUIDATED ${pos.borrower} on ${marketId} (${pos.collateralSymbol}/${pos.loanSymbol})`,
          );
        }
        return success ?? false;
      } else {
        // Simple path — just send
        const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
        // Explicit gas-fee caps. viem's default `baseFee + 2.5 gwei` causes
        // "total cost exceeds balance" on low-balance wallets (well-known per
        // BOT_CONTEXT.md). Same caps as auto-refuel.ts.
        const SIMPLE_PATH_MAX_FEE_PER_GAS = 100_000_000n; // 0.1 gwei
        const SIMPLE_PATH_MAX_PRIORITY_FEE_PER_GAS = 10_000_000n; // 0.01 gwei
        let txHash: Hex;
        try {
          txHash = await submitOrShadow({
            path: "write-contract",
            triggerPath: "fastLiquidate-simple",
            candidateRef: {
              borrower: pos.borrower,
              marketId: pos.marketId,
              collateralSymbol: pos.collateralSymbol ?? "",
            },
            gasParams: {
              nonce,
              maxFeePerGas: SIMPLE_PATH_MAX_FEE_PER_GAS,
              maxPriorityFeePerGas: SIMPLE_PATH_MAX_PRIORITY_FEE_PER_GAS,
            },
            writeArgs: {
              address: encoder.address,
              functionName: functionData.functionName,
            },
            submit: () =>
              writeContract(this.client, {
                address: encoder.address,
                ...functionData,
                gas: 700_000n,
                nonce,
                maxFeePerGas: SIMPLE_PATH_MAX_FEE_PER_GAS,
                maxPriorityFeePerGas: SIMPLE_PATH_MAX_PRIORITY_FEE_PER_GAS,
              }),
            createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
          });
        } catch (error) {
          this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
          this.markPositionUsed(marketId, pos.borrower);
          throw error;
        }
        this.shadowLogger?.recordAttempt({
          borrower: pos.borrower,
          marketId: pos.marketId,
          collateralSymbol: pos.collateralSymbol ?? "",
          loanSymbol: pos.loanSymbol ?? "",
          ourTxHash: txHash,
          ourTipWei: 0n,
          ourMaxFeePerGasWei: 0n,
          ourSentBlock: 0n,
          ourSentMs: Date.now(),
          expectedProfitUsd: 0,
        });
        this.markPositionUsed(marketId, pos.borrower);
        console.log(
          `${this.logTag}FAST LIQUIDATED ${pos.borrower} on ${marketId} (${pos.collateralSymbol}/${pos.loanSymbol})`,
        );
        return true;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Reverts are expected and cheap ($0.001) — only log briefly
      if (msg.includes("reverted") || msg.includes("revert")) {
        console.log(
          `${this.logTag}Fast revert ${pos.borrower} ${pos.collateralSymbol}/${pos.loanSymbol}: ${msg.slice(0, 500)}`,
        );
        discord
          .notifyRevert(`${pos.collateralSymbol}/${pos.loanSymbol}`, msg.slice(0, 100))
          .catch(() => {});
      } else {
        console.error(
          `${this.logTag}Fast liquidate failed for ${pos.borrower}:`,
          msg.slice(0, 120),
        );
      }
      return false;
    }
  }

  /** Cache for ERC20 decimals to avoid repeated RPC calls. */
  private decimalsCache: Record<string, number> = {};

  private async getDecimals(token: Address): Promise<number> {
    const key = token.toLowerCase();
    if (this.decimalsCache[key] !== undefined) return this.decimalsCache[key];
    if (key === this.wNative.toLowerCase()) {
      this.decimalsCache[key] = 18;
      return 18;
    }

    const decimals = await readContract(this.client, {
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    });
    this.decimalsCache[key] = decimals;
    return decimals;
  }

  private async liquidate(position: AccrualPosition) {
    const marketParams = position.market.params;
    const seizableCollateral = position.seizableCollateral ?? 0n;
    const badDebtPosition = seizableCollateral === position.collateral;

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    const { executorAddress } = this;
    const encoder = new LiquidationEncoder(executorAddress, this.client);
    const morpho = this.chainAddresses.morpho;
    const market = {
      loanToken: marketParams.loanToken,
      collateralToken: marketParams.collateralToken,
      oracle: marketParams.oracle,
      irm: marketParams.irm,
      lltv: BigInt(marketParams.lltv),
    };

    // Sprint 42a: use repaidShares path (NOT seizedAssets). The seizedAssets
    // path is deprecated because Morpho rounds shares vs assets differently
    // on the two paths and a naive seizedAssets call caused 25 reverts in
    // Session 39 forensics. Mirror fastLiquidate's flow:
    //   1) call resolveShareLiquidationPlan to compute the largest repaid-
    //      shares amount whose seized collateral fits within the target.
    //   2) build the collateral→loan conversion using the predicted seized.
    //   3) encode `morphoBlueLiquidate(... 0n /*seized*/, plan.repaidShares)`.
    const decreasedSeizable = this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition);

    // Read oracle price for share calculation.
    let oraclePrice: bigint;
    try {
      oraclePrice = await readContract(this.client, {
        address: marketParams.oracle,
        abi: [
          {
            name: "price",
            type: "function",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "uint256" }],
          },
        ] as const,
        functionName: "price",
      });
    } catch (err: unknown) {
      console.warn(
        `${this.logTag}liquidate: cannot read oracle price for ${MarketUtils.getMarketId(marketParams)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const liquidationPlan = resolveShareLiquidationPlan({
      borrowShares: position.borrowShares,
      collateral: position.collateral,
      totalBorrowAssets: position.market.totalBorrowAssets,
      totalBorrowShares: position.market.totalBorrowShares,
      price: oraclePrice,
      lltv: BigInt(marketParams.lltv),
      targetSeizedAssets: decreasedSeizable,
    });

    if (liquidationPlan === null) {
      console.warn(
        `${this.logTag}liquidate: no safe repaidShares plan for ${position.user} ${MarketUtils.getMarketId(marketParams)}`,
      );
      return;
    }

    // Step 1: Build collateral→loan conversion calls using predicted seized amount.
    if (
      !(await this.convertCollateralToLoan(marketParams, liquidationPlan.seizedAssets, encoder))
    ) {
      return;
    }
    const collateralToLoanCalls = encoder.flush();

    // Step 2: Flash loan repay amount based on predicted repaidAssets (not full
    // borrowAssets). Add 1% buffer for interest accrual between query and execution.
    const repayAmount = (liquidationPlan.repaidAssets * 101n) / 100n;

    // Step 3: Build flash loan liquidation using repaidShares (avoids underflow).
    // Inner: approve + liquidate (with collateral→loan callback).
    encoder.erc20Approve(marketParams.loanToken, morpho, 0n);
    encoder.erc20Approve(marketParams.loanToken, morpho, maxUint256);
    encoder.morphoBlueLiquidate(
      morpho,
      market,
      position.user,
      0n,
      liquidationPlan.repaidShares,
      collateralToLoanCalls,
    );

    // Self-funding tip for WETH loan markets (25% of estimated profit)
    const isWethLoan = marketParams.loanToken.toLowerCase() === this.wNative.toLowerCase();
    const useSelfFundingTip = this.flashbotAccount !== undefined && !badDebtPosition && isWethLoan;
    let selfFundingTipAmount: bigint | undefined;
    if (useSelfFundingTip) {
      // Estimate profit: liquidation incentive ≈ 1/LLTV - 1 ≈ 15% for 86% LLTV
      // Tip = 25% of estimated profit = repayAmount * ~15% * 25% ≈ repayAmount * 3.75%
      const tipBps = this.tipBps ?? 2500n; // 25% of profit
      const estimatedProfitWeth = (repayAmount * 1500n) / 10000n; // ~15% LIF margin
      const dynamicTip = (estimatedProfitWeth * tipBps) / 10000n;
      const MIN_TIP = parseUnits("0.001", 18);
      const MAX_TIP = parseUnits("0.1", 18);
      const tipAmount =
        dynamicTip < MIN_TIP ? MIN_TIP : dynamicTip > MAX_TIP ? MAX_TIP : dynamicTip;
      encoder.unwrapETH(this.wNative, tipAmount);
      encoder.tip(tipAmount);
      selfFundingTipAmount = tipAmount;
    }

    // Flush all callback calls for the flash loan
    const flashLoanCallbackCalls = encoder.flush();

    // Wrap in flash loan (zero capital needed)
    // USDT and other non-standard ERC20 tokens don't work with Morpho flash loan
    // (Morpho's safeTransferFrom callback fails with non-standard approve).
    // Use Balancer flash loan instead (also 0% fee, USDT compatible).
    const KNOWN_NON_STANDARD = new Set([
      "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    ]);
    const isNonStandard = KNOWN_NON_STANDARD.has(marketParams.loanToken.toLowerCase());

    if (isNonStandard) {
      const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address;
      // For Balancer: rebuild callback with vault approval included
      // flashLoanCallbackCalls already contains: approve(Morpho) + liquidate + tip
      // We need to add: approve(Balancer vault) for repayment
      // But we can't append to flushed calls — re-encode everything

      // The flashLoanCallbackCalls are the inner operations.
      // Balancer callback needs: inner ops + approve vault for pullback
      encoder.erc20Approve(marketParams.loanToken, BALANCER_VAULT, 0n);
      encoder.erc20Approve(marketParams.loanToken, BALANCER_VAULT, repayAmount);
      const vaultApprovals = encoder.flush();

      encoder.balancerFlashLoan(
        BALANCER_VAULT,
        [{ asset: marketParams.loanToken, amount: repayAmount }],
        [...flashLoanCallbackCalls, ...vaultApprovals],
      );
    } else {
      encoder.blueFlashLoan(morpho, marketParams.loanToken, repayAmount, flashLoanCallbackCalls);
    }

    // Skim remaining profit to treasury (after flash loan repayment)
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);
    const calls = encoder.flush();

    try {
      const success = await this.handleTx(
        encoder,
        calls,
        marketParams,
        position.user,
        badDebtPosition,
        useSelfFundingTip,
        undefined,
        selfFundingTipAmount,
      );

      if (success)
        console.log(
          `${this.logTag}Liquidated ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        );
      else
        console.log(
          `${this.logTag}ℹ️ Skipped ${position.user} on ${MarketUtils.getMarketId(marketParams)} (not profitable)`,
        );
    } catch (error) {
      console.error(
        `${this.logTag}Failed to liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        error,
      );
    }
  }

  private async preLiquidate(position: PreLiquidationPosition) {
    const marketParams = position.market.params;
    const seizableCollateral = this.decreaseSeizableCollateral(
      position.seizableCollateral ?? 0n,
      false,
    );

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);

    if (!(await this.convertCollateralToLoan(marketParams, seizableCollateral, encoder))) return;

    encoder.erc20Approve(marketParams.loanToken, position.preLiquidation, 0n);
    encoder.erc20Approve(marketParams.loanToken, position.preLiquidation, maxUint256);

    encoder.preLiquidate(
      position.preLiquidation,
      position.user,
      seizableCollateral,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const success = await this.handleTx(encoder, calls, marketParams, position.user, false);

      if (success)
        console.log(
          `${this.logTag}Pre-liquidated ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        );
      else
        console.log(
          `${this.logTag}ℹ️ Skipped ${position.user} on ${MarketUtils.getMarketId(marketParams)} (not profitable)`,
        );
    } catch (error) {
      console.error(
        `${this.logTag}Failed to pre-liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        error,
      );
    }
  }

  private async handleTx(
    encoder: LiquidationEncoder,
    calls: Hex[],
    marketParams: IMarketParams,
    borrower: Address,
    badDebtPosition: boolean,
    selfFundingTip = false,
    existingLease?: PrimaryWalletLease,
    /**
     * H2 fix: when `selfFundingTip` is true, the tip is encoded inside the bundle
     * (unwrapETH + tip ops). The bot-wallet `balanceOf(loanToken)` measured by
     * simulateCalls does NOT see this outflow because the executor contract holds
     * the tipped ETH temporarily and the unwrap reduces executor's WETH (not
     * wallet's). Pass the encoded tip amount in WEI so checkProfit can subtract
     * it from gross profit and reject negative-net liquidations.
     */
    selfFundingTipWei?: bigint,
  ) {
    // H7: defensive guard. The selfFundingTip path encodes the tip inside the
    // bundle (unwrapETH + tip ops), so checkProfit MUST subtract it explicitly.
    // If a caller sets selfFundingTip=true but forgets to pass the WEI amount,
    // we'd silently regress the H2 fix and accept negative-net liquidations.
    if (selfFundingTip && (selfFundingTipWei === undefined || selfFundingTipWei <= 0n)) {
      throw new Error(
        `handleTx: selfFundingTip=true requires selfFundingTipWei > 0n; got ${String(selfFundingTipWei)}. ` +
          `This would regress the H2 profit-accounting fix.`,
      );
    }

    const functionData = {
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [calls],
    } as const;

    const [{ results }, gasPrice] = await Promise.all([
      simulateCalls(this.client, {
        account: this.client.account.address,
        calls: [
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
          { to: encoder.address, ...functionData },
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
        ],
      }),
      this.getCachedGasPrice(),
    ]);

    if (results[1].status !== "success") {
      console.warn(`${this.logTag}Transaction failed in simulation: ${results[1].error}`);
      return;
    }

    if (
      !(await this.checkProfit(
        marketParams.loanToken,
        {
          beforeTx: results[0].result,
          afterTx: results[2].result,
        },
        {
          used: results[1].gasUsed,
          price: gasPrice,
        },
        badDebtPosition,
        // H2: pass the self-funding tip amount so checkProfit can subtract it.
        // Tip is encoded inside the bundle but the operator's loanToken balance
        // delta does not capture it (executor holds the tip path).
        selfFundingTip ? selfFundingTipWei : undefined,
      ))
    )
      return false;

    // TX EXECUTION

    const marketId = MarketUtils.getMarketId(marketParams);
    const lease = existingLease ?? this.primaryWalletCoordinator.tryAcquire(`handleTx:${marketId}`);
    if (lease === null) {
      console.log(`${this.logTag}handleTx: primary wallet busy — skipping ${marketId}`);
      return false;
    }
    const shouldReleaseLease = existingLease === undefined;

    try {
      if (this.flashbotAccount) {
        const loanProfit = (results[2].result ?? 0n) - (results[0].result ?? 0n);
        const estimatedGasCost = results[1].gasUsed * gasPrice;

        // Parallel: fetch block + balance + prices simultaneously
        const [block, walletBalance, loanPriceUsd, ethPriceUsd] = await Promise.all([
          getBlock(this.client),
          getBalance(this.client, { address: this.client.account.address }),
          this.pricers && loanProfit > 0n && marketParams.loanToken !== this.wNative
            ? this.price(marketParams.loanToken, loanProfit, this.pricers)
            : Promise.resolve(undefined),
          this.pricers ? this.price(this.wNative, WAD, this.pricers) : Promise.resolve(undefined),
        ]);
        const baseFee = block.baseFeePerGas ?? gasPrice;

        // Determine tip: self-funding (encoded in TX) vs wallet-funded
        let walletTip = 0n;

        if (!selfFundingTip) {
          let profitInEth = loanProfit;
          if (loanPriceUsd !== undefined && ethPriceUsd !== undefined && ethPriceUsd > 0) {
            profitInEth = BigInt(Math.floor((loanPriceUsd / ethPriceUsd) * 1e18));
          }

          const tipBps = this.tipBps ?? Flashbots.DEFAULT_TIP_BPS;
          walletTip = Flashbots.calculateCoinbaseTip(profitInEth, tipBps);
          walletTip = Flashbots.capTipToWalletBalance(walletTip, estimatedGasCost, walletBalance);

          // Net profitability check including tip
          if (this.pricers) {
            const [tipCostUsd, gasCostUsd, grossProfitUsd] = await Promise.all([
              this.price(this.wNative, walletTip, this.pricers),
              this.price(this.wNative, estimatedGasCost, this.pricers),
              this.price(marketParams.loanToken, loanProfit, this.pricers),
            ]);

            if (
              grossProfitUsd !== undefined &&
              tipCostUsd !== undefined &&
              gasCostUsd !== undefined
            ) {
              const netProfitUsd = grossProfitUsd - tipCostUsd - gasCostUsd;
              if (netProfitUsd <= 0) {
                console.log(`${this.logTag}ℹ️ Skipped: net $${netProfitUsd.toFixed(2)}`);
                return false;
              }
              console.log(`${this.logTag}💰 Net $${netProfitUsd.toFixed(2)}`);
            }
          }
        }

        // Sign the bundle once, send to ALL builders
        const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
        let signedBundle: Hex[];
        let blockNumber: bigint;
        try {
          ({ signedBundle, blockNumber } = await Flashbots.signAndPrepareBundle(
            { transaction: { to: encoder.address, ...functionData, nonce }, client: this.client },
            this.flashbotAccount,
            walletTip,
            baseFee,
          ));
        } catch (error) {
          this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
          this.markPositionUsed(marketId, borrower);
          throw error;
        }

        // Multi-builder submission: Flashbots + Titan + rsync + beaverbuild
        if (this.multiBuilder) {
          this.multiBuilder
            .sendBundleToConsecutiveBlocks(signedBundle, blockNumber + 1n, 3)
            .catch(() => {}); // fire-and-forget
        } else {
          // Fallback: single Flashbots relay
          for (let i = 1; i <= 3; i++) {
            Flashbots.sendRawBundle(
              signedBundle,
              blockNumber + BigInt(i),
              this.flashbotAccount,
            ).catch(() => {});
          }
        }

        this.markPositionUsed(marketId, borrower);
        return true;
      } else if (this.useL2PriorityBidding && this.pricers) {
        // L2 competitive bidding: fold tip into priority fee for sequencer priority
        const loanProfit = (results[2].result ?? 0n) - (results[0].result ?? 0n);
        if (loanProfit <= 0n) return false;

        const estimatedGasCost = results[1].gasUsed * gasPrice;

        const [block, walletBalance] = await Promise.all([
          getBlock(this.client),
          getBalance(this.client, { address: this.client.account.address }),
        ]);
        const baseFee = block.baseFeePerGas ?? gasPrice;

        // Convert loan profit to ETH for tip calculation
        let profitInEth = loanProfit;
        if (marketParams.loanToken.toLowerCase() !== this.wNative.toLowerCase()) {
          const [loanPriceUsd, ethPriceUsd] = await Promise.all([
            this.price(marketParams.loanToken, loanProfit, this.pricers),
            this.price(this.wNative, WAD, this.pricers),
          ]);
          if (loanPriceUsd !== undefined && ethPriceUsd !== undefined && ethPriceUsd > 0) {
            profitInEth = BigInt(Math.floor((loanPriceUsd / ethPriceUsd) * 1e18));
          }
        }

        // Calculate tip: 25% of profit (same as L1 Flashbots logic)
        const tipBps = this.tipBps ?? 2500n;
        let tip = (profitInEth * tipBps) / 10000n;

        // Cap tip to 80% of wallet balance minus gas cost
        const maxSpend = (walletBalance * 8000n) / 10000n;
        if (tip + estimatedGasCost > maxSpend) {
          tip = maxSpend > estimatedGasCost ? maxSpend - estimatedGasCost : 0n;
        }

        // Net profitability check including tip cost
        const [tipCostUsd, gasCostUsd, grossProfitUsd] = await Promise.all([
          this.price(this.wNative, tip, this.pricers),
          this.price(this.wNative, estimatedGasCost, this.pricers),
          this.price(marketParams.loanToken, loanProfit, this.pricers),
        ]);

        if (grossProfitUsd !== undefined && tipCostUsd !== undefined && gasCostUsd !== undefined) {
          const netProfitUsd = grossProfitUsd - tipCostUsd - gasCostUsd;
          if (netProfitUsd <= 0) {
            console.log(`${this.logTag}ℹ️ L2 bid skip: net $${netProfitUsd.toFixed(2)} after tip`);
            return false;
          }
          console.log(
            `${this.logTag}💰 L2 bid: net $${netProfitUsd.toFixed(2)}, tip ${formatEther(tip)} ETH`,
          );
        }

        // Fold tip into priority fee
        const gasEstimate = results[1].gasUsed > 0n ? results[1].gasUsed : 1n;
        const tipAsPriorityFee = tip > 0n ? tip / gasEstimate : 0n;
        const L2_BASE_PRIORITY = parseGwei("0.001");
        const effectivePriorityFee = tipAsPriorityFee + L2_BASE_PRIORITY;
        const maxFeePerGas = baseFee * 2n + effectivePriorityFee;

        const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
        let txHash: Hex;
        try {
          txHash = await submitOrShadow({
            path: "write-contract",
            triggerPath: "handleTx-l2bid",
            candidateRef: {
              borrower,
              marketId,
              collateralSymbol: "",
            },
            gasParams: {
              nonce,
              maxFeePerGas,
              maxPriorityFeePerGas: effectivePriorityFee,
            },
            writeArgs: {
              address: encoder.address,
              functionName: functionData.functionName,
            },
            submit: () =>
              writeContract(this.client, {
                address: encoder.address,
                ...functionData,
                gas: 700_000n,
                maxPriorityFeePerGas: effectivePriorityFee,
                maxFeePerGas,
                nonce,
              }),
            createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
          });
        } catch (error) {
          this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
          this.markPositionUsed(marketId, borrower);
          throw error;
        }

        this.shadowLogger?.recordAttempt({
          borrower,
          marketId,
          collateralSymbol: "",
          loanSymbol: "",
          ourTxHash: txHash,
          ourTipWei: effectivePriorityFee,
          ourMaxFeePerGasWei: gasPrice,
          ourSentBlock: 0n,
          ourSentMs: Date.now(),
          expectedProfitUsd:
            grossProfitUsd !== undefined && tipCostUsd !== undefined && gasCostUsd !== undefined
              ? grossProfitUsd - tipCostUsd - gasCostUsd
              : 0,
        });
        this.markPositionUsed(marketId, borrower);
        return true;
      } else {
        const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
        // Explicit gas-fee caps. viem's default `baseFee + 2.5 gwei` causes
        // "total cost exceeds balance" on low-balance wallets. Same caps as
        // auto-refuel.ts and fastLiquidate simple path.
        const SIMPLE_PATH_MAX_FEE_PER_GAS = 100_000_000n; // 0.1 gwei
        const SIMPLE_PATH_MAX_PRIORITY_FEE_PER_GAS = 10_000_000n; // 0.01 gwei
        let txHash: Hex;
        try {
          txHash = await submitOrShadow({
            path: "write-contract",
            triggerPath: "handleTx-simple",
            candidateRef: {
              borrower,
              marketId,
              collateralSymbol: "",
            },
            gasParams: {
              nonce,
              maxFeePerGas: SIMPLE_PATH_MAX_FEE_PER_GAS,
              maxPriorityFeePerGas: SIMPLE_PATH_MAX_PRIORITY_FEE_PER_GAS,
            },
            writeArgs: {
              address: encoder.address,
              functionName: functionData.functionName,
            },
            submit: () =>
              writeContract(this.client, {
                address: encoder.address,
                ...functionData,
                gas: 700_000n,
                nonce,
                maxFeePerGas: SIMPLE_PATH_MAX_FEE_PER_GAS,
                maxPriorityFeePerGas: SIMPLE_PATH_MAX_PRIORITY_FEE_PER_GAS,
              }),
            createSyntheticResult: (syntheticTxHash) => syntheticTxHash,
          });
        } catch (error) {
          this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
          this.markPositionUsed(marketId, borrower);
          throw error;
        }
        this.shadowLogger?.recordAttempt({
          borrower,
          marketId,
          collateralSymbol: "",
          loanSymbol: "",
          ourTxHash: txHash,
          ourTipWei: 0n,
          ourMaxFeePerGasWei: gasPrice,
          ourSentBlock: 0n,
          ourSentMs: Date.now(),
          expectedProfitUsd: 0,
        });
        this.markPositionUsed(marketId, borrower);
      }
    } finally {
      if (shouldReleaseLease) this.primaryWalletCoordinator.release(lease);
    }

    return true;
  }

  private async convertCollateralToLoan(
    marketParams: IMarketParams,
    seizableCollateral: bigint,
    encoder: LiquidationEncoder,
  ) {
    let toConvert = {
      src: getAddress(marketParams.collateralToken),
      dst: getAddress(marketParams.loanToken),
      srcAmount: seizableCollateral,
    };

    for (const venue of this.liquidityVenues) {
      try {
        if (await venue.supportsRoute(encoder, toConvert.src, toConvert.dst))
          toConvert = await venue.convert(encoder, toConvert);
      } catch (error) {
        console.error(`${this.logTag}Error converting ${toConvert.src} to ${toConvert.dst}`, error);
        continue;
      }

      if (toConvert.src === toConvert.dst) return true;
    }

    return false;
  }

  private async price(asset: Address, amount: bigint, pricers: Pricer[]) {
    let price: number | undefined = undefined;

    for (const pricer of pricers) {
      price = await pricer.price(this.client, asset);
      if (price !== undefined) break;
    }

    if (price === undefined) return undefined;

    const decimals = await this.getDecimals(asset);
    return parseFloat(formatUnits(amount, decimals)) * price;
  }

  private async getEthUsdPriceScaled() {
    try {
      const ethUsd = this.pricers ? await this.price(this.wNative, WAD, this.pricers) : undefined;
      if (ethUsd !== undefined && Number.isFinite(ethUsd) && ethUsd > 0) {
        return BigInt(Math.round(ethUsd * Number(USD_SCALE)));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `${this.logTag}ETH/USD pricing failed, using fallback ${ETH_USD_FALLBACK}: ${msg}`,
      );
      return ETH_USD_FALLBACK * USD_SCALE;
    }

    console.warn(`${this.logTag}ETH/USD pricer unavailable, using fallback ${ETH_USD_FALLBACK}`);
    return ETH_USD_FALLBACK * USD_SCALE;
  }

  async usdValueFromEthAmount(amountWei: bigint) {
    const ethUsdScaled = await this.getEthUsdPriceScaled();
    const usdScaled = (amountWei * ethUsdScaled) / WAD;
    return Number(usdScaled) / Number(USD_SCALE);
  }

  /**
   * Fetch gas price with short-lived cache + single-flight deduplication.
   * Called per-position during liquidate()/preLiquidate(); on a 147-position
   * Promise.all tick this collapses to a single eth_gasPrice RPC call (plus
   * one refresh every ~5s). Eliminates the rate-limit cascade observed on
   * Arbitrum public RPC (42-fanout HttpRequestError loop, OCI Apr 17).
   */
  private async getCachedGasPrice(): Promise<bigint> {
    const now = Date.now();
    const cached = this.cachedGasPrice;
    if (cached !== null && now - cached.fetchedAt < LiquidationBot.GAS_PRICE_CACHE_TTL_MS) {
      return cached.value;
    }
    // In-flight dedup: if a peer is already fetching, await its promise.
    if (this.gasPriceInFlight !== null) {
      return this.gasPriceInFlight;
    }
    this.gasPriceInFlight = getGasPrice(this.client)
      .then((value) => {
        this.cachedGasPrice = { value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => {
        this.gasPriceInFlight = null;
      });
    return this.gasPriceInFlight;
  }

  private markPositionUsed(marketId: Hex, account: Address) {
    this.positionLiquidationCooldownMechanism?.markPositionUsed(marketId, account);
  }

  private isPositionHardSkipped(marketId: Hex, account: Address): boolean {
    const key = `${marketId.toLowerCase()}:${account.toLowerCase()}`;
    const count = this.positionOnChainRevertCount.get(key) ?? 0;
    return count >= LiquidationBot.REVERT_HARD_STOP_THRESHOLD;
  }

  private recordPositionOnChainRevert(marketId: Hex, account: Address): void {
    const key = `${marketId.toLowerCase()}:${account.toLowerCase()}`;
    const count = (this.positionOnChainRevertCount.get(key) ?? 0) + 1;
    this.positionOnChainRevertCount.set(key, count);
    if (count === LiquidationBot.REVERT_HARD_STOP_THRESHOLD) {
      console.log(
        `${this.logTag}HARD-SKIP: ${count} on-chain reverts for ${account} ${marketId} — suppressing for rest of process`,
      );
    }
  }

  private async checkProfit(
    loanAsset: Address,
    loanAssetBalance: {
      beforeTx: bigint | undefined;
      afterTx: bigint | undefined;
    },
    gas: {
      used: bigint;
      price: bigint;
    },
    badDebtPosition: boolean,
    /**
     * H2 fix: tip amount in WEI when the tip is encoded inside the bundle
     * (self-funding-tip path). Subtracted from gross profit so we reject
     * sub-tip-floor liquidations whose net is negative.
     */
    selfFundingTipWei?: bigint,
  ) {
    if (this.pricers === undefined || this.pricers.length === 0) return true;

    // Bad debt: only realize if profit covers gas, preventing dust waste.
    // Without this, ALWAYS_REALIZE_BAD_DEBT=true would burn gas on $0.001 positions.
    if (this.alwaysRealizeBadDebt && badDebtPosition) {
      if (loanAssetBalance.beforeTx === undefined || loanAssetBalance.afterTx === undefined)
        return false;

      const profit = loanAssetBalance.afterTx - loanAssetBalance.beforeTx;
      if (profit <= 0n) return false; // zero recovery — don't burn gas

      const [profitUsd, gasCostUsd, tipUsd] = await Promise.all([
        this.price(loanAsset, profit, this.pricers),
        this.price(this.wNative, gas.used * gas.price, this.pricers),
        selfFundingTipWei !== undefined && selfFundingTipWei > 0n
          ? this.price(this.wNative, selfFundingTipWei, this.pricers)
          : Promise.resolve(0),
      ]);

      // Only realize bad debt if profit exceeds gas + tip cost
      if (profitUsd !== undefined && gasCostUsd !== undefined && tipUsd !== undefined) {
        return profitUsd > gasCostUsd + tipUsd;
      }
      // If we can't price, skip to be safe (don't waste gas on unknown)
      return false;
    }

    if (loanAssetBalance.beforeTx === undefined || loanAssetBalance.afterTx === undefined)
      return false;

    const loanAssetProfit = loanAssetBalance.afterTx - loanAssetBalance.beforeTx;

    if (loanAssetProfit <= 0n) return false;

    const [loanAssetProfitUsd, gasUsedUsd, tipUsd] = await Promise.all([
      this.price(loanAsset, loanAssetProfit, this.pricers),
      this.price(this.wNative, gas.used * gas.price, this.pricers),
      selfFundingTipWei !== undefined && selfFundingTipWei > 0n
        ? this.price(this.wNative, selfFundingTipWei, this.pricers)
        : Promise.resolve(0),
    ]);

    if (loanAssetProfitUsd === undefined || gasUsedUsd === undefined || tipUsd === undefined)
      return false;

    const profitUsd = loanAssetProfitUsd - gasUsedUsd - tipUsd;

    return profitUsd > 0;
  }

  private decreaseSeizableCollateral(seizableCollateral: bigint, _badDebtPosition: boolean) {
    // Always apply buffer (bad-debt bypass removed).
    // Morpho mulDivUp overflows when seizedAssets ~ total collateral on high-LLTV markets.
    const liquidationBufferBps =
      chainConfigs[this.chainId]?.options.liquidationBufferBps ?? DEFAULT_LIQUIDATION_BUFFER_BPS;

    return wMulDown(seizableCollateral, WAD - parseUnits(liquidationBufferBps.toString(), 14));
  }

  private async capFastPathSeizableCollateral(
    pos: CachedPosition,
    seizableCollateral: bigint,
  ): Promise<bigint> {
    if (pos.collateralSymbol !== "cbXRP") return seizableCollateral;

    const cbXrpPoolAware = chainConfigs[this.chainId]?.options.cbXrpPoolAware;
    if (
      cbXrpPoolAware === undefined ||
      cbXrpPoolAware.marketId.toLowerCase() !== pos.marketId.toLowerCase()
    ) {
      // Not the pool-aware market or config absent — use static 5% cap as safe fallback.
      return (seizableCollateral * CBXRP_FAST_PATH_SEIZE_BPS) / BPS;
    }

    try {
      const snapshotCache = new Map<string, UniswapV3PoolSnapshot>();
      const directDepth = await estimateUniswapV3MaxSwapIn({
        client: this.client,
        pool: cbXrpPoolAware.direct.pool,
        tokenIn: pos.collateralToken,
        slippageBudgetBps: cbXrpPoolAware.slippageBudgetBps,
        snapshotCache,
      });
      const fallbackDepth = await estimateUniswapV3MaxSwapIn({
        client: this.client,
        pool: cbXrpPoolAware.fallback.cbXrpToWeth.pool,
        tokenIn: pos.collateralToken,
        slippageBudgetBps: cbXrpPoolAware.slippageBudgetBps,
        snapshotCache,
      });
      const poolCap = maxSafeSeize({
        directPoolMaxIn: directDepth.maxSwapIn,
        fallbackLeg1MaxIn: fallbackDepth.maxSwapIn,
        requestedSeize: seizableCollateral,
        config: cbXrpPoolAware,
      });
      // If both pools are fully depth-exhausted, fall back to static 5% cap — never skip the cap.
      return poolCap > 0n ? poolCap : (seizableCollateral * CBXRP_FAST_PATH_SEIZE_BPS) / BPS;
    } catch {
      console.warn(
        `${this.logTag}Fast liquidate: pool depth estimate error for cbXRP — using static 5% cap`,
      );
      return (seizableCollateral * CBXRP_FAST_PATH_SEIZE_BPS) / BPS;
    }
  }

  private checkCooldown(marketId: Hex, account: Address) {
    if (
      this.positionLiquidationCooldownMechanism !== undefined &&
      !this.positionLiquidationCooldownMechanism.isPositionReady(marketId, account)
    ) {
      return false;
    }
    return true;
  }

  private async fetchMarkets() {
    if (!this.marketsFetchingCooldownMechanism.isFetchingReady()) return;

    if (this.vaultWhitelist === "morpho-api")
      this.vaultWhitelist = await fetchWhitelistedVaults(this.chainId);

    const vaultWhitelist = this.vaultWhitelist;
    console.log(`${this.logTag}📝 Watching markets in the following vaults:`, vaultWhitelist);

    const whitelistedMarketsFromVaults = await this.dataProvider.fetchMarkets(
      this.client,
      vaultWhitelist,
    );

    const mergedMarkets = [
      ...new Set([...whitelistedMarketsFromVaults, ...this.additionalMarketsWhitelist]),
    ];
    if (this.chainId === 8453 && this.additionalMarketsWhitelist.length > 0) {
      const allowedMarketIds = new Set(
        this.additionalMarketsWhitelist.map((marketId) => marketId.toLowerCase()),
      );
      const filteredMarkets = mergedMarkets.filter((marketId) =>
        allowedMarketIds.has(marketId.toLowerCase()),
      );
      const droppedMarkets = mergedMarkets.filter(
        (marketId) => !allowedMarketIds.has(marketId.toLowerCase()),
      );
      if (droppedMarkets.length > 0) {
        console.log(
          `${this.logTag}Base allowlist: filtered ${droppedMarkets.length} non-primary markets from vault queues`,
        );
      }
      this.coveredMarkets = filteredMarkets;
    } else {
      this.coveredMarkets = mergedMarkets;
    }
    this.marketsFetchingCooldownMechanism.markFetchingDone();
  }

  /**
   * Out-of-band canary receipt verifier. Called fire-and-forget after a
   * successful writeContract broadcast. Waits up to 30s for receipt, then
   * records the final outcome (pass/revert with real gas cost).
   *
   * Broadcast itself is logged as "attempt" (no counter change). Only this
   * function records "pass" or "revert" with counter impact, so there is no
   * double-counting.
   */
  private async verifyCanaryReceipt(
    txHash: Hex,
    ctx: {
      borrower: Address;
      marketId: Hex;
      collateralSymbol: string;
      loanSymbol: string;
      expectedBorrowUsd: number;
      lltvWad: bigint;
      priorityFeeGwei: number;
    },
  ): Promise<void> {
    if (!this.canary) return;

    // Poll up to 30s for receipt.
    const deadline = Date.now() + 30_000;
    let receipt: Awaited<ReturnType<typeof getTransactionReceipt>> | null = null;
    while (Date.now() < deadline) {
      try {
        receipt = await getTransactionReceipt(this.client, { hash: txHash });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const nowMs = Date.now();
    const eventDate = new Date(nowMs).toISOString().slice(0, 10);

    if (!receipt) {
      // Tx dropped or not mined. No on-chain gas cost.
      this.canary.recordResult({
        timestamp: nowMs,
        eventDate,
        type: "dropped",
        borrower: ctx.borrower,
        marketId: ctx.marketId,
        collateralSymbol: ctx.collateralSymbol,
        loanSymbol: ctx.loanSymbol,
        expectedBorrowUsd: ctx.expectedBorrowUsd,
        lltvWad: ctx.lltvWad,
        estimatedProfitUsd: 0,
        gasCostUsd: 0,
        actualProfitUsd: 0,
        txHash,
        priorityFeeGwei: ctx.priorityFeeGwei,
        errorMessage: "receipt_timeout_30s_no_receipt",
      });
      return;
    }

    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
    const gasCostWei = gasUsed * effectiveGasPrice;
    const gasCostUsd = await this.usdValueFromEthAmount(gasCostWei);

    const isSuccess = receipt.status === "success";
    if (!isSuccess) {
      this.recordPositionOnChainRevert(ctx.marketId, ctx.borrower);
    }
    this.canary.recordResult({
      timestamp: nowMs,
      eventDate,
      type: isSuccess ? "pass" : "revert",
      borrower: ctx.borrower,
      marketId: ctx.marketId,
      collateralSymbol: ctx.collateralSymbol,
      loanSymbol: ctx.loanSymbol,
      expectedBorrowUsd: ctx.expectedBorrowUsd,
      lltvWad: ctx.lltvWad,
      estimatedProfitUsd: 0,
      gasCostUsd,
      actualProfitUsd: isSuccess ? ctx.expectedBorrowUsd - gasCostUsd : -gasCostUsd,
      txHash,
      effectiveGasPriceGwei: Number(effectiveGasPrice) / 1e9,
      priorityFeeGwei: ctx.priorityFeeGwei,
      gasUsed: gasUsed.toString(),
    });
  }
}
