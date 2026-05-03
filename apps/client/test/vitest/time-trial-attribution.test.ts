import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  classifyAttribution,
  classifyRegime,
  evaluateCoverageGate,
  type AnswerUpdatedCandidate,
} from "../../../../scripts/time-trial/enrich-triggers.js";
import { MARKETS, getByMarketId } from "../../../../scripts/time-trial/market-oracle-registry.js";
import { callWithFailover } from "../../../../scripts/time-trial/rpc-waterfall.js";

function candidate(overrides: Partial<AnswerUpdatedCandidate> = {}): AnswerUpdatedCandidate {
  return {
    blockNumber: 100n,
    transactionIndex: 1,
    transactionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    aggregator: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    label: "ETH/USD",
    ...overrides,
  };
}

const WETH_MARKET = getByMarketId(
  "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda",
)!;
const CBETH_MARKET = getByMarketId(
  "0x1c21c59df9db44bf6f645d854ee710a8ca17b479451447e9f56758aee10a2fad",
)!;
const CBXRP_MARKET = getByMarketId(
  "0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109",
)!;

describe("time-trial attribution helpers", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("registry has 6 entries and cbXRP is unsupported", () => {
    expect(MARKETS).toHaveLength(6);
    expect(CBXRP_MARKET.supportsReplay).toBe(false);
  });

  it("getByMarketId returns null for unknown market", () => {
    expect(
      getByMarketId("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    ).toBeNull();
  });

  it("classifies immediate oracle matches inside 9 blocks", () => {
    const result = classifyAttribution({
      market: WETH_MARKET,
      winnerBlockNumber: 103n,
      winnerTxIndex: 5,
      immediateCandidates: [candidate({ blockNumber: 100n })],
      staleCandidates: [],
      borrowerActionFound: false,
    });
    expect(result.attributionBucket).toBe("immediate_raceable_oracle");
  });

  it("classifies stale oracle matches outside the immediate window", () => {
    const result = classifyAttribution({
      market: WETH_MARKET,
      winnerBlockNumber: 120n,
      winnerTxIndex: 5,
      immediateCandidates: [],
      staleCandidates: [candidate({ blockNumber: 100n })],
      borrowerActionFound: false,
    });
    expect(result.attributionBucket).toBe("stale_oracle_possible");
  });

  it("falls back to interest_or_unknown when no signals exist", () => {
    const result = classifyAttribution({
      market: WETH_MARKET,
      winnerBlockNumber: 120n,
      winnerTxIndex: 5,
      immediateCandidates: [],
      staleCandidates: [],
      borrowerActionFound: false,
    });
    expect(result.attributionBucket).toBe("interest_or_unknown");
  });

  it("short-circuits unsupported replay markets", () => {
    const result = classifyAttribution({
      market: CBXRP_MARKET,
      winnerBlockNumber: 120n,
      winnerTxIndex: 5,
      immediateCandidates: [candidate()],
      staleCandidates: [candidate()],
      borrowerActionFound: true,
    });
    expect(result.attributionBucket).toBe("unsupported_oracle_type");
  });

  it("marks composed legs separately", () => {
    const result = classifyAttribution({
      market: CBETH_MARKET,
      winnerBlockNumber: 120n,
      winnerTxIndex: 5,
      immediateCandidates: [candidate({ label: "cbETH/ETH" })],
      staleCandidates: [],
      borrowerActionFound: false,
    });
    expect(result.attributionBucket).toBe("oracle_composed_leg");
  });

  it("marks borrower action candidates when oracle signals are absent", () => {
    const result = classifyAttribution({
      market: WETH_MARKET,
      winnerBlockNumber: 120n,
      winnerTxIndex: 5,
      immediateCandidates: [],
      staleCandidates: [],
      borrowerActionFound: true,
    });
    expect(result.attributionBucket).toBe("borrower_action_candidate");
  });

  it("classifies regime thresholds exactly", () => {
    expect(classifyRegime(0)).toBe("dead");
    expect(classifyRegime(9)).toBe("quiet");
    expect(classifyRegime(15)).toBe("active");
    expect(classifyRegime(25)).toBe("cascade");
  });

  it("coverage gate fails when active+cascade days are below minimum", () => {
    const result = evaluateCoverageGate({
      days: 30,
      activeOrCascadeDays: 2,
      immediateRaceableEvents: 99,
    });
    expect(result.coverageOk).toBe(false);
  });

  it("coverage gate fails when raceable events are below threshold", () => {
    const result = evaluateCoverageGate({
      days: 30,
      activeOrCascadeDays: 3,
      immediateRaceableEvents: 10,
    });
    expect(result.coverageOk).toBe(false);
  });

  it("coverage gate relaxes raceable threshold for 7d smoke runs", () => {
    const result = evaluateCoverageGate({
      days: 7,
      activeOrCascadeDays: 3,
      immediateRaceableEvents: 10,
    });
    expect(result.coverageOk).toBe(true);
  });

  it("throws on banned publicnode RPC URLs", async () => {
    process.env.BASE_DRPC_RPC_URL = "https://base-rpc.publicnode.com";
    await expect(callWithFailover(async () => 1)).rejects.toThrow(/banned/i);
  });
});
