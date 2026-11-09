/** Router pure-function tests. Bundles look.ts with esbuild first (TS import). */
import { execSync } from "node:child_process";
import assert from "node:assert";
import { join } from "node:path";

const bundle = join(import.meta.dirname, "..", "look.test.bundle.mjs");
execSync(`npx esbuild ${join(import.meta.dirname, "..", "look.ts")} --bundle --format=esm --platform=node --external:@earendil-works/pi-coding-agent --external:typebox --outfile=${bundle}`, { stdio: "pipe" });
const { shouldAutoEscalate, shouldTierRetry, fmtAnalysis } = await import(bundle);

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
const A = (rows, lines, solidRowBands) => ({ stats: { width: 1, height: 1, theme: "dark", dominantColors: [], estimatedTextRows: rows, solidRowBands }, ocr: { available: true, lines: Array.from({ length: lines }, () => ({ conf: 0.9, text: "x" })), avgConf: 0.9, text: "", tofuCount: 0 } });
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
// Wide rules and cards inflate the projection without adding text rows.
assert.equal(shouldTierRetry(A(6, 0, 6), undefined), false);
assert.equal(shouldTierRetry(A(12, 6, 6), undefined), false);
assert.equal(shouldTierRetry(A(16, 5, 6), undefined), true);
assert.equal(shouldTierRetry({ ...A(20, 0), ocr: { available: false, lines: [] } }, undefined), false);

// ---- fmtAnalysis rendering (batch 3) ----
const AX = {
  stats: { width: 800, height: 300, theme: "dark", dominantColors: [{ hex: "#101014", share: 0.8 }], estimatedTextRows: 5 },
  ocr: {
    available: true, tier: "v6-small",
    columns: 2, cjkShare: 0.61,
    tables: [{ rows: [[0, 1], [2, 3]] }],
    avgConf: 0.9, tofuCount: 0, text: "",
    lines: [
      { conf: 0.99, text: "名称", box: [10, 20, 60, 40], cjk: 1 },
      { conf: 0.98, text: "数值", box: [200, 20, 250, 40], cjk: 1 },
      { conf: 0.99, text: "资金", box: [10, 60, 60, 80], cjk: 1 },
      { conf: 0.97, text: "430", box: [200, 60, 240, 80], cjk: 0 },
      { conf: 0.42, text: "低置信行", box: [10, 120, 90, 140], cjk: 1 },
    ],
  },
};
let out = fmtAnalysis(AX);
// structure + grid render between [stats] and [ocr]
const AST = { stats: { width: 800, height: 600, theme: "dark", dominantColors: [{ hex: "#101014", share: 0.8 }], estimatedTextRows: 5, bg: "#101014", ink: "#e8e8e8", colorfulness: "low", columns: 2, rowGap: 26, rowGapRegular: true, accent: [{ hex: "#ff5c5c", share: 0.03 }], grid: { cols: 4, rows: 2, cells: ["·▒▓R", "▓▓░·"] } }, ocr: { available: true, lines: [], tables: [], avgConf: null, tofuCount: 0, text: "" } };
const sout = fmtAnalysis(AST);
assert.ok(sout.includes("[structure] bg=#101014 ink=#e8e8e8 colorfulness=low accent=#ff5c5c(3%) cols=2 rowGap≈26px(regular)"), sout.split("\n")[1]);
assert.ok(sout.includes("[grid 4x2]\n·▒▓R\n▓▓░·"), sout);
// blobs token renders compactly
const AB = { stats: { width: 800, height: 600, theme: "dark", dominantColors: [], estimatedTextRows: 3, blobs: { count: 24, size: "small", uniform: true, skew: "left" } }, ocr: { available: true, lines: [], tables: [], avgConf: null, tofuCount: 0, text: "" } };
assert.ok(fmtAnalysis(AB).includes("blobs=24 small-uniform left"));
const AB2 = { stats: { width: 800, height: 600, theme: "dark", dominantColors: [], estimatedTextRows: 3, blobs: { count: 1, size: "large", uniform: null, skew: null } }, ocr: { available: true, lines: [], tables: [], avgConf: null, tofuCount: 0, text: "" } };
assert.ok(fmtAnalysis(AB2).includes("blobs=1 large"));
// trivial structure stays silent (no structure/grid lines)
const AMIN = { stats: { width: 800, height: 600, theme: "dark", dominantColors: [], estimatedTextRows: 0 }, ocr: { available: true, lines: [], tables: [], avgConf: null, tofuCount: 0, text: "" } };
const mout = fmtAnalysis(AMIN);
assert.ok(!mout.includes("[structure]"));
assert.ok(!mout.includes("[grid"));

// header carries cjk + cols tags
assert.ok(out.includes("[ocr] 5 lines, avgConf=0.9, cjk=61%, cols=2"), out.split("\n")[1]);
// table rendered as markdown with separator; member lines not duplicated inline
assert.ok(out.includes("| 名称 | 数值 |\n| --- | --- |\n| 资金 | 430 |"), out);
assert.ok(!out.includes("[@10,20→60,40]"), "table line must not repeat inline");
// low-confidence marker on the 0.42 line only
assert.ok(out.includes("低置信行 ⟨0.42⟩"), out);
assert.ok(!out.includes("名称 ⟨"), "0.99 must not carry a marker");
// pipe in cell text is escaped
const AP = { ocr: { available: true, lines: [{ conf: 0.99, text: "a|b" }], tables: [{ rows: [[0, 0]] }], avgConf: 0.99, tofuCount: 0, text: "" } };
assert.ok(fmtAnalysis(AP).includes("| a\\|b |"));
// tier tag only when retry won (tier differs from configured default)
const AT = { ocr: { available: true, tier: "v6-medium", lines: [{ conf: 0.99, text: "x" }], tables: [], avgConf: 0.99, tofuCount: 0, text: "" } };
assert.ok(fmtAnalysis(AT).includes("tier=v6-medium"));
assert.ok(!fmtAnalysis(AT, { visionModel: "x/y", minAutoConf: 0.3, takeover: true, ocrTier: "v6-medium" }).includes("tier="));

console.log("test-router: assertions passed");
