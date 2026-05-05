/**
 * Auto-Refuel — automatically converts USDC profits to ETH for gas when balance is low.
 *
 * Checks each wallet's ETH balance periodically. If below threshold, swaps
 * a small amount of USDC → WETH via UniswapV3, then unwraps to ETH.
 *
 * This ensures the bot runs indefinitely without manual gas top-ups.
 */

import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
} from "viem";

import { discord } from "./discord-notifier";
import {
  type PrimaryWalletCoordinator,
  type PrimaryWalletLease,
} from "./primary-wallet-coordinator";
import { isShadowOnly, makeSyntheticTxHash } from "./utils/shadow-runtime.js";

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const DEFAULT_MAX_USDC_SPEND = 70_000_000n; // 70 USDC (6 decimals)

// UniswapV3 router on Base
const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);

const swapRouterAbi = parseAbi([
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);

const wethAbi = parseAbi(["function withdraw(uint256)"]);

export interface AutoRefuelConfig {
  logTag: string;
  /** Minimum ETH balance before refuel triggers (in wei). Default: 0.0003 ETH (~$0.66) */
  minEthWei?: bigint;
  /** Amount of ETH to refuel to (in wei). Default: 0.001 ETH (~$2.20) */
  refuelAmountWei?: bigint;
  /** Check interval in milliseconds. Default: 30 minutes */
  intervalMs?: number;
  /** RPC URL for Base */
  rpcUrl: string;
  /** Maximum USDC allowed for one refuel swap (6 decimals). Default: 70 USDC */
  maxUsdcSpend?: bigint;
  /** Coordinator required for wallet[0] refuel transactions. */
  primaryWalletCoordinator?: PrimaryWalletCoordinator;
}

interface WalletInfo {
  client: WalletClient<Transport, Chain, Account>;
  address: Address;
  index: number;
}

export class AutoRefuel {
  private readonly logTag: string;
  private readonly minEth: bigint;
  private readonly refuelAmount: bigint;
  private readonly intervalMs: number;
  private readonly rpcUrl: string;
  private readonly maxUsdcSpend: bigint;
  private readonly primaryWalletCoordinator?: PrimaryWalletCoordinator;
  private wallets: WalletInfo[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly shadowSkipWarnedWallets = new Set<Address>();
  private readonly lastUsdcZeroAlertMs = new Map<Address, number>();
  private static readonly USDC_ZERO_ALERT_COOLDOWN_MS = 24 * 60 * 60_000;

  constructor(config: AutoRefuelConfig) {
    this.logTag = config.logTag;
    this.minEth = config.minEthWei ?? 300_000_000_000_000n; // 0.0003 ETH
    this.refuelAmount = config.refuelAmountWei ?? 1_000_000_000_000_000n; // 0.001 ETH
    this.intervalMs = config.intervalMs ?? 30 * 60_000;
    this.rpcUrl = config.rpcUrl;
    this.maxUsdcSpend = config.maxUsdcSpend ?? DEFAULT_MAX_USDC_SPEND;
    this.primaryWalletCoordinator = config.primaryWalletCoordinator;
  }

  addWallet(walletClient: WalletClient<Transport, Chain, Account>, index: number): void {
    this.wallets.push({
      client: walletClient,
      address: walletClient.account.address,
      index,
    });
  }

  start(): void {
    if (this.wallets.length === 0) return;
    // First check after 5 minutes (let bot settle first)
    setTimeout(() => {
      void this.checkAll();
    }, 5 * 60_000);
    this.interval = setInterval(() => {
      void this.checkAll();
    }, this.intervalMs);
    console.log(
      `${this.logTag}AutoRefuel: monitoring ${this.wallets.length} wallets ` +
        `(min=${formatUnits(this.minEth, 18)} ETH, refuel=${formatUnits(this.refuelAmount, 18)} ETH, ` +
        `maxUsdcSpend=${formatUnits(this.maxUsdcSpend, 6)} USDC, interval=${this.intervalMs / 60_000}min)`,
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async checkAll(): Promise<void> {
    const client = createPublicClient({
      chain: this.wallets[0]!.client.chain,
      transport: http(this.rpcUrl),
    });

    for (const wallet of this.wallets) {
      try {
        const ethBal = await client.getBalance({ address: wallet.address });

        if (ethBal < this.minEth) {
          // Check USDC balance
          const usdcBal = await client.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet.address],
          });

          if (usdcBal === 0n) {
            const now = Date.now();
            const lastAlert = this.lastUsdcZeroAlertMs.get(wallet.address);
            if (
              lastAlert === undefined ||
              now - lastAlert >= AutoRefuel.USDC_ZERO_ALERT_COOLDOWN_MS
            ) {
              console.warn(
                `${this.logTag}AutoRefuel: USDC=0 — cannot refuel low-ETH wallet ${wallet.address}. ETH balance ${formatUnits(ethBal, 18)}. MANUAL FUNDING REQUIRED.`,
              );
              discord
                .notifyError(
                  "AutoRefuel critical",
                  `USDC=0, wallet ${wallet.address} ETH=${formatUnits(ethBal, 18)}`,
                )
                .catch(() => {});
              this.lastUsdcZeroAlertMs.set(wallet.address, now);
            } else {
              const remainingHours = Math.ceil(
                (AutoRefuel.USDC_ZERO_ALERT_COOLDOWN_MS - (now - lastAlert)) / 3_600_000,
              );
              console.log(
                `${this.logTag}AutoRefuel: USDC=0 (suppressed alert, next in ${remainingHours}h) wallet ${wallet.address}`,
              );
            }
            continue;
          }

          console.log(
            `${this.logTag}AutoRefuel: wallet[${wallet.index}] ETH=${formatUnits(ethBal, 18)} ` +
              `< ${formatUnits(this.minEth, 18)} — refueling from USDC...`,
          );

          await this.refuel(wallet);
        }
      } catch (err) {
        console.error(
          `${this.logTag}AutoRefuel: wallet[${wallet.index}] error:`,
          err instanceof Error ? err.message.slice(0, 100) : err,
        );
      }
    }
  }

  private async refuel(wallet: WalletInfo): Promise<void> {
    const walletClient = wallet.client;
    const client = createPublicClient({ chain: walletClient.chain, transport: http(this.rpcUrl) });
    let lease: PrimaryWalletLease | null = null;

    if (wallet.index === 0) {
      if (this.primaryWalletCoordinator === undefined) {
        console.log(
          `${this.logTag}AutoRefuel: wallet[0] skipped — primary coordinator not configured`,
        );
        return;
      }
      lease = this.primaryWalletCoordinator.tryAcquire("auto-refuel");
      if (lease === null) {
        console.log(`${this.logTag}AutoRefuel: wallet[0] skipped — primary wallet busy`);
        return;
      }
    }

    try {
      // Re-read USDC balance to compute the actual spend for this refuel.
      const usdcBal = await client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      });
      const actualSpend = usdcBal < this.maxUsdcSpend ? usdcBal : this.maxUsdcSpend;

      // Step 1: Approve USDC for SwapRouter.
      const approveTx = await this.writeContract(walletClient, lease, {
        address: USDC,
        abi: erc20Abi,
        functionName: "approve",
        args: [SWAP_ROUTER, actualSpend],
      });
      await client.waitForTransactionReceipt({ timeout: 60_000, hash: approveTx });

      // Step 2: Swap USDC → WETH.
      // Partial refuel (actualSpend < maxUsdcSpend): use exactInputSingle — spend all available USDC.
      // Full refuel (actualSpend >= maxUsdcSpend): use exactOutputSingle — get exactly refuelAmount WETH.
      try {
        let swapTx: Hex;
        if (actualSpend < this.maxUsdcSpend) {
          const ETH_PRICE_USD_CONSERVATIVE = 3500n;
          const SLIPPAGE_NUM = 9n;
          const SLIPPAGE_DEN = 10n;
          // USDC (6-dec) → WETH (18-dec) scale = 1e12 (NOT 1e13).
          // Formula: WETH_wei = USDC_wei * 1e12 / price_usd, then × 0.9 slippage.
          const USDC_TO_WETH_SCALE = 1_000_000_000_000n;
          const amountOutMinimum =
            (actualSpend * USDC_TO_WETH_SCALE * SLIPPAGE_NUM) /
            (ETH_PRICE_USD_CONSERVATIVE * SLIPPAGE_DEN);
          swapTx = await this.writeContract(walletClient, lease, {
            address: SWAP_ROUTER,
            abi: swapRouterAbi,
            functionName: "exactInputSingle",
            args: [
              {
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500, // 0.05% fee tier (most liquid USDC/WETH pool on Base)
                recipient: wallet.address,
                amountIn: actualSpend,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
        } else {
          swapTx = await this.writeContract(walletClient, lease, {
            address: SWAP_ROUTER,
            abi: swapRouterAbi,
            functionName: "exactOutputSingle",
            args: [
              {
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500, // 0.05% fee tier (most liquid USDC/WETH pool on Base)
                recipient: wallet.address,
                amountOut: this.refuelAmount,
                amountInMaximum: actualSpend,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
        }
        await client.waitForTransactionReceipt({ timeout: 60_000, hash: swapTx });
        console.log(`${this.logTag}AutoRefuel: wallet[${wallet.index}] swapped USDC → WETH ✅`);
      } catch (err) {
        console.error(
          `${this.logTag}AutoRefuel: swap failed:`,
          err instanceof Error ? err.message.slice(0, 100) : err,
        );
        return;
      }

      // Step 3: Unwrap WETH → ETH
      const wethBal = await client.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      });
      if (wethBal > 0n) {
        const unwrapTx = await this.writeContract(walletClient, lease, {
          address: WETH,
          abi: wethAbi,
          functionName: "withdraw",
          args: [wethBal],
        });
        await client.waitForTransactionReceipt({ timeout: 60_000, hash: unwrapTx });
      }

      const newEth = await client.getBalance({ address: wallet.address });
      console.log(
        `${this.logTag}AutoRefuel: wallet[${wallet.index}] refueled → ${formatUnits(newEth, 18)} ETH ✅`,
      );
      discord
        .notifyRefuel(wallet.index, formatUnits(newEth, 18).slice(0, 8))
        .catch((e: unknown) => {
          console.error("[notify]", e instanceof Error ? e.message : e);
        });
    } finally {
      if (lease !== null) this.primaryWalletCoordinator?.release(lease);
    }
  }

  private async writeContract(
    walletClient: WalletClient<Transport, Chain, Account>,
    lease: PrimaryWalletLease | null,
    args: Parameters<WalletClient<Transport, Chain, Account>["writeContract"]>[0],
  ): Promise<Hex> {
    if (isShadowOnly()) {
      const address = walletClient.account.address;
      if (!this.shadowSkipWarnedWallets.has(address)) {
        this.shadowSkipWarnedWallets.add(address);
        console.warn(
          `${this.logTag}AutoRefuel: shadow-only mode active; skipping on-chain refuel writes for ${address}`,
        );
      }
      return makeSyntheticTxHash(
        JSON.stringify({
          address,
          functionName: args.functionName,
          leaseOwner: lease?.owner ?? null,
          ts: Date.now(),
        }),
      );
    }

    // Explicit gas price to avoid viem's EIP-1559 default (baseFee + 2.5 gwei priority)
    // which inflates cost estimate and triggers "total cost exceeds balance" on low-ETH wallets.
    // Base mainnet baseFee ~0.005 gwei; 0.1 gwei cap is 20x headroom and costs <0.00003 ETH/TX.
    const gasOverrides = {
      maxFeePerGas: 100_000_000n, // 0.1 gwei
      maxPriorityFeePerGas: 10_000_000n, // 0.01 gwei
    };
    if (lease === null)
      return walletClient.writeContract({ ...args, ...gasOverrides } as Parameters<
        WalletClient<Transport, Chain, Account>["writeContract"]
      >[0]);
    if (this.primaryWalletCoordinator === undefined)
      throw new Error("Primary coordinator is required for wallet[0]");

    const nonce = await this.primaryWalletCoordinator.nextNonce(lease);
    try {
      return await walletClient.writeContract({ ...args, ...gasOverrides, nonce } as Parameters<
        WalletClient<Transport, Chain, Account>["writeContract"]
      >[0]);
    } catch (error) {
      this.primaryWalletCoordinator.rollbackNonce(lease, nonce);
      throw error;
    }
  }
}
