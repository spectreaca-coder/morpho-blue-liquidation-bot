import { hyperevm } from "@morpho-blue-liquidation-bot/config";
import type { AnvilTestClient } from "@morpho-org/test";
import { createViemTest } from "@morpho-org/test/vitest";
import { config as loadEnv } from "dotenv";
import { ExecutorEncoder, executorAbi, bytecode } from "executooor-viem";
import { type Chain, mainnet } from "viem/chains";

loadEnv();

const MAINNET_ARCHIVE_FALLBACK = "https://eth.drpc.org";

function getForkUrl(envKey: keyof NodeJS.ProcessEnv, fallback: string): string {
  const configured = process.env[envKey];
  if (!configured) return fallback;

  try {
    const host = new URL(configured).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host.includes("publicnode")) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  return configured;
}

function hasUsableExplicitForkUrl(envKey: keyof NodeJS.ProcessEnv): boolean {
  const configured = process.env[envKey];
  if (!configured) return false;

  try {
    const host = new URL(configured).hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && !host.includes("publicnode");
  } catch {
    return false;
  }
}

export const hasMainnetArchiveForkForTests = hasUsableExplicitForkUrl("RPC_URL_1");
export const hasHyperevmArchiveForkForTests = hasUsableExplicitForkUrl("RPC_URL_999");

export interface ExecutorEncoderTestContext<chain extends Chain = Chain> {
  encoder: ExecutorEncoder<AnvilTestClient<chain>>;
}

export const encoderTest = createViemTest(mainnet, {
  forkUrl: getForkUrl("RPC_URL_1", MAINNET_ARCHIVE_FALLBACK),
  forkBlockNumber: 21_000_000,
  timeout: 100_000,
}).extend<ExecutorEncoderTestContext<typeof mainnet>>({
  encoder: async ({ client }, use) => {
    const receipt = await client.deployContractWait({
      abi: executorAbi,
      bytecode,
      args: [client.account.address],
    });

    await use(new ExecutorEncoder(receipt.contractAddress, client));
  },
});

export const encoderTestLaterBlock = createViemTest(mainnet, {
  forkUrl: getForkUrl("RPC_URL_1", MAINNET_ARCHIVE_FALLBACK),
  forkBlockNumber: 22_588_625,
  timeout: 100_000,
}).extend<ExecutorEncoderTestContext<typeof mainnet>>({
  encoder: async ({ client }, use) => {
    const receipt = await client.deployContractWait({
      abi: executorAbi,
      bytecode,
      args: [client.account.address],
    });

    await use(new ExecutorEncoder(receipt.contractAddress, client));
  },
});

export const oneInchTest = createViemTest(mainnet, {
  forkUrl: getForkUrl("RPC_URL_1", MAINNET_ARCHIVE_FALLBACK),
  forkBlockNumber: 23_474_754,
  timeout: 100_000,
}).extend<ExecutorEncoderTestContext<typeof mainnet>>({
  encoder: async ({ client }, use) => {
    const receipt = await client.deployContractWait({
      abi: executorAbi,
      bytecode,
      args: [client.account.address],
    });

    await use(new ExecutorEncoder(receipt.contractAddress, client));
  },
});

export const pendlePTTest = createViemTest(mainnet, {
  forkUrl: getForkUrl("RPC_URL_1", MAINNET_ARCHIVE_FALLBACK),
  forkBlockNumber: 23_490_817,
}).extend<ExecutorEncoderTestContext<typeof mainnet>>({
  encoder: async ({ client }, use) => {
    const receipt = await client.deployContractWait({
      abi: executorAbi,
      bytecode,
      args: [client.account.address],
    });

    await use(new ExecutorEncoder(receipt.contractAddress, client));
  },
});

export const midasTest = createViemTest(mainnet, {
  forkUrl: getForkUrl("RPC_URL_1", MAINNET_ARCHIVE_FALLBACK),
  forkBlockNumber: 21_587_766,
}).extend<ExecutorEncoderTestContext<typeof mainnet>>({
  encoder: async ({ client }, use) => {
    const receipt = await client.deployContractWait({
      abi: executorAbi,
      bytecode,
      args: [client.account.address],
    });

    await use(new ExecutorEncoder(receipt.contractAddress, client));
  },
});

export const liquidSwapTest = createViemTest(hyperevm, {
  forkUrl: getForkUrl("RPC_URL_999", hyperevm.rpcUrls.default.http[0]),
  forkBlockNumber: 18383174,
}).extend<ExecutorEncoderTestContext<typeof hyperevm>>({
  encoder: async ({ client }, use) => {
    const receipt = await client.deployContractWait({
      abi: executorAbi,
      bytecode,
      args: [client.account.address],
    });

    await use(new ExecutorEncoder(receipt.contractAddress, client));
  },
});
