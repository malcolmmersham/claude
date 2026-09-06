import { describe, it, expect } from "vitest";
import E from "./engine.js";
import V from "./versioning.js";

// Spec §34 — unit tests for the deterministic framework and alert rules.

describe("§3.1 40-point scoring bands", () => {
  it("classifies each band boundary correctly", () => {
    expect(E.coreScorecardBand(40)).toBe("STRONG_CANDIDATE");
    expect(E.coreScorecardBand(32)).toBe("STRONG_CANDIDATE");
    expect(E.coreScorecardBand(31)).toBe("WATCHLIST_OR_STAGED");
    expect(E.coreScorecardBand(26)).toBe("WATCHLIST_OR_STAGED");
    expect(E.coreScorecardBand(25)).toBe("NEEDS_STRONGER_EVIDENCE");
    expect(E.coreScorecardBand(20)).toBe("NEEDS_STRONGER_EVIDENCE");
    expect(E.coreScorecardBand(19)).toBe("AVOID_OR_KEEP_SMALL");
  });

  it("totals eight categories and reports missing ones instead of scoring zero", () => {
    const full = {
      quality: 4, valuation: 4, trading_liquidity: 5, underlying_liquidity: 5,
      capital_flows: 3, macro_liquidity: 3, trend_momentum: 3, risk_control: 4,
    };
    const r = E.coreScorecardTotal(full);
    expect(r.total).toBe(31);
    expect(r.complete).toBe(true);
    expect(r.band).toBe("WATCHLIST_OR_STAGED");

    const partial = { quality: 4, valuation: 4 };
    const p = E.coreScorecardTotal(partial);
    expect(p.total).toBe(8);
    expect(p.complete).toBe(false);
    expect(p.missing).toContain("capital_flows");
  });
});

describe("§3.1 liquidity hard gate", () => {
  it("flags HIGH_LIQUIDITY_RISK when either liquidity < 2, regardless of total", () => {
    expect(E.liquidityHardFlag({ trading_liquidity: 1, underlying_liquidity: 5 }).flag).toBe("HIGH_LIQUIDITY_RISK");
    expect(E.liquidityHardFlag({ trading_liquidity: 5, underlying_liquidity: 1 }).flag).toBe("HIGH_LIQUIDITY_RISK");
    expect(E.liquidityHardFlag({ trading_liquidity: 2, underlying_liquidity: 2 }).flag).toBeNull();
  });
  it("does not fabricate a flag when liquidity is unknown", () => {
    expect(E.liquidityHardFlag({}).flag).toBeNull();
  });
});

describe("§6.4 market context 0–6 scoring", () => {
  it("counts only FAVOURABLE signals and bands them", () => {
    const s = E.sixSignalScore(["FAVOURABLE", "FAVOURABLE", "MIXED", "UNFAVOURABLE", "FAVOURABLE", "UNKNOWN"]);
    expect(s.favourable).toBe(3);
    expect(s.timing).toBe("ACCEPTABLE_CONSERVATIVE_SIZE");
    expect(E.sixSignalScore(["FAVOURABLE","FAVOURABLE","FAVOURABLE","FAVOURABLE","MIXED","MIXED"]).timing).toBe("STRONG_TIMING");
    expect(E.sixSignalScore(["UNFAVOURABLE","MIXED","UNKNOWN","UNFAVOURABLE","MIXED","UNKNOWN"]).timing).toBe("WATCH_WAIT");
  });

  it("market context cannot rescue a broken business (§6 integration)", () => {
    // poor quality + favourable context = value trap / trading-only, never a buy
    expect(E.marketContextIntegration(false, 5)).toBe("VALUE_TRAP_OR_TRADING_ONLY");
    expect(E.marketContextIntegration(false, 0)).toBe("AVOID");
    // good quality needs >=2 favourable to be a stronger candidate
    expect(E.marketContextIntegration(true, 2)).toBe("STRONGER_ENTRY_CANDIDATE");
    expect(E.marketContextIntegration(true, 1)).toBe("WATCHLIST_NOT_CHASE");
  });
});

describe("§7 decision zones", () => {
  it("maps quality × flows to the four zones", () => {
    expect(E.decisionZone("HIGH", "IMPROVING")).toBe("BEST");
    expect(E.decisionZone("HIGH", "DETERIORATING")).toBe("PATIENCE");
    expect(E.decisionZone("LOW", "IMPROVING")).toBe("TRADING_ONLY");
    expect(E.decisionZone("LOW", "DETERIORATING")).toBe("AVOID");
  });
});

describe("§26 hard gates", () => {
  it("a single FAIL dominates and blocks deployment", () => {
    const r = E.hardGateStatus([{ name: "balance_sheet", status: "PASS" }, { name: "moat", status: "FAIL" }]);
    expect(r.overall).toBe("FAIL");
    expect(r.deployable).toBe(false);
  });
  it("REVIEW downgrades, UNKNOWN is not a pass, NOT_APPLICABLE is ignored", () => {
    expect(E.hardGateStatus([{ status: "PASS" }, { status: "REVIEW" }]).overall).toBe("REVIEW");
    expect(E.hardGateStatus([{ status: "PASS" }, { status: "UNKNOWN" }]).overall).toBe("UNKNOWN");
    expect(E.hardGateStatus([{ status: "PASS" }, { status: "NOT_APPLICABLE" }]).overall).toBe("PASS");
  });
});

describe("§9 entry-band membership", () => {
  const bands = [
    { name: "Strong entry", lower_bound: null, upper_bound: 200, stance: "STRONG_ENTRY" },
    { name: "Starter", lower_bound: 200, upper_bound: 220, stance: "STARTER" },
    { name: "Acceptable", lower_bound: 220, upper_bound: 240, stance: "ACCEPTABLE" },
    { name: "Wait", lower_bound: 240, upper_bound: 270, stance: "WAIT" },
    { name: "Avoid chasing", lower_bound: 270, upper_bound: null, stance: "AVOID_CHASING" },
  ];
  it("assigns a price to the right band (lower-exclusive, upper-inclusive)", () => {
    expect(E.findBand(bands, 180).name).toBe("Strong entry");
    expect(E.findBand(bands, 200).name).toBe("Strong entry"); // upper-inclusive
    expect(E.findBand(bands, 200.01).name).toBe("Starter");
    expect(E.findBand(bands, 220).name).toBe("Starter");
    expect(E.findBand(bands, 219.8).name).toBe("Starter");
    expect(E.findBand(bands, 300).name).toBe("Avoid chasing");
  });
});

describe("§9.1 entry-band crossing detection", () => {
  const bands = [
    { name: "Strong entry", lower_bound: null, upper_bound: 200, stance: "STRONG_ENTRY" },
    { name: "Starter", lower_bound: 200, upper_bound: 220, stance: "STARTER" },
    { name: "Wait", lower_bound: 220, upper_bound: 270, stance: "WAIT" },
  ];
  it("emits an event only when the band changes", () => {
    // RMD Wait -> Starter at 219.80 (spec example)
    const c = E.detectBandCrossing(bands, "Wait", 219.8);
    expect(c).not.toBeNull();
    expect(c.from).toBe("Wait");
    expect(c.to).toBe("Starter");
    expect(c.direction).toBe("IMPROVING_ENTRY");
  });
  it("returns null when price stays in the same band (no spam)", () => {
    expect(E.detectBandCrossing(bands, "Starter", 210)).toBeNull();
  });
  it("marks a rising price into a worse band as deteriorating entry", () => {
    const c = E.detectBandCrossing(bands, "Starter", 260);
    expect(c.to).toBe("Wait");
    expect(c.direction).toBe("DETERIORATING_ENTRY");
  });
});

describe("§13 5% daily move trigger", () => {
  it("fires only above the threshold, both directions", () => {
    expect(E.isBigDailyMove(100, 105.01)).toBe(true);
    expect(E.isBigDailyMove(100, 94.99)).toBe(true);
    expect(E.isBigDailyMove(100, 105)).toBe(false); // exactly 5% is not > 5%
    expect(E.isBigDailyMove(100, 103)).toBe(false);
    expect(E.isBigDailyMove(null, 103)).toBe(false);
  });
});

describe("§13.1 alert deduplication", () => {
  it("suppresses an identical band crossing in the same direction", () => {
    const a = { security_key: "NYSE:RMD", type: "BAND_CROSSING", direction: "IMPROVING_ENTRY", band_to: "Starter" };
    expect(E.isDuplicateAlert(a, [a])).toBe(true);
    const other = { security_key: "NYSE:RMD", type: "BAND_CROSSING", direction: "DETERIORATING_ENTRY", band_to: "Wait" };
    expect(E.isDuplicateAlert(other, [a])).toBe(false);
  });
  it("re-alerts a daily move only when it extends by another step", () => {
    const first = { security_key: "X", type: "DAILY_MOVE", session: "2026-09-06", move_pct: -0.06 };
    const same = { security_key: "X", type: "DAILY_MOVE", session: "2026-09-06", move_pct: -0.07 };
    const extended = { security_key: "X", type: "DAILY_MOVE", session: "2026-09-06", move_pct: -0.12 };
    expect(E.isDuplicateAlert(same, [first])).toBe(true);
    expect(E.isDuplicateAlert(extended, [first])).toBe(false);
  });
});

describe("§12.1 materiality threshold", () => {
  it("alerts at >= 3 and requires primary source at >= 3", () => {
    expect(E.materialityWarrantsAlert(3)).toBe(true);
    expect(E.materialityWarrantsAlert(2)).toBe(false);
    expect(E.materialityRequiresPrimarySource(4)).toBe(true);
    expect(E.materialityRequiresPrimarySource(2)).toBe(false);
  });
});

describe("§11 / §38.3 quality-vs-entry delta classification", () => {
  it("a price fall with no new evidence changes ENTRY only, not QUALITY", () => {
    const prev = { quality_score: 80, entry_classification: "WAIT", thesis_status: "INTACT" };
    const curr = { quality_score: 80, entry_classification: "STARTER", thesis_status: "INTACT" };
    const r = E.classifyChange(prev, curr);
    expect(r.quality_changed).toBe(false);
    expect(r.entry_changed).toBe(true);
    expect(r.changes).toContain("PRICE_ONLY_ENTRY_IMPROVEMENT");
    expect(r.alert_kind).toBe("PRICE_ONLY_CHANGE");
  });

  it("a guidance cut changes QUALITY (and may change entry)", () => {
    const prev = { quality_score: 80, entry_classification: "STARTER", thesis_status: "INTACT" };
    const curr = { quality_score: 72, entry_classification: "STARTER", thesis_status: "DAMAGED" };
    const r = E.classifyChange(prev, curr);
    expect(r.quality_changed).toBe(true);
    expect(r.changes).toContain("QUALITY_DETERIORATION");
    expect(r.changes).toContain("THESIS_DAMAGE");
  });

  it("does not label a price improvement as PRICE_ONLY when quality also moved", () => {
    const prev = { quality_score: 70, entry_classification: "WAIT" };
    const curr = { quality_score: 85, entry_classification: "STARTER" };
    const r = E.classifyChange(prev, curr);
    expect(r.changes).toContain("QUALITY_IMPROVEMENT");
    expect(r.changes).not.toContain("PRICE_ONLY_ENTRY_IMPROVEMENT");
  });

  it("reports NO_MATERIAL_CHANGE when nothing meaningful moved", () => {
    const s = { quality_score: 80, entry_classification: "WAIT", thesis_status: "INTACT" };
    expect(E.classifyChange(s, { ...s })).toEqual(
      expect.objectContaining({ changes: ["NO_MATERIAL_CHANGE"] })
    );
  });
});

describe("§20 portfolio currency conversion", () => {
  it("converts native to base without touching the native value", () => {
    expect(E.convertCurrency(1000, 1.72)).toBe(1720);
    expect(E.convertCurrency(1000, null)).toBeNull();
  });
  it("splits total return into local and FX attribution", () => {
    const r = E.fxAttribution(100, 110, 1.6, 1.7);
    expect(r.local_return).toBeCloseTo(0.1, 5);
    expect(r.fx_return).toBeCloseTo(0.0625, 5);
    expect(r.total_return).toBeCloseTo(0.16875, 5);
  });
});

describe("§25 ranking precedence — hard gates before raw score", () => {
  it("a failed gate ranks below a lower-scoring passing candidate", () => {
    const a = { name: "A", hard_gate_status: "FAIL", quality_score: 95 };
    const b = { name: "B", hard_gate_status: "PASS", quality_score: 60 };
    const ranked = E.rankCandidates([a, b]);
    expect(ranked[0].name).toBe("B");
  });
  it("orders by quality then entry then context among passing candidates", () => {
    const a = { name: "A", hard_gate_status: "PASS", quality_score: 80, entry_score: 50 };
    const b = { name: "B", hard_gate_status: "PASS", quality_score: 80, entry_score: 70 };
    expect(E.rankCandidates([a, b])[0].name).toBe("B");
  });
});

describe("§27 confidence never raises a raw score", () => {
  it("low confidence discounts the effective quality", () => {
    expect(E.confidenceAdjustedQuality(80, "HIGH")).toBe(80);
    expect(E.confidenceAdjustedQuality(80, "LOW")).toBe(60);
    expect(E.confidenceAdjustedQuality(80, "INSUFFICIENT")).toBe(40);
  });
});

describe("§5 valuation helpers", () => {
  it("margin of safety and probability-weighted value", () => {
    expect(E.marginOfSafety(100, 80)).toBe(0.2);
    expect(E.marginOfSafety(0, 80)).toBeNull();
    const v = E.probabilityWeightedValue([
      { probability: 0.2, implied_value_per_share: 50 },
      { probability: 0.5, implied_value_per_share: 100 },
      { probability: 0.3, implied_value_per_share: 150 },
    ]);
    expect(v).toBe(105);
  });
});

describe("§3 Profile B weighted score reports partial assessments honestly", () => {
  it("excludes unknown dimensions and shrinks the weight base", () => {
    const weights = { business_quality: 2, moat: 2, valuation: 1 };
    const full = E.weightedScore({ business_quality: 5, moat: 4, valuation: 3 }, weights);
    expect(full.complete).toBe(true);
    expect(full.score).toBeGreaterThan(0);
    const partial = E.weightedScore({ business_quality: 5, moat: 4 }, weights);
    expect(partial.complete).toBe(false);
    expect(partial.missing).toContain("valuation");
  });
});

describe("§3 / §38.1 framework version immutability", () => {
  it("creates a new version without mutating the base", () => {
    const base = Object.freeze({ id: "fw1", version: 1, weights: Object.freeze({ moat: 2 }) });
    const { previous, next } = V.nextFrameworkVersion(base, { weights: { moat: 3 } }, "fw2");
    expect(next.id).toBe("fw2");
    expect(next.version).toBe(2);
    expect(next.previous_version_id).toBe("fw1");
    expect(next.weights.moat).toBe(3);
    // base untouched
    expect(previous.weights.moat).toBe(2);
    expect(base.weights.moat).toBe(2);
  });
});

describe("§2 / §10 thesis version history", () => {
  it("appends a version, supersedes prior ones, and keeps history", () => {
    const v1 = { id: "t1", version: 1, fundamental_reason: "cheap", main_risk: "debt" };
    const r1 = V.addThesisVersion([], v1, "t1");
    const r2 = V.addThesisVersion(r1.versions, { fundamental_reason: "moat widening", main_risk: "debt" }, "t2");
    expect(r2.versions).toHaveLength(2);
    expect(r2.versions[0].superseded_at).not.toBeNull(); // old one superseded, not deleted
    expect(r2.active.version).toBe(2);
    const diff = V.thesisDiff(r2.versions[0], r2.active);
    expect(diff.fundamental_reason.to).toBe("moat widening");
    expect(diff.main_risk).toBeUndefined(); // unchanged field not in diff
  });
});
