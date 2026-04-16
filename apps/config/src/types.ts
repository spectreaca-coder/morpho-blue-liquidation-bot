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
  | "uniswapV4"
  | "baseswapV2";

export type PricerName = "chainlink" | "defillama" | "morphoApi" | "uniswapV3";

export type DataProviderName = "morphoApi" | "hyperIndex" | "aaveV3";

export interface Config {
  chain: Chain;
  wNative: Address;
  options: Options;
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
