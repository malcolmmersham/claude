/*
 * Tairāwhiti Invest — Sharesies import engine
 * -------------------------------------------
 * Pure, side-effect-free parsing/transform of the four Sharesies CSV exports into
 * the app's security + portfolio shapes. UMD (require'd by tests, inlined into the
 * artifact by scripts/build-artifact.mjs). No DOM, no network.
 *
 * The four reports and how they are used:
 *   - investmentholdingsreport  -> current holdings (qty, native price, avg cost,
 *                                  dividends/fees/tax/FIF). Source of truth for qty.
 *   - transactionreport         -> per-instrument BUY/SELL history + a native price path.
 *   - holdingssummaryreport     -> daily portfolio value (NZD) + current wallet cash.
 *   - wallet_report             -> implied FX rates to NZD (only FX movements exist there).
 *
 * Two realities honoured here:
 *   - Instruments are joined across files by NAME, not ticker (funds carry different
 *     codes across reports).
 *   - Current quantity comes from the holdings report's Ending shareholding, never a
 *     transaction sum (corporate actions change the count).
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Sharesies = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- primitives ----------------------------------------------------------
  function parseNum(s) {
    if (s == null) return null;
    if (typeof s === "number") return isFinite(s) ? s : null;
    var t = String(s).trim().replace(/,/g, "");
    if (t === "" || t === "-") return null;
    var n = parseFloat(t);
    return isFinite(n) ? n : null;
  }
  function normName(s) {
    return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
  }
  function parseTradeDate(s) {
    // "2017-12-10 23:32:26.716947 (UTC)" | "2026-05-24" -> "YYYY-MM-DD"
    var m = String(s == null ? "" : s).match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  // RFC-4180-ish CSV parser (handles quoted fields with commas and "" escapes).
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQ = false;
    text = String(text == null ? "" : text).replace(/^﻿/, "");
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (c === "\r") { /* ignore */ }
        else field += c;
      }
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    // drop fully-empty trailing rows
    rows = rows.filter(function (r) { return r.length && !(r.length === 1 && r[0].trim() === ""); });
    if (!rows.length) return { headers: [], rows: [], objects: [] };
    var headers = rows[0].map(function (h) { return h.trim(); });
    var body = rows.slice(1);
    var objects = body.map(function (r) {
      var o = {};
      for (var j = 0; j < headers.length; j++) o[headers[j]] = r[j] == null ? "" : r[j].trim();
      return o;
    });
    return { headers: headers, rows: body, objects: objects };
  }

  function detectReportType(headers) {
    var h = (headers || []).map(function (x) { return String(x).toLowerCase().trim(); });
    var has = function (s) { return h.indexOf(s) >= 0; };
    if (has("investment ticker symbol") && has("ending shareholding")) return "holdings";
    if (has("trade id") && has("instrument code")) return "transactions";
    if (has("investments total (nzd)")) return "summary";
    if (h[0] === "timestamp" && has("currency") && (has("amount ($)") || has("amount"))) return "wallet";
    return null;
  }

  function marketToExchange(code) {
    var c = String(code == null ? "" : code).trim();
    if (c === "" || /fund/i.test(c)) return "FUNDNZ";
    return c.toUpperCase();
  }

  function assetType(name, exchange) {
    var n = String(name == null ? "" : name).toLowerCase();
    if (/\(adr\)|\badr\b/.test(n)) return "ADR";
    if (/\betf\b/.test(n)) return "ETF";
    if (/\bfund\b|\btrust\b/.test(n)) return "FUND";
    if (String(exchange).toUpperCase() === "FUNDNZ") return "FUND";
    return "STOCK";
  }

  function avgCost(purchasedDollar, purchasedShares) {
    var d = parseNum(purchasedDollar), s = parseNum(purchasedShares);
    if (d == null || s == null || s === 0) return null;
    return Math.round((d / s) * 1e6) / 1e6;
  }

  // Implied FX to NZD from the wallet report. Groups the two legs of each exchange
  // by (Timestamp + Description); a group with an NZD leg and one foreign leg yields
  // rate[foreign] = |nzd| / |foreign| (NZD per 1 unit of foreign). Keeps the latest.
  function impliedFxToNzd(walletObjects) {
    var groups = {};
    (walletObjects || []).forEach(function (r) {
      var ts = r["Timestamp"], desc = r["Description"];
      var key = ts + "||" + desc;
      (groups[key] = groups[key] || { ts: ts, legs: [] }).legs.push({
        ccy: String(r["Currency"] || "").toUpperCase(),
        amt: Math.abs(parseNum(r["Amount ($)"]) || 0),
      });
    });
    var rates = {}, asOf = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var nzd = g.legs.find(function (l) { return l.ccy === "NZD"; });
      var foreign = g.legs.find(function (l) { return l.ccy !== "NZD"; });
      if (!nzd || !foreign || !foreign.amt) return;
      var rate = nzd.amt / foreign.amt;
      if (!isFinite(rate) || rate <= 0) return;
      if (!asOf[foreign.ccy] || g.ts > asOf[foreign.ccy]) {
        rates[foreign.ccy] = Math.round(rate * 1e6) / 1e6;
        asOf[foreign.ccy] = g.ts;
      }
    });
    return { rates: rates, asOf: asOf };
  }

  function downsample(points, max) {
    max = max || 250;
    if (!points || points.length <= max) return (points || []).slice();
    var step = Math.ceil(points.length / max);
    var out = [];
    for (var i = 0; i < points.length; i += step) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  // ---- orchestrator --------------------------------------------------------
  // input: { holdings, transactions, summary, wallet } — each an array of row-objects
  //        (from parseCsv().objects) or null.
  // opts:  { baseCcy = "NZD" }
  // returns: { securities: [...], metaPatch: {...}, warnings: [...] }
  function buildImport(input, opts) {
    input = input || {};
    opts = opts || {};
    var base = (opts.baseCcy || "NZD").toUpperCase();
    var warnings = [];

    var fx = impliedFxToNzd(input.wallet || []);
    var rates = fx.rates || {};
    rates[base] = 1;

    // summary -> portfolio value history + cash + total
    var metaPatch = {};
    if (input.summary && input.summary.length) {
      var pts = [];
      input.summary.forEach(function (r) {
        var v = parseNum(r["Investments total (NZD)"]);
        if (v != null && v > 0) pts.push({ date: r["Date"], value: Math.round(v * 100) / 100 });
      });
      metaPatch.portfolio_history = downsample(pts, 250);
      var last = input.summary[input.summary.length - 1];
      metaPatch.cash = {
        NZD: parseNum(last["NZD Wallet (NZD)"]) || 0,
        USD: parseNum(last["USD Wallet (USD)"]) || 0,
        AUD: parseNum(last["AUD Wallet (AUD)"]) || 0,
      };
      metaPatch.investments_total_nzd = parseNum(last["Investments total (NZD)"]);
      metaPatch.report_end = last["Date"];
    }

    // group transactions by instrument name
    var txByName = {};
    (input.transactions || []).forEach(function (r) {
      var key = normName(r["Instrument name"]);
      (txByName[key] = txByName[key] || []).push({
        date: parseTradeDate(r["Trade date"]),
        type: String(r["Transaction type"] || "").toUpperCase(),
        quantity: parseNum(r["Quantity"]),
        price: parseNum(r["Price"]),
        amount: parseNum(r["Amount"]),
        fee: parseNum(r["Transaction fee"]),
        currency: String(r["Currency"] || "").toUpperCase(),
        trade_id: r["Trade ID"],
        market: r["Market code"],
      });
    });
    Object.keys(txByName).forEach(function (k) {
      txByName[k].sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    });

    var reportEnd = metaPatch.report_end || null;
    var securities = [];

    (input.holdings || []).forEach(function (r) {
      var endShares = parseNum(r["Ending shareholding"]);
      if (endShares == null || endShares <= 0) return; // current holdings only
      var name = r["Investment name"];
      var ticker = String(r["Investment ticker symbol"] || "").trim().toUpperCase();
      var exchange = marketToExchange(r["Exchange"]);
      var currency = String(r["Currency"] || "").toUpperCase() || "NZD";
      var endPrice = parseNum(r["Ending share price"]);
      var tx = txByName[normName(name)] || [];
      // fall back to transaction market/currency when the holdings row lacks them
      if ((!r["Exchange"] || exchange === "FUNDNZ") && tx.length && tx[0].market) exchange = marketToExchange(tx[0].market);
      if (!currency && tx.length) currency = tx[0].currency;

      // native price path from transaction prices + the ending price
      var hist = [];
      tx.forEach(function (t) { if (t.date && t.price != null) hist.push({ date: t.date, close: t.price }); });
      if (reportEnd && endPrice != null) hist.push({ date: reportEnd, close: endPrice });
      hist = dedupeByDate(hist);

      var fxRate = rates[currency] != null ? rates[currency] : (currency === base ? 1 : null);

      securities.push({
        ticker: ticker,
        exchange: exchange,
        name: name,
        currency: currency,
        asset_type: assetType(name, exchange),
        watchlist: false,
        imported: true,
        source: "sharesies",
        price: {
          current: endPrice,
          prev_close: null,
          high52w: null,
          as_of: reportEnd,
          provider: "Sharesies report",
          freshness: "LATEST_REPORTED_PERIOD",
          history: hist,
        },
        holding: {
          quantity: endShares,
          avg_cost: avgCost(r["Dollar value of shares purchased (including the value of transferred shares)"], r["Number of shares purchased"]),
          currency: currency,
          fx_rate: fxRate,
          dividends: parseNum(r["Dividends and distributions"]),
        },
        transactions: tx,
        sharesies: {
          ending_value_native: parseNum(r["Ending investment dollar value"]),
          purchased_value: parseNum(r["Dollar value of shares purchased (including the value of transferred shares)"]),
          purchased_shares: parseNum(r["Number of shares purchased"]),
          sold_shares: parseNum(r["Number of shares sold"]),
          dividends: parseNum(r["Dividends and distributions"]),
          fees: parseNum(r["Transaction fees"]),
          tax_nz: parseNum(r["NZ withholding tax (NZD)"]),
          tax_us: parseNum(r["US withholding tax (USD)"]),
          tax_au: parseNum(r["AU withholding tax (AUD)"]),
          tax_foreign: parseNum(r["Foreign withholding tax (USD)"]),
          imputation: parseNum(r["Imputation credits (NZD)"]),
          adr_fees: parseNum(r["ADR depositary fees (USD)"]),
          fif: /true/i.test(String(r["Is FIF"] || "")),
        },
      });
    });

    // fx meta (NZD per unit foreign)
    var fxMeta = { NZD: 1 };
    Object.keys(rates).forEach(function (c) { fxMeta[c] = rates[c]; });
    metaPatch.fx = fxMeta;
    metaPatch.fx_asof = fx.asOf;
    metaPatch.base_ccy = base;

    return { securities: securities, metaPatch: metaPatch, warnings: warnings };
  }

  function dedupeByDate(hist) {
    var seen = {};
    var out = [];
    hist.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    hist.forEach(function (p) { seen[p.date] = p.close; });
    Object.keys(seen).sort().forEach(function (d) { out.push({ date: d, close: seen[d] }); });
    return out;
  }

  // Convenience: categorise an array of raw CSV texts by detected type.
  function categorise(texts) {
    var out = { holdings: null, transactions: null, summary: null, wallet: null, unknown: [] };
    (texts || []).forEach(function (t) {
      var p = parseCsv(t);
      var type = detectReportType(p.headers);
      if (type) out[type] = p.objects; else out.unknown.push(p.headers.slice(0, 3).join(","));
    });
    return out;
  }

  return {
    parseNum: parseNum,
    normName: normName,
    parseTradeDate: parseTradeDate,
    parseCsv: parseCsv,
    detectReportType: detectReportType,
    marketToExchange: marketToExchange,
    assetType: assetType,
    avgCost: avgCost,
    impliedFxToNzd: impliedFxToNzd,
    downsample: downsample,
    buildImport: buildImport,
    categorise: categorise,
  };
});
