import { describe, expect, it } from "vitest";

import { resolveShareLiquidationPlan } from "../../src/utils/morphoLiquidation.js";

describe("resolveShareLiquidationPlan", () => {
  it("round-trips a realistic liquidation target exactly", () => {
    const plan = resolveShareLiquidationPlan({
      borrowShares: 674722025n,
      collateral: 10969n,
      totalBorrowAssets: 4479803533167n,
      totalBorrowShares: 4449640271686n,
      price: 64643715318620483239000000000000000000000n,
      lltv: 860000000000000000n,
      targetSeizedAssets: 10969n,
    });

    expect(plan).not.toBeNull();
    expect(plan?.repaidShares).toBe(674722025n);
    expect(plan?.seizedAssets).toBe(10969n);
  });

  it("backs off repaid shares when the naive shares conversion overshoots the target", () => {
    const plan = resolveShareLiquidationPlan({
      borrowShares: 36478340n,
      collateral: 60723522n,
      totalBorrowAssets: 464599223554n,
      totalBorrowShares: 974018503350n,
      price: 1000000000016283960924400265216n,
      lltv: 922656363363310480n,
      targetSeizedAssets: 60723522n,
    });

    expect(plan).not.toBeNull();
    expect(plan?.repaidShares).toBe(125n);
    expect(plan?.seizedAssets).toBe(59999999n);
    expect(plan?.seizedAssets).toBeLessThanOrEqual(60723522n);
  });

  it("returns null when even one share would seize more collateral than the target allows", () => {
    const plan = resolveShareLiquidationPlan({
      borrowShares: 97859126n,
      collateral: 692n,
      totalBorrowAssets: 689532479491n,
      totalBorrowShares: 266255122518n,
      price: 1000000000086874653901428883456n,
      lltv: 929179303782548304n,
      targetSeizedAssets: 692n,
    });

    expect(plan).toBeNull();
  });
});
