#!/usr/bin/env python3
"""Analyse competitor priority-fee (tip) distribution from Morpho liquidation forensics.

Reads:
  analysis_output/competitor_analysis/top_hunters_tx_forensics.json
  analysis_output/competitor_analysis/top_hunters_timing.json
  analysis_output/competitor_analysis/top_hunters_selection.json
  analysis_output/competitor_analysis/revert_rate_top_callers_20260412.json
  analysis_output/missed_liquidations.json (+ missed_cbbtc_weth.json, missed_cbxrp.json)

Writes:
  analysis_output/competitor_analysis/tip_distribution_stats.json

IMPORTANT DATA QUALITY NOTES (surfaced by the script):
  * Forensics file only contains the top-10 netProfitUsd transactions per competitor
    (20 tx total, 2 competitors: target1 / target2). This is a profit-biased sample
    and the tip percentiles are therefore *upper-biased* versus the full population.
  * `missed_*` records have no tip / priorityFee fields, so we cannot directly
    build a per-collateral winning-tip distribution from the full missed set.
  * `revert_rate_top_callers_20260412.json` covers 3 different callers and stores
    only success/sender counts, no tip data.
  * Private-mempool / Flashbots usage is not directly labelled; we approximate
    via `targetWasTxTo=false` AND unknown selector (likely proprietary bundler
    or builder relay) — clearly marked `privateMempoolHeuristic`.
"""
from __future__ import annotations

import json
import math
import os
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
COMP_DIR = REPO_ROOT / "analysis_output" / "competitor_analysis"
ANALYSIS_DIR = REPO_ROOT / "analysis_output"
OUT_PATH = COMP_DIR / "tip_distribution_stats.json"

WHITELIST = ["cbBTC", "WETH", "cbXRP", "wrsETH", "cbADA", "cbETH", "cbLTC"]


def load_json(p: Path) -> Any:
    with p.open() as f:
        return json.load(f)


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    vs = sorted(values)
    if len(vs) == 1:
        return vs[0]
    k = (len(vs) - 1) * q
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return vs[int(k)]
    return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)


def summarise(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "min": min(values),
        "p25": pct(values, 0.25),
        "median": pct(values, 0.5),
        "p75": pct(values, 0.75),
        "p99": pct(values, 0.99),
        "max": max(values),
        "avg": sum(values) / len(values),
    }


def extract_tx_rows(forensics: dict) -> list[dict]:
    """Flatten forensics tx list into rows usable for analysis."""
    rows = []
    for tx in forensics.get("transactions", []):
        t = tx.get("transaction", {}) or {}
        r = tx.get("receipt", {}) or {}
        b = tx.get("block", {}) or {}
        c = tx.get("computed", {}) or {}
        ts_iso = tx.get("timestamp") or b.get("timestampIso")
        hour = None
        if ts_iso:
            try:
                hour = datetime.fromisoformat(ts_iso.replace("Z", "+00:00")).astimezone(timezone.utc).hour
            except Exception:
                hour = None
        tip_gwei = c.get("effectiveTipGwei")
        if tip_gwei is None:
            tip_gwei = t.get("maxPriorityFeePerGasGwei")
        rows.append(
            {
                "target": tx.get("targetName"),
                "caller": tx.get("caller"),
                "txHash": tx.get("txHash"),
                "block": tx.get("blockNumber"),
                "collateralSymbol": tx.get("collateralSymbol"),
                "loanSymbol": tx.get("loanSymbol"),
                "netProfitUsd": tx.get("netProfitUsd"),
                "txAggregateNetProfitUsd": tx.get("txAggregateNetProfitUsd"),
                "incentiveUsd": tx.get("incentiveUsd"),
                "healthFactorApprox": tx.get("healthFactorApprox"),
                "txFrom": (t.get("from") or "").lower(),
                "txTo": (t.get("to") or "").lower(),
                "inputSelector": t.get("inputSelector"),
                "targetWasTxTo": t.get("targetWasTxTo"),
                "gasUsed": int(r.get("gasUsed") or 0),
                "effectiveGasPriceGwei": r.get("effectiveGasPriceGwei"),
                "baseFeeGwei": b.get("baseFeePerGasGwei"),
                "tipGwei": tip_gwei,
                "maxPriorityFeeGwei": t.get("maxPriorityFeePerGasGwei"),
                "maxFeePerGasGwei": t.get("maxFeePerGasGwei"),
                "blockPositionBucket": r.get("blockPositionBucket"),
                "transactionIndex": r.get("transactionIndex"),
                "blockTxCount": r.get("blockTransactionCount"),
                "positionPercentile": r.get("positionPercentile"),
                "hourUtc": hour,
            }
        )
    return rows


def per_competitor_distribution(rows: list[dict], summaries: dict) -> dict:
    by_target: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_target[r["target"]].append(r)
    out = {}
    for name, group in by_target.items():
        tip_vals = [r["tipGwei"] for r in group if r["tipGwei"] is not None]
        eff_gas_vals = [r["effectiveGasPriceGwei"] for r in group if r["effectiveGasPriceGwei"] is not None]
        base_vals = [r["baseFeeGwei"] for r in group if r["baseFeeGwei"] is not None]
        profit_vals = [r["netProfitUsd"] for r in group if r["netProfitUsd"] is not None]
        # Private-mempool heuristic
        private_flags = [
            (r["targetWasTxTo"] is False and r["inputSelector"] in (None, "", "0xbeef", "0x"))
            for r in group
        ]
        unique_tx_to = sorted({r["txTo"] for r in group if r["txTo"]})
        position_buckets = defaultdict(int)
        for r in group:
            position_buckets[r["blockPositionBucket"] or "unknown"] += 1
        out[name] = {
            "competitorAddress": group[0]["caller"],
            "wins_topN_sample": len(group),
            "tipGweiStats": summarise(tip_vals),
            "effectiveGasPriceGweiStats": summarise(eff_gas_vals),
            "baseFeeGweiStats": summarise(base_vals),
            "netProfitUsdStats": summarise(profit_vals),
            "privateMempoolHeuristicRate": (
                sum(private_flags) / len(private_flags) if private_flags else None
            ),
            "uniqueTxToAddresses": unique_tx_to,
            "positionBuckets": dict(position_buckets),
            "sourceSummaryEffectiveTipGwei": summaries.get(name, {}).get("effectiveTipGwei"),
        }
    return out


def tip_vs_profit(rows: list[dict]) -> dict:
    buckets = {
        "0-100": (0, 100),
        "100-1k": (100, 1_000),
        "1k-10k": (1_000, 10_000),
        "10k+": (10_000, float("inf")),
    }
    agg = {name: [] for name in buckets}
    tip_as_pct_profit = []
    for r in rows:
        p = r["netProfitUsd"]
        t = r["tipGwei"]
        g = r["gasUsed"]
        if p is None or t is None:
            continue
        for name, (lo, hi) in buckets.items():
            if lo <= p < hi:
                agg[name].append(r)
                break
        # tip spend in USD ≈ tip_gwei * gasUsed * ETH/gwei / 1e9  — approximate using a fixed ETH price
        # We don't have per-tx ETH price, so we provide the raw tip and tip*gas as gwei units,
        # then a rough ETH price fallback of $3500 used *only* for fraction-of-profit stats.
        eth_usd_fallback = 3500.0
        tip_cost_usd = (t * g / 1e9) * eth_usd_fallback
        frac = tip_cost_usd / p if p > 0 else None
        if frac is not None:
            tip_as_pct_profit.append({
                "netProfitUsd": p,
                "collateralSymbol": r["collateralSymbol"],
                "tipGwei": t,
                "gasUsed": g,
                "tipCostUsdEst": tip_cost_usd,
                "tipFractionOfProfitEst": frac,
            })
    bucket_stats = {}
    for name, group in agg.items():
        bucket_stats[name] = {
            "count": len(group),
            "tipGwei": summarise([r["tipGwei"] for r in group if r["tipGwei"] is not None]),
            "netProfitUsd": summarise([r["netProfitUsd"] for r in group if r["netProfitUsd"] is not None]),
        }
    # simple linear regression tip_gwei ~ profit_usd (for documentation; R² is the key output)
    xs = [r["netProfitUsd"] for r in rows if r["netProfitUsd"] is not None and r["tipGwei"] is not None]
    ys = [r["tipGwei"] for r in rows if r["netProfitUsd"] is not None and r["tipGwei"] is not None]
    r2 = None
    slope = None
    if len(xs) >= 3:
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        ssxx = sum((x - mx) ** 2 for x in xs)
        ssxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        sstot = sum((y - my) ** 2 for y in ys)
        if ssxx > 0 and sstot > 0:
            slope = ssxy / ssxx
            intercept = my - slope * mx
            ssres = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys))
            r2 = 1 - ssres / sstot
    return {
        "profitBuckets_tipDistribution": bucket_stats,
        "regression_tipGwei_vs_profitUsd": {
            "n": len(xs),
            "slope": slope,
            "r2": r2,
            "note": "Simple OLS; additional regressors (collateral, hour) not run — sample size too small (n=20). Do not over-interpret.",
        },
        "tipCostFractionOfProfitEst": {
            "note": "ETH=$3500 fallback used for USD conversion; per-tx ETH price not in forensics.",
            "stats": summarise([r["tipFractionOfProfitEst"] for r in tip_as_pct_profit]),
            "sampleRows": tip_as_pct_profit[:10],
        },
    }


def tip_by_collateral(rows: list[dict]) -> dict:
    by_col: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_col[r["collateralSymbol"] or "UNKNOWN"].append(r)
    out = {}
    for sym, group in by_col.items():
        tip_vals = [r["tipGwei"] for r in group if r["tipGwei"] is not None]
        profit_vals = [r["netProfitUsd"] for r in group if r["netProfitUsd"] is not None]
        callers = defaultdict(int)
        for r in group:
            callers[r["caller"]] += 1
        dominant = max(callers.items(), key=lambda kv: kv[1]) if callers else (None, 0)
        out[sym] = {
            "count": len(group),
            "tipGwei": summarise(tip_vals),
            "netProfitUsd": summarise(profit_vals),
            "winnerShares": {k: v / len(group) for k, v in callers.items()},
            "dominantWinner": {"address": dominant[0], "share": dominant[1] / len(group) if len(group) else None},
        }
    return out


def tip_by_hour(rows: list[dict]) -> dict:
    by_h: dict[int, list[float]] = defaultdict(list)
    for r in rows:
        if r["hourUtc"] is None or r["tipGwei"] is None:
            continue
        by_h[r["hourUtc"]].append(r["tipGwei"])
    return {str(h): summarise(vs) for h, vs in sorted(by_h.items())}


def tip_by_hour_selection(selection: dict) -> dict:
    """From targets selection: aggregate win counts by UTC hour for each target."""
    out = {}
    for tname, t in selection.get("targets", {}).items():
        hours = t.get("timeClustering", {}).get("byUtcHour", {})
        total = sum(hours.values()) or 1
        out[tname] = {
            "totalWins": total,
            "hourlySharePct": {h: round(100 * v / total, 2) for h, v in hours.items()},
            "interarrivalHours": t.get("timeClustering", {}).get("interarrivalHours"),
        }
    return out


def actionable_thresholds(rows: list[dict], selection: dict) -> dict:
    """Per-whitelist-collateral: tip quantiles seen in winning forensic tx + implied fraction."""
    by_col: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["collateralSymbol"] and r["tipGwei"] is not None:
            by_col[r["collateralSymbol"]].append(r)
    out = {}
    for sym in WHITELIST:
        group = by_col.get(sym, [])
        tips = [r["tipGwei"] for r in group]
        if not tips:
            out[sym] = {
                "sample_n": 0,
                "note": "No forensic transactions in top-10-per-target covered this collateral. "
                        "Fall back to base-fee + 0.005 gwei per current bot default.",
            }
            continue
        # "Win X% of the time in this sample" → pay >= X-th percentile tip
        p50 = pct(tips, 0.50)
        p75 = pct(tips, 0.75)
        p90 = pct(tips, 0.90)
        pmax = max(tips)
        # fraction of profit (approx with $3500 ETH)
        eth_usd = 3500.0
        frac_est = []
        for r in group:
            if r["netProfitUsd"] and r["gasUsed"]:
                cost = (r["tipGwei"] * r["gasUsed"] / 1e9) * eth_usd
                if r["netProfitUsd"] > 0:
                    frac_est.append(cost / r["netProfitUsd"])
        out[sym] = {
            "sample_n": len(group),
            "winRate_50pct_tipGwei": p50,
            "winRate_75pct_tipGwei": p75,
            "winRate_90pct_tipGwei": p90,
            "winRate_100pct_tipGwei": pmax,
            "tipFractionOfProfit_estStats": summarise(frac_est),
            "exceeds20pctCapSampleCount": sum(1 for f in frac_est if f > 0.20),
            "note": ("Sample only includes TOP-10-per-target profit wins — fee paid may be lower "
                     "than the true marginal winner. Use these as floor estimates."),
        }
    return out


def private_mempool_heuristics(rows: list[dict]) -> dict:
    """Infer private/bundled submission from tx metadata."""
    flags = []
    for r in rows:
        flags.append({
            "txHash": r["txHash"],
            "competitor": r["target"],
            "txFrom": r["txFrom"],
            "txTo": r["txTo"],
            "targetWasTxTo": r["targetWasTxTo"],
            "inputSelector": r["inputSelector"],
            "transactionIndex": r["transactionIndex"],
            "positionPercentile": r["positionPercentile"],
            "blockPositionBucket": r["blockPositionBucket"],
        })
    # Base sequencer has a public mempool but also accepts builder relays.
    # A mature MEV bot on Base typically routes via a relayer or its own bundler contract.
    # We use: tx.to != caller address AND selector looks obfuscated (e.g. '0xbeef') as a proxy.
    likely_private = [
        f for f in flags
        if f["targetWasTxTo"] is False and f["inputSelector"] in (None, "", "0xbeef", "0x")
    ]
    return {
        "note": (
            "Base sequencer has a public mempool; there is no Flashbots on Base. "
            "Proxy signal: tx sent to a non-caller relayer/bundler with obfuscated selector "
            "(e.g. '0xbeef' padding) indicates proprietary private inclusion path — not definitive."
        ),
        "rowFlags": flags,
        "likelyPrivate_count": len(likely_private),
        "likelyPrivate_share": (len(likely_private) / len(flags)) if flags else None,
    }


def main() -> int:
    forensics = load_json(COMP_DIR / "top_hunters_tx_forensics.json")
    timing = load_json(COMP_DIR / "top_hunters_timing.json")
    selection = load_json(COMP_DIR / "top_hunters_selection.json")
    revert = load_json(COMP_DIR / "revert_rate_top_callers_20260412.json")

    rows = extract_tx_rows(forensics)

    data_quality = {
        "forensicsScope": forensics.get("scope"),
        "forensicsGeneratedAt": forensics.get("generatedAt"),
        "nTransactions": len(rows),
        "nCompetitors": len({r["target"] for r in rows}),
        "competitorAddresses": sorted({r["caller"] for r in rows}),
        "selectionTotalEvents": selection.get("totalEvents"),
        "selectionTotalNetProfitUsd": selection.get("totalNetProfitUsd"),
        "revertFileCallers": [t.get("caller") for t in revert.get("targets", [])],
        "caveats": [
            "Forensics is top-10-per-target by netProfitUsd → profit-biased upper tail.",
            "Only 2 competitors (target1/target2) have tx-level tip data; not 5-10.",
            "No missed_* records contain tip data; we cannot reconstruct losing bids.",
            "ETH price hard-coded to $3500 for USD tip-cost conversion (per-tx price unavailable).",
        ],
    }

    summaries = forensics.get("summaries", {}) or {}

    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dataQuality": data_quality,
        "perCompetitor": per_competitor_distribution(rows, summaries),
        "tipVsProfit": tip_vs_profit(rows),
        "tipByCollateral": tip_by_collateral(rows),
        "tipByHourUtc_forensic": tip_by_hour(rows),
        "winsByHourUtc_selection": tip_by_hour_selection(selection),
        "actionableThresholds": actionable_thresholds(rows, selection),
        "privateMempoolHeuristic": private_mempool_heuristics(rows),
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w") as f:
        json.dump(result, f, indent=2, default=str)

    # ---- stdout summary ----
    print("=" * 78)
    print("COMPETITOR TIP DISTRIBUTION — SUMMARY")
    print("=" * 78)
    print(f"Transactions analysed: {len(rows)} (profit-biased top-10 per target)")
    print(f"Competitors: {data_quality['nCompetitors']}")
    for addr in data_quality["competitorAddresses"]:
        print(f"  - {addr}")
    print()
    for name, stats in result["perCompetitor"].items():
        print(f"[{name}] {stats['competitorAddress']}  wins(sample)={stats['wins_topN_sample']}")
        t = stats["tipGweiStats"]
        print(f"   tip (gwei)  median={t['median']:.4g}  p25={t['p25']:.4g}  p75={t['p75']:.4g}  "
              f"p99={t['p99']:.4g}  avg={t['avg']:.4g}  max={t['max']:.4g}")
        p = stats["netProfitUsdStats"]
        print(f"   net profit ($) median={p['median']:.2f}  max={p['max']:.2f}  avg={p['avg']:.2f}")
        print(f"   privateMempoolHeuristic={stats['privateMempoolHeuristicRate']:.2f}"
              if stats['privateMempoolHeuristicRate'] is not None else "   privateMempoolHeuristic=n/a")
        print(f"   unique txTo addresses: {stats['uniqueTxToAddresses']}")
    print()
    print("Tip-vs-profit bucket medians (gwei):")
    for b, s in result["tipVsProfit"]["profitBuckets_tipDistribution"].items():
        if s["count"]:
            print(f"  {b:>7}  n={s['count']:>2}  tip.median={s['tipGwei']['median']:.4g}  "
                  f"profit.median=${s['netProfitUsd']['median']:.2f}")
    reg = result["tipVsProfit"]["regression_tipGwei_vs_profitUsd"]
    print(f"OLS tip_gwei~profit_usd: n={reg['n']} slope={reg['slope']} R²={reg['r2']}")
    print()
    print("Tip by collateral (forensic top-10 sample only):")
    for sym, s in result["tipByCollateral"].items():
        print(f"  {sym:<8} n={s['count']:>2} tip.median={s['tipGwei']['median']:.4g} gwei "
              f"dominant={s['dominantWinner']['address']} share={s['dominantWinner']['share']:.2f}")
    print()
    print("Private-mempool heuristic:")
    pmh = result["privateMempoolHeuristic"]
    print(f"  likely-private share: {pmh['likelyPrivate_share']} ({pmh['likelyPrivate_count']}/{len(pmh['rowFlags'])})")
    print()
    print("Actionable thresholds (gwei) to win at quantiles per collateral:")
    for sym, s in result["actionableThresholds"].items():
        if s.get("sample_n", 0) == 0:
            print(f"  {sym:<8} no-data")
            continue
        print(f"  {sym:<8} n={s['sample_n']:>2}  p50={s['winRate_50pct_tipGwei']:.4g}  "
              f"p75={s['winRate_75pct_tipGwei']:.4g}  p90={s['winRate_90pct_tipGwei']:.4g}  "
              f"p100={s['winRate_100pct_tipGwei']:.4g}  "
              f"frac_of_profit_median≈{(s['tipFractionOfProfit_estStats']['median'] or 0):.4g}  "
              f"exceeds_20pct_cap={s['exceeds20pctCapSampleCount']}")
    print()
    print(f"Full JSON written to: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
