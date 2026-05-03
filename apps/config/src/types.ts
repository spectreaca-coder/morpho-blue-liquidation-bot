import type { Address, Chain, Hex } from "viem";

export type LiquidityVenueName =
  | "1inch"
  | "aerodromeV3"
  | "erc20Wrapper"
  | "erc4626"
  | "liquidSwap"
  | "midas"
  | "pendlePT"
  | "uniswapV3"
  | "uniswapV4";

export type PricerName = "chainlink" | "defillama" | "morphoApi" | "uniswapV3";

export type DataProviderName = "morphoApi" | "hyperIndex" | "aaveV3";

export interface Config {
  chain: Chain;
  wNative: Address;
  options: Options;
}

export interface PendingPrewarmFeedConfig {
  feedName: string;
  marketIds: Hex[];
}

export type PendingPrewarmFeedMap = Record<string, PendingPrewarmFeedConfig>;

export interface UniV3FixedPoolConfig {
  pool: Address;
  fee: number;
}

export interface CbXrpPoolAwareConfig {
  marketId: Hex;
  slippageBudgetBps: number;
  router: Address;
  direct: UniV3FixedPoolConfig;
  fallback: {
    cbXrpToWeth: UniV3FixedPoolConfig;
    wethToUsdc: UniV3FixedPoolConfig;
  };
}

export interface Options {
  dataProvider: DataProviderName;
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  liquidityVenues: LiquidityVenueName[];
  pricers?: PricerName[];
  treasuryAddress?: Address;
  liquidationBufferBps?: number;
  useFlashbots: boolean;
  useL2PriorityBidding?: boolean;
  useFastPath?: boolean;
  blockInterval?: number;
  watchBlocksRetryDelayMs?: number;
  /**
   * Per-wallet market affinity patterns for multi-wallet mode.
   * Index N corresponds to the Nth additional wallet
   * (LIQUIDATION_PRIVATE_KEY_{chainId}_N / EXECUTOR_ADDRESS_{chainId}_N).
   * Wallet 0 (primary) uses index 0 of this array.
   * If omitted, wallets are assigned in round-robin overflow order.
   */
  walletAffinities?: string[][];
  /**
   * Enable the UniswapV3 swap profitability gate in TxCache.
   * When true, a quoteExactInputSingle call is made before finalising calldata.
   * If the expected swap output cannot cover flash-loan repayment + buffer, the
   * build is skipped (returns null) to avoid guaranteed-revert transactions.
   * Defaults to true.
   */
  quoteGateEnabled?: boolean;
  /** Enable the narrow post-gate multi-venue quote race after a UniV3 gate failure. */
  quoteRaceEnabled?: boolean;
  /**
   * Buffer applied on top of repaidAssets when evaluating gate profitability.
   * Expressed in basis points (100 = 1%).  Defaults to 100 (1%).
   */
  quoteGateBufferBps?: number;
  cbXrpPoolAware?: CbXrpPoolAwareConfig;
  pendingPrewarmFeeds?: PendingPrewarmFeedMap;
}

export type ChainConfig = Omit<Config, "options"> &
  Options & {
    chainId: number;
    rpcUrl: string;
    fallbackRpcUrl?: string;
    wsUrl?: string;
    executorAddress: Address;
    liquidationPrivateKey: Hex;
  };
