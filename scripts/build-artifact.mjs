#!/usr/bin/env node
/*
 * Assembles artifact/app.html from artifact/app.template.html by inlining the
 * authoritative engine sources verbatim. This guarantees the live app and the
 * Vitest suite run the exact same deterministic code — no copy/paste drift.
 *
 *   node scripts/build-artifact.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = readFileSync(join(root, "engine/engine.js"), "utf8");
const versioning = readFileSync(join(root, "engine/versioning.js"), "utf8");
const template = readFileSync(join(root, "artifact/app.template.html"), "utf8");

const inlined = `// ==== engine/engine.js (inlined verbatim by build-artifact.mjs) ====\n${engine}\n// ==== engine/versioning.js (inlined verbatim) ====\n${versioning}`;

if (!template.includes("/*__ENGINE_INLINE__*/")) {
  console.error("Marker /*__ENGINE_INLINE__*/ not found in template.");
  process.exit(1);
}
const out = template.replace("/*__ENGINE_INLINE__*/", () => inlined);
writeFileSync(join(root, "artifact/app.html"), out);
console.log(`Wrote artifact/app.html (${out.length} bytes).`);
