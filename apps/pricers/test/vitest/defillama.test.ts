import { beforeEach, describe, expect, it } from "vitest";

import { DefiLlamaPricer } from "../../src";
import { WBTC, USDC, WETH, USDC_BASE } from "../constants.js";
import { hasMainnetArchiveForkForTests, test } from "../setup.js";

if (!hasMainnetArchiveForkForTests) {
  describe("defillama pricer", () => {
    it.skip("TODO(Sprint 52.1): archive-fork test requires a non-localhost RPC_URL_1", () => {});
  });
} else {
  describe("defillama pricer", () => {
    let pricer: DefiLlamaPricer;

    beforeEach(() => {
      pricer = new DefiLlamaPricer();
    });

    test("should test price", async ({ client }) => {
      expect(await pricer.price(client, USDC_BASE)).toBe(undefined);
      expect(Math.floor(Math.log10(await pricer.price(client, WETH)))).toBeCloseTo(3);
      expect(Math.log10(await pricer.price(client, WBTC))).toBeGreaterThan(4);
      expect(await pricer.price(client, USDC)).toBeCloseTo(1, 3);
    });
  });
}
