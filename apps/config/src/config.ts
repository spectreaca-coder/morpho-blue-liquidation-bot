import { arbitrum, base, katana, mainnet, unichain, worldchain } from "viem/chains";

import { hyperevm, monad } from "./chains";
import type { Config } from "./types";

/// Bad debt realization

export const ALWAYS_REALIZE_BAD_DEBT = true; // Realize bad debt for 2.6% LIF revenue

/// Cooldown mechanisms

export const MARKETS_FETCHING_COOLDOWN_PERIOD = 60 * 60 * 24; // 24 hours (1 day)
export const POSITION_LIQUIDATION_COOLDOWN_ENABLED = true; // true if you want to enable the cooldown mechanism
export const POSITION_LIQUIDATION_COOLDOWN_PERIOD = 60 * 60; // 1 hour

/// Chains configurations

export const chainConfigs: Record<number, Config> = {
  [mainnet.id]: {
    chain: mainnet,
    wNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [
        "0xb7843fe78e7e7fd3106a1b939645367967d1f986c2e45edb8932ad1896450877", // XAUt/USDT $18K/mo
        "0xeea9a2431eba24c43ab7fae3d3e3012af8fca6b1e374b85ec44c0beb72ef8892", // PAXG/PYUSD $11K/mo
        "0xa921ef34e2fc7a27ccc50ae7e4b154e16c9799d3387076c421423ef52ac4df99", // WBTC/USDT $54M
        "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49", // WBTC/USDC $82M
        "0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64", // cbBTC/USDC $326M
        "0x45671fb8d5dea1c4fbca0b8548ad742f6643300eeb8dbd34ad64a658b2b05bca", // cbBTC/USDT $8.7M
        "0xe7e9694b754c4d4f7e21faf7223f6fa71abaeb10296a4c43a54a7977149687d2", // wstETH/USDT $148M
        "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc", // wstETH/USDC $49M
        "0x7421c2741e064e8c53fcb5de9faf7f0025dce75bc1caf26774dd878291c81dac", // wstETH/EURC $1.5M
        "0xff527fe9c6516f9d82a3d51422ccb031d123266e6e26d4c22c942a948c180a75", // WBTC/EURC $6.9M
        "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9", // PAXG/USDC $293M
        "0x138eec0e4a1937eb92ebc70043ed539661dd7ed5a89fb92a720b341650288a40", // WBTC/WETH $1.6M
      ],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "1inch", "pendlePT", "midas"],
      pricers: ["defillama", "chainlink", "uniswapV3"],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: true,
      useFastPath: true,
      blockInterval: 25, // ~5min fallback (CEX Predictor is main path)
    },
  },
  [base.id]: {
    chain: base,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [
        "0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109", // cbXRP/USDC $138K/7d
        "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda", // WETH/USDC $66K/7d
        "0xd7520ad198b497b6eb75bc690268f4597630dbc12e305e9d4105843bab36e41d", // cbADA/USDC $6K/7d
        "0x9125d0fa03c3137166df68bcc72283477830de2a4a5536512374c573ad4583c3", // cbLTC/USDC $5.4K/7d
        "0x45f3b5688e7ba25071f78d1ce51d1b893faa3c86897b12204cdff3af6b3611f8", // mBASIS/USDC $1K/7d
        "0x34f676bd8db106d6cdc90d0fb44145cea2f393310a794812cb1c5a8726b60913", // wbCOIN/USDC $47/7d
        "0x214c2bf3c899c913efda9c4a49adff23f77bbc2dc525af7c05be7ec93f32d561", // wrsETH/WETH — UniswapV3 3000 fee tier (1 wrsETH = 1.06 WETH)
        "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836", // cbBTC/USDC (main market)
        "0x1c21c59df9db44bf6f645d854ee710a8ca17b479451447e9f56758aee10a2fad", // cbETH/USDC
      ],
      liquidityVenues: [
        "erc20Wrapper",
        "erc4626",
        "aerodromeV3",
        "uniswapV3",
        "1inch",
        "pendlePT",
        "midas",
      ],
      pricers: ["defillama", "chainlink", "uniswapV3"],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: false,
      useL2PriorityBidding: true,
      useFastPath: true,
      blockInterval: 50, // ~100s fallback (FlashblockWatcher + CEX Predictor are main paths)
    },
  },
  [unichain.id]: {
    chain: unichain,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["1inch", "erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [katana.id]: {
    chain: katana,
    wNative: "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [arbitrum.id]: {
    chain: arbitrum,
    wNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["pendlePT", "1inch", "erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: false,
      blockInterval: 10, // Arb blocks every 0.25s → scan every 2.5s (was every block = RPC flood)
    },
  },
  [worldchain.id]: {
    chain: worldchain,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0xb1E80387EbE53Ff75a89736097D34dC8D9E9045B", // Re7 USDC
        "0x348831b46876d3dF2Db98BdEc5E3B4083329Ab9f", // Re7 WLD
        "0x0Db7E405278c2674F462aC9D9eb8b8346D1c1571", // Re7 WETH
        "0xBC8C37467c5Df9D50B42294B8628c25888BECF61", // Re7 WBTC
      ],
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [hyperevm.id]: {
    chain: hyperevm,
    wNative: "0x5555555555555555555555555555555555555555",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0x8A862fD6c12f9ad34C9c2ff45AB2b6712e8CEa27", // Felix USDC
        "0xFc5126377F0efc0041C0969Ef9BA903Ce67d151e", // Felix USDT
        "0x2900ABd73631b2f60747e687095537B673c06A76", // Felix HYPE
      ],
      liquidityVenues: ["liquidSwap", "erc20Wrapper", "erc4626", "uniswapV3"],
      additionalMarketsWhitelist: [],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: false,
    },
  },
  [monad.id]: {
    chain: monad,
    wNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3"],
      liquidationBufferBps: 500, // 5% buffer — prevents mulDivUp overflow on high-LLTV markets (wrsETH/WETH 94.5%)
      useFlashbots: false,
      blockInterval: 10,
    },
  },
};
