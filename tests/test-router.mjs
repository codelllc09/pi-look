/** Router pure-function tests. Bundles look.ts with esbuild first (TS import). */
import { execSync } from "node:child_process";
import assert from "node:assert";
import { join } from "node:path";

const bundle = join(import.meta.dirname, "..", "look.test.bundle.mjs");
execSync(`npx esbuild ${join(import.meta.dirname, "..", "look.ts")} --bundle --format=esm --platform=node --external:@earendil-works/pi-coding-agent --external:typebox --outfile=${bundle}`, { stdio: "pipe" });
const { shouldAutoEscalate, shouldTierRetry } = await import(bundle);

// Objective signal only: empty OCR escalates regardless of confidence floor.
assert.equal(shouldAutoEscalate({ lines: [], avgConf: null }, 0.3), true);
// High confidence text never auto-escalates.
assert.equal(shouldAutoEscalate({ lines: [{ conf: 0.98, text: "x" }], avgConf: 0.98 }, 0.3), false);
// Low confidence escalates at the configured floor.
assert.equal(shouldAutoEscalate({ lines: [{ conf: 0.2, text: "x" }], avgConf: 0.2 }, 0.3), true);
// Exactly at the floor does NOT escalate (strictly-below semantics).
assert.equal(shouldAutoEscalate({ lines: [{ conf: 0.3, text: "x" }], avgConf: 0.3 }, 0.3), false);
// Unknown confidence is treated as escalate (defensive).
assert.equal(shouldAutoEscalate({ lines: [{ conf: 0.9, text: "x" }], avgConf: null }, 0.3), true);

// Tier-retry gate: only the default tier, rows>=4, and lines <= rows/2.
const A = (rows, lines) => ({ stats: { width: 1, height: 1, theme: "dark", dominantColors: [], estimatedTextRows: rows }, ocr: { available: true, lines: Array.from({ length: lines }, () => ({ conf: 0.9, text: "x" })), avgConf: 0.9, text: "", tofuCount: 0 } });
// Dense table missed by det: 20 bands, 5 lines → retry.
assert.equal(shouldTierRetry(A(20, 5), undefined), true);
// 0 lines with text-like bands → retry (photo-latency caveat documented).
assert.equal(shouldTierRetry(A(4, 0), undefined), true);
// Half is the boundary: exactly rows/2 fires (≤ semantics).
assert.equal(shouldTierRetry(A(10, 5), undefined), true);
assert.equal(shouldTierRetry(A(10, 6), undefined), false);
// judge2-like graphics inflation (3 lines vs 5 rows) must NOT fire.
assert.equal(shouldTierRetry(A(5, 3), undefined), false);
// Too few bands → no retry.
assert.equal(shouldTierRetry(A(3, 0), undefined), false);
// Non-default configured tier opts out entirely.
assert.equal(shouldTierRetry(A(20, 5), "v6-medium"), false);
assert.equal(shouldTierRetry(A(20, 5), "v4-mobile"), false);

console.log("test-router: 14/14 passed");
