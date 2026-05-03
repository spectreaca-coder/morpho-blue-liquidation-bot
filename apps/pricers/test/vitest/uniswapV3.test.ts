import { randomAddress } from "@morpho-org/test";
import { checksumAddress } from "viem";
import { describe, expect, it } from "vitest";

import { UniswapV3Pricer } from "../../src";
import { WBTC, USDC, WETH } from "../constants.js";
import { hasMainnetArchiveForkForTests, test } from "../setup.js";

if (!hasMainnetArchiveForkForTests) {
  describe("morpho api pricer", () => {
    it.skip("TODO(Sprint 52.1): archive-fork test requires a non-localhost RPC_URL_1", () => {});
  });
} else {
  describe("morpho api pricer", () => {
    const pricer = new UniswapV3Pricer();

    test.sequential("should test price", async ({ client }) => {
      /// Prices at the time of the fork
      expect(Math.abs((await pricer.price(client, WBTC)) - 68000)).toBeLessThan(1000);
      expect(Math.abs((await pricer.price(client, WETH)) - 2650)).toBeLessThan(30);
      expect(await pricer.price(client, USDC)).toBe(1);
      expect(await pricer.price(client, checksumAddress(randomAddress(1)))).toBeUndefined();
    });
  });
}
