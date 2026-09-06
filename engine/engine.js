/*
 * Tairāwhiti Invest — deterministic engine
 * ----------------------------------------
 * Pure, side-effect-free functions that implement every calculable rule in the
 * build spec (§3, §6, §7, §9, §11, §12, §13, §20, §25, §26, §34). AI never
 * produces these numbers — deterministic code does. This single UMD file is the
 * authoritative source: it is `require`d by the Vitest suite AND pasted verbatim
 * into artifact/app.html so the live app and the tests share one implementation.
 *
 * Design rules honoured here:
 *   - Missing data is a first-class state (null / UNKNOWN), never fabricated (§38.2).
 *   - Quality and entry are computed and reported separately (§4, §38.3).
 *   - A failed hard gate is never rescued by cheap price or good context (§38.4).
 *   - Framework rules are data (weights/gates passed in), never hard-coded totals (§3).
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  var UNKNOWN = "UNKNOWN";

  function isNum(x) {
    return typeof x === "number" && isFinite(x);
  }
  function round(x, dp) {
    if (!isNum(x)) return null;
    var f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round(x * f) / f;
  }
  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  // ---------------------------------------------------------------------------
  // §3.1 Profile A — Core 40-point scorecard
  // Eight categories each scored 1–5. Total 8–40. Bands per spec.
  // ---------------------------------------------------------------------------
  var CORE_CATEGORIES = [
    "quality",
    "valuation",
    "trading_liquidity",
    "underlying_liquidity",
    "capital_flows",
    "macro_liquidity",
    "trend_momentum",
    "risk_control",
  ];

  // Returns { total, band, interpretation, missing:[] }.
  // Missing categories are not scored as 0 — they are reported so the user knows
  // the total is partial rather than a real 40-point assessment.
  function coreScorecardTotal(scores) {
    scores = scores || {};
    var total = 0;
    var missing = [];
    for (var i = 0; i < CORE_CATEGORIES.length; i++) {
      var k = CORE_CATEGORIES[i];
      var v = scores[k];
      if (isNum(v)) total += v;
      else missing.push(k);
    }
    return {
      total: total,
      complete: missing.length === 0,
      missing: missing,
      band: coreScorecardBand(total),
    };
  }

  function coreScorecardBand(total) {
    if (!isNum(total)) return UNKNOWN;
    if (total >= 32) return "STRONG_CANDIDATE";
    if (total >= 26) return "WATCHLIST_OR_STAGED";
    if (total >= 20) return "NEEDS_STRONGER_EVIDENCE";
    return "AVOID_OR_KEEP_SMALL";
  }

  var CORE_BAND_LABELS = {
    STRONG_CANDIDATE: "Strong candidate (32–40)",
    WATCHLIST_OR_STAGED: "Watchlist or staged entry (26–31)",
    NEEDS_STRONGER_EVIDENCE: "Needs stronger evidence (20–25)",
    AVOID_OR_KEEP_SMALL: "Avoid or keep very small (<20)",
    UNKNOWN: "Unknown",
  };

  // §3.1 hard rule: liquidity risk regardless of total score.
  // A high score cannot hide a fragile liquidity profile.
  function liquidityHardFlag(scores) {
    scores = scores || {};
    var t = scores.trading_liquidity;
    var u = scores.underlying_liquidity;
    var flagged = (isNum(t) && t < 2) || (isNum(u) && u < 2);
    return {
      flag: flagged ? "HIGH_LIQUIDITY_RISK" : null,
      trading_liquidity: isNum(t) ? t : null,
      underlying_liquidity: isNum(u) ? u : null,
    };
  }

  // ---------------------------------------------------------------------------
  // §3.1 Profile B — weighted quality/entry overlay.
  // Weights live in the framework version (data, not code). Given per-dimension
  // scores on a 0–5 scale and weights, produce a normalised 0–100 quality score.
  // Dimensions with unknown scores are excluded and the weight base shrinks, so a
  // partial assessment is reported honestly rather than counting missing as zero.
  // ---------------------------------------------------------------------------
  function weightedScore(dimensionScores, weights, maxPerDimension) {
    dimensionScores = dimensionScores || {};
    weights = weights || {};
    var max = maxPerDimension || 5;
    var num = 0;
    var wBase = 0;
    var used = [];
    var missing = [];
    Object.keys(weights).forEach(function (dim) {
      var w = weights[dim];
      if (!isNum(w) || w <= 0) return;
      var s = dimensionScores[dim];
      if (isNum(s)) {
        num += (s / max) * w;
        wBase += w;
        used.push(dim);
      } else {
        missing.push(dim);
      }
    });
    if (wBase === 0) return { score: null, complete: false, used: used, missing: missing };
    return {
      score: round((num / wBase) * 100, 1),
      complete: missing.length === 0,
      used: used,
      missing: missing,
    };
  }

  // ---------------------------------------------------------------------------
  // §26 Hard gates. A single FAIL dominates; REVIEW downgrades; UNKNOWN is not a
  // pass. Deployable only when nothing fails and nothing is unresolved.
  // gates: [{name, status}] status in PASS|REVIEW|FAIL|NOT_APPLICABLE|UNKNOWN
  // ---------------------------------------------------------------------------
  var GATE_STATUSES = ["PASS", "REVIEW", "FAIL", "NOT_APPLICABLE", "UNKNOWN"];

  function hardGateStatus(gates) {
    gates = gates || [];
    var anyFail = false,
      anyReview = false,
      anyUnknown = false,
      counted = 0;
    gates.forEach(function (g) {
      if (!g || g.status === "NOT_APPLICABLE") return;
      counted++;
      if (g.status === "FAIL") anyFail = true;
      else if (g.status === "REVIEW") anyReview = true;
      else if (g.status === "UNKNOWN" || !g.status) anyUnknown = true;
    });
    var overall;
    if (anyFail) overall = "FAIL";
    else if (anyReview) overall = "REVIEW";
    else if (anyUnknown) overall = "UNKNOWN";
    else if (counted === 0) overall = "UNKNOWN";
    else overall = "PASS";
    return { overall: overall, deployable: overall === "PASS", counted: counted };
  }

  // ---------------------------------------------------------------------------
  // §6.4 Market context six-signal timing score. Count FAVOURABLE only.
  // signals: array of 6 values FAVOURABLE|MIXED|UNFAVOURABLE|UNKNOWN
  // ---------------------------------------------------------------------------
  var SIGNAL_VALUES = ["FAVOURABLE", "MIXED", "UNFAVOURABLE", "UNKNOWN"];

  function sixSignalScore(signals) {
    signals = signals || [];
    var favourable = 0,
      known = 0;
    signals.forEach(function (s) {
      if (s === "FAVOURABLE") favourable++;
      if (s && s !== "UNKNOWN") known++;
    });
    return {
      favourable: favourable,
      known: known,
      total: signals.length,
      timing: timingBand(favourable),
    };
  }

  function timingBand(favourable) {
    if (favourable >= 4) return "STRONG_TIMING";
    if (favourable >= 2) return "ACCEPTABLE_CONSERVATIVE_SIZE";
    return "WATCH_WAIT";
  }

  // §6 integration rules: combine business quality (pass/fail-ish) with market
  // context. Market context can improve entry but never rescue a broken business.
  // qualityOk: boolean (hard gates + quality acceptable). favourableSignals: int.
  function marketContextIntegration(qualityOk, favourableSignals) {
    if (!qualityOk) {
      return favourableSignals >= 2
        ? "VALUE_TRAP_OR_TRADING_ONLY"
        : "AVOID";
    }
    if (favourableSignals >= 2) return "STRONGER_ENTRY_CANDIDATE";
    return "WATCHLIST_NOT_CHASE";
  }

  // ---------------------------------------------------------------------------
  // §7 Decision zone (two-axis quality × flows).
  // quality: HIGH|LOW. flows: IMPROVING|DETERIORATING
  // ---------------------------------------------------------------------------
  function decisionZone(quality, flows) {
    var hi = quality === "HIGH";
    var improving = flows === "IMPROVING";
    if (hi && improving) return "BEST";
    if (hi && !improving) return "PATIENCE";
    if (!hi && improving) return "TRADING_ONLY";
    return "AVOID";
  }

  // Map a 0–100 quality score to HIGH/LOW using a configurable threshold.
  function qualityAxis(score, threshold) {
    if (!isNum(score)) return UNKNOWN;
    return score >= (isNum(threshold) ? threshold : 60) ? "HIGH" : "LOW";
  }

  // Map a flow-condition enum (§7 uses improving/deteriorating axis).
  function flowAxis(flowCondition) {
    switch (flowCondition) {
      case "EARLY_POSITIVE_TURN":
      case "STRONG_POSITIVE":
      case "NEGATIVE_STABILISING":
        return "IMPROVING";
      case "NEGATIVE_WORSENING":
        return "DETERIORATING";
      default:
        return "DETERIORATING"; // NEUTRAL treated as not-improving for a cautious default
    }
  }

  // ---------------------------------------------------------------------------
  // §9 Entry bands — membership and crossing detection.
  // A band: { name, lower_bound|null, upper_bound|null, stance }.
  // Convention: a price belongs to a band when lower < price <= upper.
  // lower null = -Infinity, upper null = +Infinity. Bands should be contiguous
  // and ordered; membership returns the FIRST matching band.
  // ---------------------------------------------------------------------------
  function bandContains(band, price) {
    if (!band || !isNum(price)) return false;
    var lo = isNum(band.lower_bound) ? band.lower_bound : -Infinity;
    var hi = isNum(band.upper_bound) ? band.upper_bound : Infinity;
    // lower-exclusive, upper-inclusive; but an open-topped band is inclusive at hi=+Inf
    return price > lo && price <= hi;
  }

  function findBand(bands, price) {
    bands = bands || [];
    for (var i = 0; i < bands.length; i++) {
      if (bandContains(bands[i], price)) return bands[i];
    }
    return null;
  }

  // Detect a crossing given the previously recorded band name and a new price.
  // Returns null when the band is unchanged (no event), else a crossing object.
  function detectBandCrossing(bands, prevBandName, newPrice) {
    var current = findBand(bands, newPrice);
    var currentName = current ? current.name : null;
    if (currentName === prevBandName) return null; // §9.1 event only on band change
    var prev = null;
    if (prevBandName) {
      for (var i = 0; i < bands.length; i++) {
        if (bands[i].name === prevBandName) {
          prev = bands[i];
          break;
        }
      }
    }
    var direction = crossingDirection(prev, current);
    return {
      from: prevBandName || null,
      to: currentName,
      direction: direction, // IMPROVING_ENTRY | DETERIORATING_ENTRY | UNKNOWN
      price: newPrice,
      stance: current ? current.stance || null : null,
    };
  }

  // A lower price is a better (improving) entry. Order bands by lower bound.
  function crossingDirection(prevBand, newBand) {
    if (!prevBand || !newBand) return "UNKNOWN";
    var p = isNum(prevBand.lower_bound) ? prevBand.lower_bound : -Infinity;
    var n = isNum(newBand.lower_bound) ? newBand.lower_bound : -Infinity;
    if (n < p) return "IMPROVING_ENTRY";
    if (n > p) return "DETERIORATING_ENTRY";
    return "UNKNOWN";
  }

  // ---------------------------------------------------------------------------
  // §5 Step 4 — margin of safety & scenario value.
  // ---------------------------------------------------------------------------
  function marginOfSafety(modelledValue, currentPrice) {
    if (!isNum(modelledValue) || modelledValue === 0 || !isNum(currentPrice)) return null;
    return round((modelledValue - currentPrice) / modelledValue, 4);
  }

  // Probability-weighted scenario value. scenarios: [{probability, implied_value_per_share}]
  // Probabilities are normalised so they need not sum to exactly 1.
  function probabilityWeightedValue(scenarios) {
    scenarios = scenarios || [];
    var wsum = 0,
      vsum = 0,
      used = 0;
    scenarios.forEach(function (s) {
      if (isNum(s.probability) && isNum(s.implied_value_per_share)) {
        wsum += s.probability;
        vsum += s.probability * s.implied_value_per_share;
        used++;
      }
    });
    if (used === 0 || wsum === 0) return null;
    return round(vsum / wsum, 2);
  }

  // ---------------------------------------------------------------------------
  // §9 Trend / §13 — daily move detection.
  // ---------------------------------------------------------------------------
  function dailyMovePct(prevClose, price) {
    if (!isNum(prevClose) || prevClose === 0 || !isNum(price)) return null;
    return round((price - prevClose) / prevClose, 4);
  }

  // §13 rule 2: alert on > 5% move in a day. Threshold configurable.
  function isBigDailyMove(prevClose, price, thresholdPct) {
    var m = dailyMovePct(prevClose, price);
    if (m == null) return false;
    var t = isNum(thresholdPct) ? thresholdPct : 0.05;
    return Math.abs(m) > t;
  }

  function drawdownFromHigh(price, high52w) {
    if (!isNum(price) || !isNum(high52w) || high52w === 0) return null;
    return round((price - high52w) / high52w, 4);
  }

  // ---------------------------------------------------------------------------
  // §12.1 Materiality — a 1–5 scale is authored by the user/AI, but the alert
  // threshold decision (>= 3 warrants attention & primary-source check) is a rule.
  // ---------------------------------------------------------------------------
  function materialityWarrantsAlert(materiality, thresh) {
    var t = isNum(thresh) ? thresh : 3;
    return isNum(materiality) && materiality >= t;
  }
  function materialityRequiresPrimarySource(materiality) {
    return isNum(materiality) && materiality >= 3; // §12.2
  }

  // ---------------------------------------------------------------------------
  // §11 / §38.3 Change detection — separate quality from price.
  // Given a previous and current snapshot summary, classify the change(s).
  // snap: { quality_score, entry_classification, thesis_status, price,
  //         framework_version_id }
  // ---------------------------------------------------------------------------
  var CHANGE_TYPES = {
    QUALITY_IMPROVEMENT: "QUALITY_IMPROVEMENT",
    QUALITY_DETERIORATION: "QUALITY_DETERIORATION",
    PRICE_ONLY_ENTRY_IMPROVEMENT: "PRICE_ONLY_ENTRY_IMPROVEMENT",
    PRICE_ONLY_ENTRY_DETERIORATION: "PRICE_ONLY_ENTRY_DETERIORATION",
    THESIS_CONFIRMATION: "THESIS_CONFIRMATION",
    THESIS_DAMAGE: "THESIS_DAMAGE",
    NO_MATERIAL_CHANGE: "NO_MATERIAL_CHANGE",
  };

  // Entry rank ordering, best (cheapest/most attractive) first.
  var ENTRY_RANK = {
    STRONG_ENTRY: 5,
    STARTER: 4,
    ACCEPTABLE: 3,
    PROOF: 3,
    WAIT: 2,
    AVOID_CHASING: 1,
  };
  function entryRank(name) {
    if (name == null) return null;
    var k = String(name).toUpperCase().replace(/[^A-Z]/g, "_");
    return ENTRY_RANK[k] != null ? ENTRY_RANK[k] : null;
  }

  function classifyChange(prev, curr, opts) {
    opts = opts || {};
    var qEps = isNum(opts.qualityEpsilon) ? opts.qualityEpsilon : 1; // ignore trivial score noise
    var changes = [];
    var qualityChanged = false;
    var entryChanged = false;

    // Quality delta
    if (isNum(prev && prev.quality_score) && isNum(curr && curr.quality_score)) {
      var dq = curr.quality_score - prev.quality_score;
      if (dq >= qEps) {
        changes.push(CHANGE_TYPES.QUALITY_IMPROVEMENT);
        qualityChanged = true;
      } else if (dq <= -qEps) {
        changes.push(CHANGE_TYPES.QUALITY_DETERIORATION);
        qualityChanged = true;
      }
    }

    // Thesis status
    if (prev && curr && prev.thesis_status && curr.thesis_status && prev.thesis_status !== curr.thesis_status) {
      if (curr.thesis_status === "DAMAGED" || curr.thesis_status === "BROKEN") {
        changes.push(CHANGE_TYPES.THESIS_DAMAGE);
        qualityChanged = true;
      } else if (curr.thesis_status === "STRENGTHENED" || curr.thesis_status === "CONFIRMED") {
        changes.push(CHANGE_TYPES.THESIS_CONFIRMATION);
        qualityChanged = true;
      }
    }

    // Entry delta (price/valuation driven). Only classify as PRICE_ONLY when
    // quality did NOT change — this is the core "price is not thesis" rule (§38.3).
    var pr = entryRank(prev && prev.entry_classification);
    var cr = entryRank(curr && curr.entry_classification);
    if (pr != null && cr != null && cr !== pr) {
      entryChanged = true;
      if (!qualityChanged) {
        changes.push(
          cr > pr
            ? CHANGE_TYPES.PRICE_ONLY_ENTRY_IMPROVEMENT
            : CHANGE_TYPES.PRICE_ONLY_ENTRY_DETERIORATION
        );
      }
    }

    if (changes.length === 0) changes.push(CHANGE_TYPES.NO_MATERIAL_CHANGE);

    return {
      changes: changes,
      quality_changed: qualityChanged,
      entry_changed: entryChanged,
      // §13 alert taxonomy
      alert_kind: qualityChanged && entryChanged ? "BOTH" : qualityChanged ? "QUALITY_CHANGE" : entryChanged ? "PRICE_ONLY_CHANGE" : null,
    };
  }

  // ---------------------------------------------------------------------------
  // §13.1 Alert deduplication. Each alert has a canonical hash; dedupe within a
  // cooldown window. bandCrossing dedupes per direction; daily-move dedupes per
  // session unless it extends another `stepPct`.
  // ---------------------------------------------------------------------------
  function canonicalAlertHash(alert) {
    // Stable key from the fields that define identity (not the wording).
    var parts = [
      alert.security_key || alert.security_id || "",
      alert.type || "",
      alert.subtype || "",
      alert.direction || "",
      alert.event_hash || "",
      alert.band_to || "",
      alert.session || "",
    ];
    return parts.join("|");
  }

  // existing: array of prior alerts (this session). Returns true if `candidate`
  // is a duplicate that should be suppressed.
  function isDuplicateAlert(candidate, existing, opts) {
    opts = opts || {};
    existing = existing || [];
    var h = canonicalAlertHash(candidate);
    for (var i = 0; i < existing.length; i++) {
      if (canonicalAlertHash(existing[i]) === h) {
        // For daily-move alerts, allow re-alert if the move extended by stepPct.
        if (candidate.type === "DAILY_MOVE" && isNum(candidate.move_pct) && isNum(existing[i].move_pct)) {
          var step = isNum(opts.stepPct) ? opts.stepPct : 0.05;
          if (Math.abs(candidate.move_pct) - Math.abs(existing[i].move_pct) >= step) return false;
        }
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // §20 Currency — store native and converted separately; never overwrite.
  // ---------------------------------------------------------------------------
  function convertCurrency(nativeValue, fxRate) {
    if (!isNum(nativeValue) || !isNum(fxRate)) return null;
    return round(nativeValue * fxRate, 2);
  }

  // FX attribution: split a total return into security (local) and currency parts.
  // Returns fractions. base = reporting currency (e.g. NZD).
  function fxAttribution(startNative, endNative, startFx, endFx) {
    if (![startNative, endNative, startFx, endFx].every(isNum) || startNative === 0 || startFx === 0)
      return null;
    var startBase = startNative * startFx;
    var endBase = endNative * endFx;
    if (startBase === 0) return null;
    var totalReturn = endBase / startBase - 1;
    var localReturn = endNative / startNative - 1;
    var fxReturn = endFx / startFx - 1;
    return {
      total_return: round(totalReturn, 6),
      local_return: round(localReturn, 6),
      fx_return: round(fxReturn, 6),
    };
  }

  // ---------------------------------------------------------------------------
  // §25 Ranking. Precedence: hard gates → quality → entry → context → liquidity
  // → fit → confidence. A failed gate sinks a candidate no matter the raw score.
  // Returns a comparator-friendly sort key (array compared element-wise, desc).
  // ---------------------------------------------------------------------------
  var CONFIDENCE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, INSUFFICIENT: 0 };

  function rankKey(c) {
    c = c || {};
    var gate = c.hard_gate_status;
    // Gate tier: PASS best, then REVIEW/UNKNOWN, FAIL worst. Failed gates cannot
    // be rescued by any downstream score.
    var gateTier = gate === "PASS" ? 2 : gate === "FAIL" ? 0 : 1;
    return [
      gateTier,
      isNum(c.quality_score) ? c.quality_score : -1,
      isNum(c.entry_score) ? c.entry_score : -1,
      isNum(c.market_context_score) ? c.market_context_score : -1,
      // lower liquidity risk ranks higher → invert
      isNum(c.liquidity_risk) ? -c.liquidity_risk : -99,
      isNum(c.portfolio_fit) ? c.portfolio_fit : -1,
      CONFIDENCE_RANK[c.confidence] != null ? CONFIDENCE_RANK[c.confidence] : -1,
    ];
  }

  function compareByRank(a, b) {
    var ka = rankKey(a),
      kb = rankKey(b);
    for (var i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return kb[i] - ka[i]; // descending
    }
    return 0;
  }

  function rankCandidates(candidates) {
    return (candidates || []).slice().sort(compareByRank);
  }

  // §27 Research confidence — lower a high score that rests on weak evidence.
  // Returns an "effective" quality for ranking that never raises the raw score.
  function confidenceAdjustedQuality(qualityScore, confidence) {
    if (!isNum(qualityScore)) return null;
    var factor = { HIGH: 1, MEDIUM: 0.9, LOW: 0.75, INSUFFICIENT: 0.5 }[confidence];
    if (factor == null) factor = 0.75;
    return round(qualityScore * factor, 1);
  }

  return {
    UNKNOWN: UNKNOWN,
    CORE_CATEGORIES: CORE_CATEGORIES,
    CORE_BAND_LABELS: CORE_BAND_LABELS,
    GATE_STATUSES: GATE_STATUSES,
    SIGNAL_VALUES: SIGNAL_VALUES,
    CHANGE_TYPES: CHANGE_TYPES,
    ENTRY_RANK: ENTRY_RANK,
    // scoring
    coreScorecardTotal: coreScorecardTotal,
    coreScorecardBand: coreScorecardBand,
    liquidityHardFlag: liquidityHardFlag,
    weightedScore: weightedScore,
    hardGateStatus: hardGateStatus,
    // market context
    sixSignalScore: sixSignalScore,
    timingBand: timingBand,
    marketContextIntegration: marketContextIntegration,
    decisionZone: decisionZone,
    qualityAxis: qualityAxis,
    flowAxis: flowAxis,
    // entry bands
    bandContains: bandContains,
    findBand: findBand,
    detectBandCrossing: detectBandCrossing,
    crossingDirection: crossingDirection,
    entryRank: entryRank,
    // valuation
    marginOfSafety: marginOfSafety,
    probabilityWeightedValue: probabilityWeightedValue,
    // trend / moves
    dailyMovePct: dailyMovePct,
    isBigDailyMove: isBigDailyMove,
    drawdownFromHigh: drawdownFromHigh,
    // materiality
    materialityWarrantsAlert: materialityWarrantsAlert,
    materialityRequiresPrimarySource: materialityRequiresPrimarySource,
    // change detection
    classifyChange: classifyChange,
    // alerts
    canonicalAlertHash: canonicalAlertHash,
    isDuplicateAlert: isDuplicateAlert,
    // currency
    convertCurrency: convertCurrency,
    fxAttribution: fxAttribution,
    // ranking
    rankKey: rankKey,
    compareByRank: compareByRank,
    rankCandidates: rankCandidates,
    confidenceAdjustedQuality: confidenceAdjustedQuality,
  };
});
