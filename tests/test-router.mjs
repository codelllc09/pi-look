/** Router pure-function tests. Bundles look.ts with esbuild first (TS import). */
import { execSync } from "node:child_process";
import assert from "node:assert";
import { join } from "node:path";

const bundle = join(import.meta.dirname, "..", "look.test.bundle.mjs");
execSync(`npx esbuild ${join(import.meta.dirname, "..", "look.ts")} --bundle --format=esm --platform=node --external:@earendil-works/pi-coding-agent --external:typebox --outfile=${bundle}`, { stdio: "pipe" });
const { shouldAutoEscalate } = await import(bundle);

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

console.log("test-router: 5/5 passed");
