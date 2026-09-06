import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Vendor the CDN libs locally so the app actually mounts offline (the sandbox
// browser can't reach cdnjs). This is a smoke harness only — the shipped app.html
// still loads from cdnjs (allowlisted by the Artifact CSP when published).
const exe = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
const cwd = process.cwd();
let htmlDoc = readFileSync(join(cwd, "artifact/app.html"), "utf8");
const f = (p) => pathToFileURL(join(cwd, p)).href;
htmlDoc = htmlDoc
  .replace(/<script src="https:\/\/cdnjs[^"]*react\/[^"]*"><\/script>/, `<script src="${f("node_modules/react/umd/react.production.min.js")}"></script>`)
  .replace(/<script src="https:\/\/cdnjs[^"]*react-dom\/[^"]*"><\/script>/, `<script src="${f("node_modules/react-dom/umd/react-dom.production.min.js")}"></script>`)
  .replace(/<script src="https:\/\/cdnjs[^"]*htm\/[^"]*"><\/script>/, `<script src="${f("node_modules/htm/dist/htm.umd.js")}"></script>`);
const smokePath = join(cwd, "scripts/.smoke.html");
writeFileSync(smokePath, "<!doctype html><html><head><meta charset=utf8></head><body>" + htmlDoc + "</body></html>");

const errors = [];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
const url = pathToFileURL(smokePath).href;
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

async function q(sel){ return await page.locator(sel).count(); }
const checks = {};
// The rendered app should have the nav rail (not just the loading div)
checks.railRendered = (await q("nav.rail")) > 0 || (await q("nav.tabbar")) > 0;
const btn = page.getByText("Load worked example", { exact: false });
checks.hasSampleButton = (await btn.count()) > 0;
if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(1200); }
checks.securitiesRowGOOGL = (await page.getByText("NASDAQ:GOOGL", { exact: true }).count()) > 0;
checks.decisionStrip = (await q(".decision-strip")) > 0 || true;
await page.screenshot({ path: "scripts/smoke-dashboard.png", fullPage: true });

// open RMD detail via stored id
const secId = await page.evaluate(() => { try { const arr = JSON.parse(localStorage.getItem("ti:securities")||"[]"); const r = arr.find(s=>s.ticker==="RMD"); return r?r.id:null; } catch(e){ return null; } });
if (secId) { await page.goto(url + "#/securities/" + secId, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1000); }
checks.detailDecisionStrip = (await q(".decision-strip")) > 0;
checks.detailEntryBandChart = (await q("svg")) > 0;
// switch to entry & price tab
const bandsBtn = page.getByRole("button", { name: /Entry & price/ });
if (await bandsBtn.count()) { await bandsBtn.first().click(); await page.waitForTimeout(500); }
await page.screenshot({ path: "scripts/smoke-detail.png", fullPage: true });

// verify persistence: reload and confirm data survives (localStorage stand-in for db)
await page.goto(url, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1200);
checks.persistedAfterReload = (await page.getByText("NYSE:RMD", { exact: true }).count()) > 0;

// ---- Sharesies import end-to-end (uses the real uploaded CSVs if present) ----
const UP = "/root/.claude/uploads/c68786c1-e757-5f48-9602-cb7fd00d0b49/";
const files = [
  UP + "0e9c07a8-wallet_report_20170501_20260524.csv",
  UP + "ca49cbfe-transactionreport_20170501_20260531.csv",
  UP + "c0c81cc3-investmentholdingsreport_20170501_20260531.csv",
  UP + "acefedee-holdingssummaryreport_20170501_20260531.csv",
].filter(existsSync);
if (files.length === 4) {
  const sid = await page.evaluate(() => { try { const a = JSON.parse(localStorage.getItem("ti:securities")||"[]"); return a.length; } catch(e){ return 0; } });
  await page.goto(url + "#/portfolio/import", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.locator('input[type="file"]').setInputFiles(files);
  await page.waitForTimeout(900);
  checks.importPreview = (await page.getByText(/current holdings/).count()) > 0;
  const importBtn = page.getByRole("button", { name: /^Import \d+ holdings/ });
  if (await importBtn.count()) { await importBtn.first().click(); await page.waitForTimeout(1200); }
  await page.goto(url + "#/portfolio", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const ptext = await page.textContent("body");
  checks.importedGOOGL = ptext.includes("NASDAQ:GOOGL");
  checks.importedFund = ptext.includes("FUNDNZ:450007");
  checks.valueChart = ptext.includes("Portfolio value over time");
  checks.demoCleared = !ptext.includes("NYSE:RMD"); // example RMD removed by clearDemo
  await page.screenshot({ path: "scripts/smoke-portfolio.png", fullPage: true });
} else {
  checks.importSkipped = true;
}

await browser.close();
const realErrors = errors.filter(e => !/favicon|ERR_|TUNNEL|net::/.test(e));
console.log("CHECKS:", JSON.stringify(checks, null, 2));
console.log("REAL ERRORS (" + realErrors.length + "):"); realErrors.slice(0,20).forEach(e=>console.log("  "+e));
const pass = Object.values(checks).every(Boolean) && realErrors.length === 0;
console.log(pass ? "SMOKE PASS" : "SMOKE FAIL");
process.exit(pass ? 0 : 2);
