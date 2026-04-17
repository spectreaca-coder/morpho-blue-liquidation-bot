import { MarketUtils } from "@morpho-org/blue-sdk";

export interface ShareLiquidationPlanParams {
  borrowShares: bigint;
  collateral: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  price: bigint;
  lltv: bigint;
  targetSeizedAssets: bigint;
}

export interface ShareLiquidationPlan {
  repaidShares: bigint;
  repaidAssets: bigint;
  seizedAssets: bigint;
}

/**
 * Resolve a liquidation into repaid shares, then round-trip the shares back into
 * the exact collateral amount Morpho will seize for those shares.
 *
 * Morpho rounds shares and assets differently on the two liquidation paths. A
 * naive `getLiquidationRepaidShares(target)` can overshoot the collateral amount
 * we intend to swap. This binary-searches the largest repaid share amount whose
 * predicted seized collateral stays within the requested target.
 */
export function resolveShareLiquidationPlan({
  borrowShares,
  collateral,
  totalBorrowAssets,
  totalBorrowShares,
  price,
  lltv,
  targetSeizedAssets,
}: ShareLiquidationPlanParams): ShareLiquidationPlan | null {
  const maxSeizedAssets = targetSeizedAssets < collateral ? targetSeizedAssets : collateral;

  if (borrowShares === 0n || maxSeizedAssets === 0n || price === 0n) return null;

  const market = {
    totalBorrowAssets,
    totalBorrowShares,
    price,
  };
  const config = { lltv };

  let high = MarketUtils.getLiquidationRepaidShares(maxSeizedAssets, market, config);
  if (high === undefined || high === 0n) return null;
  if (high > borrowShares) high = borrowShares;

  let low = 0n;
  while (low < high) {
    const mid: bigint = low + (high - low + 1n) / 2n;
    const seizedAssets = MarketUtils.getLiquidationSeizedAssets(mid, market, config);

    if (seizedAssets !== undefined && seizedAssets <= maxSeizedAssets) low = mid;
    else high = mid - 1n;
  }

  if (low === 0n) return null;

  const seizedAssets = MarketUtils.getLiquidationSeizedAssets(low, market, config);
  if (seizedAssets === undefined || seizedAssets === 0n) return null;

  return {
    repaidShares: low,
    repaidAssets: MarketUtils.toBorrowAssets(low, market, "Up"),
    seizedAssets,
  };
}
