import { Address, Hex } from "viem";

export class PositionLiquidationCooldownMechanism {
  private cooldownPeriod: number;
  private positionReadyAt: Record<Hex, Record<Address, number>>;

  constructor(cooldownPeriod: number) {
    this.cooldownPeriod = cooldownPeriod;
    this.positionReadyAt = {};
  }

  isPositionReady(marketId: Hex, account: Address) {
    if (this.positionReadyAt[marketId] === undefined) {
      this.positionReadyAt[marketId] = {};
    }

    // Prune expired entries in this market bucket to prevent unbounded memory growth
    const now = Date.now() / 1000;
    let bucket = this.positionReadyAt[marketId];
    bucket = Object.fromEntries(
      Object.entries(bucket).filter(([, readyAt]) => readyAt > now),
    ) as Record<Address, number>;
    this.positionReadyAt[marketId] = bucket;

    if (bucket[account] !== undefined && bucket[account] > now) {
      return false;
    }

    return true;
  }

  markPositionUsed(marketId: Hex, account: Address) {
    if (this.positionReadyAt[marketId] === undefined) {
      this.positionReadyAt[marketId] = {};
    }
    this.positionReadyAt[marketId][account] = Date.now() / 1000 + this.cooldownPeriod;
  }
}

export class MarketsFetchingCooldownMechanism {
  private cooldownPeriod: number;
  private readyAt: number;

  constructor(cooldownPeriod: number) {
    this.cooldownPeriod = cooldownPeriod;
    this.readyAt = 0;
  }

  isFetchingReady() {
    if (this.readyAt > Date.now() / 1000) {
      return false;
    }
    return true;
  }

  markFetchingDone() {
    this.readyAt = Date.now() / 1000 + this.cooldownPeriod;
  }
}
