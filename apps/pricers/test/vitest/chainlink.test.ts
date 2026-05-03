import { describe, expect, it } from "vitest";

import { ChainlinkPricer } from "../../src";
import { WBTC, USDC, WETH } from "../constants.js";
import { hasMainnetArchiveForkForTests, test } from "../setup.js";

if (!hasMainnetArchiveForkForTests) {
  describe("chainlink pricer", () => {
    it.skip("TODO(Sprint 52.1): archive-fork test requires a non-localhost RPC_URL_1", () => {});
  });
} else {
  describe("chainlink pricer", () => {
    test("should return price on Ethereum mainnet", async ({ client }) => {
      const pricer = new ChainlinkPricer();

      const wethPrice = await pricer.price(client, WETH);
      expect(wethPrice !== undefined).toBeTruthy();
      expect(wethPrice).toBeGreaterThan(1000);

      const wbtcPrice = await pricer.price(client, WBTC);
      expect(wbtcPrice !== undefined).toBeTruthy();
      expect(wbtcPrice).toBeGreaterThan(20000);

      const usdcPrice = await pricer.price(client, USDC);
      expect(usdcPrice !== undefined).toBeTruthy();
      expect(usdcPrice).toBeCloseTo(1, 3);
    });
  });
}
