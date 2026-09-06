# Tairāwhiti Invest

A persistent **personal investment research system** — not a trading app. It records
what you believed, the evidence you relied on, what changed, how the framework read the
change, and the price/evidence conditions that now deserve attention. Business **quality**
and entry **price** are always shown separately, and the app is an attention filter, not
another finance-news feed.

Built to run on **free services with no account for you to set up**: it ships as a
[claude.ai Artifact](https://claude.ai/code/artifact/c710d77f-f52a-4df7-880a-67d72d9ae5d7)
that persists your data server-side, installs on your phone, and (optionally) does
AI-assisted interpretation on your own Claude plan — no database to provision, no API key.

**Live app:** https://claude.ai/code/artifact/c710d77f-f52a-4df7-880a-67d72d9ae5d7

> The app is private to your account. Open it, then use your browser's *Add to Home Screen*
> to keep it a tap away on your phone.

---

## Why an Artifact (and the honest trade-off)

The build spec asks for Next.js + Postgres/Supabase + Vercel. That stack is excellent, but
it can't be a *free, persistent, phone-usable live URL* that someone else stands up for you:
a serverless host wipes a SQLite file, and any always-on host needs an account **you** create.
A claude.ai Artifact meets every one of those constraints at once:

| Need | How it's met |
|---|---|
| Free, no account to provision | Hosted on claude.ai; published live from this repo |
| Durable datastore | Built-in `db` capability — a per-account JSON document store |
| On your phone, now | Private published URL, installable |
| AI optional, no paid key | `sample` capability — runs on your own Claude plan, consent-gated |
| Deterministic scores/alerts | A pure JS engine, unit-tested in this repo |

### What works today
- Security master (exchange-aware `EXCHANGE:TICKER` identity), watchlist, portfolio.
- **Versioned framework** — Profile A (40-point scorecard) and Profile B (quality/entry
  overlay). Editing weights creates a **new version**; historical analyses keep the version
  they were scored under (history is never rewritten).
- **Full assessment → immutable snapshot**, with per-dimension score, rationale, confidence,
  hard gates, core scorecard, market context (Temporal / Structural / Irrational + six-signal
  timing), decision zone, and a quality-vs-entry read.
- **Thesis + versions + falsifier gates**; **entry bands** with a band chart and crossing detection.
- **Change detection** separating quality change from price-only entry change.
- **Alerts inbox** — band crossings, >5% daily moves, material events, thesis-gate changes —
  deduplicated, each tagged *quality change / price-only / both* with evidence and a
  `REVIEW / RESEARCH / REASSESS` next step (never an auto-trade).
- **Compare** (ranking respects hard gates before raw score), **Sharesies import**
  (see below) plus a generic CSV mapper, events timeline, monthly-review questions,
  NZD base currency with native values preserved.
- Optional **AI research** (business summary, structural-vs-cyclical, red-team) that
  interprets evidence and **never** sets the deterministic scores.
- **JSON backup export** via the `downloads` capability.

### Sharesies import
Portfolio → **Import from Sharesies** accepts the four Sharesies CSV exports as-is — drop
them all in and each is detected automatically:
- **investment holdings report** → current positions (ending shareholding & price), average
  cost (lifetime purchased $ ÷ shares), dividends, fees, withholding tax, FIF flag.
- **transaction report** → per-security buy/sell history + a native price path.
- **holdings summary report** → portfolio value-over-time chart + current cash.
- **wallet report** → implied FX rates to NZD (editable in Settings).

Only current holdings (ending shareholding > 0) are imported. Instruments are joined across
files by **name** (Sharesies funds carry different codes per report), and current quantity comes
from the holdings report (so corporate actions like rights issues are reflected). Parsing lives
in `engine/sharesies.js` and is unit-tested. A generic column-mapper is available for other brokers.

### What is manual / deferred (the "full-backend roadmap")
An Artifact's sandbox blocks outbound calls to finance/news APIs, so:
- **Prices and company events are entered manually or via CSV import** (freshness is shown
  honestly as *Manual*, never "real-time"). This matches the spec's MockProvider-first,
  "free data may be delayed" philosophy.
- No server-side background jobs / cron, no push notifications, no multi-user row-level security.

These are the only parts that need the full backend. The data model
([`docs/data-model.md`](docs/data-model.md)) and the provider interfaces are shaped so a
later Next.js + Postgres service can adopt them without reshaping data — see the roadmap in
that doc.

---

## Repository layout

```
engine/engine.js        Pure deterministic engine (scoring, bands, moves, change, ranking, currency)
engine/versioning.js    Immutable framework/thesis version helpers (never erase history)
engine/sharesies.js     Sharesies CSV parsing + portfolio reconstruction (pure, tested)
engine/*.test.js        Vitest suites — the spec §34 rule list + Sharesies import
artifact/app.template.html  The app source (HTML + inline React/htm SPA), with an engine marker
artifact/app.html       Built artifact (engine inlined) — this is what gets published
scripts/build-artifact.mjs  Inlines the engine into the template → app.html (no copy/paste drift)
scripts/smoke.mjs       Headless-browser smoke test (mounts the app, loads the worked example)
docs/data-model.md      db collections ↔ spec §21 tables; provider interfaces (§15) and roadmap
```

The deterministic engine is the **single source of truth**: `build-artifact.mjs` inlines
`engine/*.js` verbatim into `app.html`, so the live app and the tests run identical code.

---

## Run locally

```bash
npm install
npm test              # deterministic engine unit tests (spec §34)
npm run build:artifact # regenerate artifact/app.html from the template + engine
npm run smoke         # optional: mount the app in headless Chromium and check it renders
```

Editing rules: change logic in `engine/*.js` (covered by tests) or UI in
`artifact/app.template.html`, then run `npm run build:artifact` before publishing.

## Deploy / update the live app

The app is already published (link above). To ship changes, in a Claude Code session with
this repo: run `npm run build:artifact`, then re-publish `artifact/app.html` to the **same
URL** (the Artifact tool keeps the URL when you republish the same file path, or pass the
URL explicitly from another session).

---

## Verification (Phase 1 acceptance test)

- `npm test` → all deterministic rules pass (40-point bands, liquidity gate, six-signal
  score, entry-band membership + crossing, 5% move, alert dedup, materiality, quality-vs-entry
  delta, framework-version immutability, thesis history, currency conversion).
- In the live app: **Overview → Load worked example** seeds GOOGL, RMD and XRO with a full
  assessment, entry bands and a thesis each. Reload / reopen — everything persists.
- Update RMD's price into the Starter band → one alert is created, old→new band recorded, and
  quality is explicitly shown as unchanged (price-only entry improvement).

## Principles enforced in code
- Missing data is a valid state (`UNKNOWN`) — never fabricated.
- Price is not thesis: quality, price, valuation, market context and thesis are distinct.
- A cheap price or favourable market context can never rescue a failed quality gate.
- Nothing is destructively overwritten — analyses, theses and framework versions are versioned.
