import { createViemTest } from "@morpho-org/test/vitest";
import { config as loadEnv } from "dotenv";
import { mainnet } from "viem/chains";

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

export const test = createViemTest(mainnet, {
  forkUrl: getForkUrl("RPC_URL_1", MAINNET_ARCHIVE_FALLBACK),
  forkBlockNumber: 21_000_000,
});
