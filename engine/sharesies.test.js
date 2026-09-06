import { describe, it, expect } from "vitest";
import S from "./sharesies.js";

// Small inline fixtures in the exact Sharesies export formats. Real personal CSVs
// are NOT committed; these representative rows exercise the parsing/build logic.

const HOLDINGS_HEADER = "Investment ticker symbol,Investment name,Exchange,Currency,Starting investment dollar value,Ending investment dollar value,Starting share price,Ending share price,Starting shareholding,Ending shareholding,Dollar value of shares purchased (including the value of transferred shares),Dollar value of shares sold (including the value of transferred shares),Greatest number of shares held,Number of shares purchased,Number of shares sold,Number of shares gained through corporate actions,Number of shares disposed of through corporate actions,Dividends and distributions,Transaction fees,Potential additional corporate action impact,Split or consolidation share holding adjustment,NZ withholding tax (NZD),US withholding tax (USD),AU withholding tax (AUD),Foreign withholding tax (USD),Imputation credits (NZD),ADR depositary fees (USD),Is FIF,Portfolio";
const HOLDINGS = [
  HOLDINGS_HEADER,
  // GOOGL — held
  "GOOGL,Alphabet Inc,NASDAQ,USD,0.0000,207.3799,0.0000,382.9700,0,0.54150423,162.3229341466,0,0.54150423,0.54150423,0,0,0,0,3.14385671,False,0,0,0,0,0,0,0,True,Investments",
  // Pathfinder fund — held, ticker 450007, blank exchange (joins by name to txn code 42033)
  "450007,Pathfinder Global Responsibility Fund,,NZD,0.0000,2360.4725,0.0000,2.5038,0,942.756,1005.5099156,0,942.756,942.756,0,0,0,0,0,0,0,0,0,0,0,0,0,False,Investments",
  // INTC — fully sold, ending shareholding 0 -> excluded
  "INTC,Intel Corp,NASDAQ,USD,0.0000,0.0000,0.0000,119.8400,0,0,320.52,488.82,10.73968987,10.73968987,10.73968987,0,0,1.34,10.64,False,0,0.38,0.20,0,0,0,0,True,Investments",
].join("\n");

const TXN_HEADER = "Trade ID,Trade date,Instrument code,Instrument name,Market code,Quantity,Price,Transaction type,Currency,Amount,Transaction fee,Transaction method,Portfolio,Initiated by";
const TXN = [
  TXN_HEADER,
  "id1,2026-03-12 08:00:01.352000 (UTC),GOOGL,Alphabet Inc,NASDAQ,0.52861089,306.320,BUY,usd,161.92408782,3.07655,BUY,Investments,Malcolm",
  "id2,2026-03-30 08:00:01.540000 (UTC),GOOGL,Alphabet Inc,NASDAQ,0.01289334,274.770,BUY,usd,3.54270303,0.06731,BUY,Investments,Malcolm",
  // Pathfinder uses numeric code 42033 in transactions (different from holdings 450007) — joins by name
  "id3,2017-12-10 23:32:26.716947 (UTC),42033,Pathfinder Global Responsibility Fund,FundNZ,475.2400,1.052,BUY,nzd,499.95248,0.00000,BUY,Investments,Malcolm",
].join("\n");

const SUMMARY_HEADER = "Date,NZD Wallet (NZD),USD Wallet (USD),AUD Wallet (AUD),Wallets total (NZD),Save total (NZD),NZ Investments (NZD),AU Investments (AUD),US Investments (USD),Investments total (NZD),FIF cost (NZD)";
const SUMMARY = [
  SUMMARY_HEADER,
  "2017-05-01,0,0,0,0,0,0,0,0,0,0.00",
  "2026-05-23,0.016,0.009,0.009,0.043,0,11692.61,1109.38,7822.42,26406.18,12022.64",
  "2026-05-24,0.016,0.009,0.009,0.043,0,11692.61,1109.38,7822.42,26418.21,12022.64",
].join("\n");

const WALLET_HEADER = "Timestamp,Transaction type,Description,Amount ($),Fee,Currency";
const WALLET = [
  WALLET_HEADER,
  "2026-05-18 13:39:20,Currency exchange,NZD wallet to USD wallet,-861.29352030,4.28504238,NZD",
  "2026-05-18 13:39:20,Currency exchange,NZD wallet to USD wallet,499.27,0,USD",
  "2026-01-06 10:05:00,Currency exchange,AUD wallet to NZD wallet,-149.75128260,0.74503125,AUD",
  "2026-01-06 10:05:00,Currency exchange,AUD wallet to NZD wallet,172.81,0,NZD",
].join("\n");

describe("report detection", () => {
  it("identifies each Sharesies report by its header", () => {
    expect(S.detectReportType(S.parseCsv(HOLDINGS).headers)).toBe("holdings");
    expect(S.detectReportType(S.parseCsv(TXN).headers)).toBe("transactions");
    expect(S.detectReportType(S.parseCsv(SUMMARY).headers)).toBe("summary");
    expect(S.detectReportType(S.parseCsv(WALLET).headers)).toBe("wallet");
    expect(S.detectReportType(["Foo", "Bar"])).toBeNull();
  });
});

describe("csv parsing", () => {
  it("parses to row-objects keyed by header, handling quoted commas", () => {
    const p = S.parseCsv('a,b,c\n1,"x,y",3\n');
    expect(p.objects[0]).toEqual({ a: "1", b: "x,y", c: "3" });
  });
});

describe("mappers", () => {
  it("marketToExchange maps FundNZ/blank to FUNDNZ, else passthrough", () => {
    expect(S.marketToExchange("FundNZ")).toBe("FUNDNZ");
    expect(S.marketToExchange("")).toBe("FUNDNZ");
    expect(S.marketToExchange("NZX")).toBe("NZX");
    expect(S.marketToExchange("nasdaq")).toBe("NASDAQ");
  });
  it("assetType classifies from name/exchange", () => {
    expect(S.assetType("Smart US 500 ETF", "NZX")).toBe("ETF");
    expect(S.assetType("Pathfinder Global Responsibility Fund", "FUNDNZ")).toBe("FUND");
    expect(S.assetType("Smart NZ Core Equity Trust", "FUNDNZ")).toBe("FUND");
    expect(S.assetType("HDFC Bank Ltd (ADR)", "NYSE")).toBe("ADR");
    expect(S.assetType("Alphabet Inc", "NASDAQ")).toBe("STOCK");
  });
  it("avgCost = purchased$ / purchasedShares", () => {
    expect(S.avgCost(162.3229341466, 0.54150423)).toBeCloseTo(299.76, 1);
    expect(S.avgCost(10, 0)).toBeNull();
  });
});

describe("implied FX to NZD from wallet", () => {
  it("computes NZD-per-foreign from paired legs, keeping the latest", () => {
    const fx = S.impliedFxToNzd(S.parseCsv(WALLET).objects);
    expect(fx.rates.USD).toBeCloseTo(861.29352 / 499.27, 3); // ~1.725
    expect(fx.rates.AUD).toBeCloseTo(172.81 / 149.7512826, 3); // ~1.154
  });
});

describe("downsample", () => {
  it("caps length and always keeps the last point", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ date: i, value: i }));
    const ds = S.downsample(pts, 250);
    expect(ds.length).toBeLessThanOrEqual(251);
    expect(ds[ds.length - 1].value).toBe(999);
  });
});

describe("buildImport — full pipeline", () => {
  const input = {
    holdings: S.parseCsv(HOLDINGS).objects,
    transactions: S.parseCsv(TXN).objects,
    summary: S.parseCsv(SUMMARY).objects,
    wallet: S.parseCsv(WALLET).objects,
  };
  const out = S.buildImport(input, { baseCcy: "NZD" });

  it("imports only current holdings (excludes fully-sold INTC)", () => {
    const tickers = out.securities.map((s) => s.ticker).sort();
    expect(tickers).toEqual(["450007", "GOOGL"]);
  });

  it("builds GOOGL with qty, native price, and avg cost", () => {
    const g = out.securities.find((s) => s.ticker === "GOOGL");
    expect(g.exchange).toBe("NASDAQ");
    expect(g.currency).toBe("USD");
    expect(g.asset_type).toBe("STOCK");
    expect(g.holding.quantity).toBeCloseTo(0.54150423, 6);
    expect(g.price.current).toBe(382.97);
    expect(g.price.freshness).toBe("LATEST_REPORTED_PERIOD");
    expect(g.holding.avg_cost).toBeCloseTo(299.76, 1);
    expect(g.holding.fx_rate).toBeCloseTo(1.725, 2); // from wallet USD rate
  });

  it("joins the fund's transactions by NAME despite mismatched codes (42033 vs 450007)", () => {
    const p = out.securities.find((s) => s.ticker === "450007");
    expect(p.exchange).toBe("FUNDNZ");
    expect(p.asset_type).toBe("FUND");
    expect(p.transactions.length).toBe(1);
    expect(p.transactions[0].amount).toBeCloseTo(499.95248, 4);
  });

  it("builds a native price path from transactions + ending price", () => {
    const g = out.securities.find((s) => s.ticker === "GOOGL");
    expect(g.price.history.length).toBeGreaterThanOrEqual(3); // 2 trades + report end
    expect(g.price.history[g.price.history.length - 1].close).toBe(382.97);
  });

  it("produces meta: fx, cash, value history, total", () => {
    expect(out.metaPatch.fx.NZD).toBe(1);
    expect(out.metaPatch.fx.USD).toBeCloseTo(1.725, 2);
    expect(out.metaPatch.investments_total_nzd).toBeCloseTo(26418.21, 2);
    expect(out.metaPatch.portfolio_history.length).toBeGreaterThan(0);
    expect(out.metaPatch.portfolio_history[out.metaPatch.portfolio_history.length - 1].value).toBeCloseTo(26418.21, 2);
    expect(out.metaPatch.cash.NZD).toBeCloseTo(0.016, 3);
  });

  it("captures dividends/fees/FIF from the holdings report", () => {
    const g = out.securities.find((s) => s.ticker === "GOOGL");
    expect(g.sharesies.fif).toBe(true);
    expect(g.sharesies.fees).toBeCloseTo(3.14385671, 5);
  });
});
