# Data model & provider architecture

This documents how Tairāwhiti Invest stores data in the Artifact `db` capability, how those
collections map to the spec's §21 table list, and the provider interfaces (§15) that a future
backend would implement. It exists so a later **Next.js + PostgreSQL** service can adopt the
same shapes without reshaping data.

## Storage backend

The app talks to a small `Store` abstraction (`makeStore()` in `app.template.html`) with two
backends, chosen at runtime:

- **`db`** — the claude.ai Artifact document store (`claude.use("db")`). Durable, per-account,
  survives reloads/republishes/sessions. Used whenever the page runs inside claude.ai.
- **`local`** — `localStorage` fallback, used only in preview/tests where `db` is unavailable.
  The persistence *logic* is identical; only the sink differs.

`db` limits respected: documents are JSON objects (≤256 KiB, ≤32 levels), ≤5,000 docs per
artifact. This app keeps one document per entity in modest collections, well inside those caps.

## Collections (↔ spec §21 tables)

| Collection (`db` path) | Spec §21 tables covered | Notes |
|---|---|---|
| `meta/app` (single doc) | (settings) | base currency, active framework version, alert thresholds, theme, redaction flag, seed flag |
| `securities/{id}` | `securities`, `security_identifiers`, `holdings`, `entry_bands`, `theses`, `thesis_versions`, `thesis_gates`, `watchlist_items` | core record embeds identity, price (+history), entry bands, thesis `{versions[], active}`, gates, holding, and a `latest` summary + bounded `changelog` |
| `snapshots/{id}` | `analysis_runs`, `analysis_snapshots`, `analysis_dimension_results`, `market_context_results` | **immutable**; records `framework_version_id`; created, never updated |
| `framework_versions/{id}` | `frameworks`, `framework_versions`, `framework_dimensions`, `framework_rules` | Profile A + Profile B; weights/gates embedded; superseding, never destructive |
| `events/{id}` | `events` | materiality 1–5, affected dimensions, source tier + verification |
| `alerts/{id}` | `alerts`, `alert_rules`, `notification_deliveries` | deduped via `Engine.canonicalAlertHash` |
| (embedded on security) | `price_bars`, `quotes` | manual/CSV price points as a bounded `price.history[]` |
| (embedded on security) | `sources`, `evidence` | thesis-gate and event `source_url`/tier fields; expandable to first-class collections in the full backend |

Design principles from §21.1 honoured: UUID ids; immutable historical rows for
analyses/thesis/framework versions; `as_of` / `observed_at` / `fetched_at` distinguished from
`updated_at`; source provenance preserved; identity is exchange-aware (`EXCHANGE:TICKER`).

## Immutability & versioning (§3, §38.1)

`engine/versioning.js` provides pure helpers that never mutate inputs:
- `nextFrameworkVersion(base, changes, id)` — new framework version, base untouched.
- `supersede(row)` — stamps `superseded_at` on a copy.
- `addThesisVersion(existing, next, id)` — appends a version, supersedes prior ones, keeps history.
- `thesisDiff(a, b)` — structured field diff for the change log.

## Deterministic engine surface (§34)

`engine/engine.js` (UMD; inlined into the page and `require`d by tests). Key functions:
`coreScorecardTotal`/`coreScorecardBand`, `liquidityHardFlag`, `weightedScore`,
`hardGateStatus`, `sixSignalScore`/`timingBand`/`marketContextIntegration`, `decisionZone`,
`findBand`/`detectBandCrossing`, `marginOfSafety`/`probabilityWeightedValue`,
`dailyMovePct`/`isBigDailyMove`/`drawdownFromHigh`, `materialityWarrantsAlert`,
`classifyChange`, `canonicalAlertHash`/`isDuplicateAlert`, `convertCurrency`/`fxAttribution`,
`rankCandidates`/`confidenceAdjustedQuality`.

## Sharesies import (`engine/sharesies.js`)

Pure, tested module (inlined into the artifact by the build script). `detectReportType`
identifies each of the four Sharesies exports by header signature; `buildImport` reconstructs
the portfolio:

- **Join by name, not ticker** — funds carry different codes across files (Pathfinder is `42033`
  in the transaction report, `450007` in the holdings report), but names are consistent.
- **Ending shareholding is authoritative** for current quantity (corporate actions such as the
  AIR rights issue change the count, so a transaction sum would be wrong).
- Current holdings only (`Ending shareholding > 0`). Average cost = `Dollar value of shares
  purchased ÷ Number of shares purchased` (native). FX to NZD is implied from paired wallet
  exchange rows (latest per currency). Portfolio value history is downsampled from the summary
  report's `Investments total (NZD)`.

Import writes via `AppProvider.bulkImport(built, clearDemo)`: it optionally clears the seeded
demo securities, upserts by `EXCHANGE:TICKER` **preserving** any existing thesis/analysis, and
merges `metaPatch` (`fx`, `cash`, `portfolio_history`, `investments_total_nzd`). Security records
gain `transactions[]`, a `sharesies{}` block (dividends/fees/tax/FIF), and price provenance
(`provider:"Sharesies report"`, `freshness:"LATEST_REPORTED_PERIOD"`). Raw personal CSVs are
never committed; tests use small inline fixtures.

## Provider interfaces (§15) — for the full backend

The Artifact cannot make outbound market/news calls, so today prices/events are manual/CSV.
A future server implements these adapters behind the same UI/data contracts (secrets server-side):

```ts
interface PriceProvider {
  getQuote(security): Promise<Quote>;
  getHistory(security, range): Promise<PriceBar[]>;
}
interface FundamentalsProvider {
  getCompanyProfile(security): Promise<CompanyProfile>;
  getFinancialStatements(security): Promise<FinancialStatementSet>;
  getKeyMetrics(security): Promise<FundamentalMetric[]>;
}
interface FilingProvider { getRecentFilings(security, since): Promise<Filing[]>; }
interface NewsProvider   { getRecentNews(security, since): Promise<NewsItem[]>; }
interface FxProvider     { getRate(base, quote, at?): Promise<FxRate>; }
```

A `MockProvider` (deterministic) is effectively what the manual/CSV entry + `makeHistory`
seed already stand in for. Every displayed datum carries `provider` and `freshness`
(`LIVE|DELAYED|END_OF_DAY|LATEST_REPORTED_PERIOD|STALE|MANUAL|UNKNOWN`); manual entry is
always shown as `MANUAL`, never "real-time".

## Full-backend roadmap (deferred, architected)

1. Stand up Next.js + Postgres (Supabase/Neon free tier) using these collections as tables
   (UUID PKs, immutable snapshot/version rows).
2. Implement `PriceProvider`/`FxProvider` first (e.g. an end-of-day free source) behind the
   interface; keep manual/CSV as a fallback provider.
3. Add background jobs (§23) for price sync, >5% move & band-crossing evaluation, and stale-data
   checks — the deterministic engine already contains the rules they'd call.
4. Add `FilingProvider`/`NewsProvider` + the materiality classifier and primary-source
   verification workflow (§12), then event-triggered partial reassessment (§31 Phase 4).
5. Add push notifications and PWA offline cache (§31 Phase 5).
