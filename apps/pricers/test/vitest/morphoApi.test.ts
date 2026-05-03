import { randomAddress } from "@morpho-org/test";
import { describe, expect, it } from "vitest";

import { MorphoApi } from "../../src";
import { WBTC, USDC, USDC_BASE } from "../constants.js";
import { hasMainnetArchiveForkForTests, test } from "../setup.js";

if (!hasMainnetArchiveForkForTests) {
  describe("morpho api pricer", () => {
    it.skip("TODO(Sprint 52.1): archive-fork test requires a non-localhost RPC_URL_1", () => {});
  });
} else {
  describe("morpho api pricer", () => {
    const pricer = new MorphoApi();

    test.sequential("should test price", async ({ client }) => {
      expect((await pricer.price(client, USDC)) - 1).toBeLessThan(0.1);
      expect(await pricer.price(client, USDC_BASE)).toBeUndefined();
      expect(await pricer.price(client, WBTC)).toBeGreaterThan(0);
      expect(await pricer.price(client, randomAddress(1))).toBeUndefined();
    });
  });
}
