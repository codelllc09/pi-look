/** paste.ts pure-function tests. Bundles paste.ts with esbuild first (TS import). */
import { execSync } from "node:child_process";
import assert from "node:assert";
import { join } from "node:path";

const bundle = join(import.meta.dirname, "..", "paste.test.bundle.mjs");
execSync(`npx esbuild ${join(import.meta.dirname, "..", "paste.ts")} --bundle --format=esm --platform=node --external:@earendil-works/pi-coding-agent --outfile=${bundle}`, { stdio: "pipe" });
const { upgradePastePaths } = await import(bundle);

const TMP = "/tmp";
const U = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const CLIP = `${TMP}/pi-clipboard-${U}.png`;
const LOOK = `${TMP}/pi-look-${U}.jpg`;
const ok = (p) => (p.endsWith(".png") || p.endsWith(".jpg") ? Buffer.from("x") : null);

// Attaches and wraps the path reference.
let r = upgradePastePaths(`check this ${CLIP} please`, TMP, ok);
assert.equal(r.text, `check this [image: ${CLIP}] please`);
assert.equal(r.images.length, 1);
assert.equal(r.images[0].mimeType, "image/png");
assert.equal(r.images[0].data, Buffer.from("x").toString("base64"));

// Both artifact prefixes, dedup of repeated mentions, jpg→image/jpeg.
r = upgradePastePaths(`${LOOK} and ${CLIP} and ${LOOK}`, TMP, ok);
assert.equal(r.images.length, 2);
assert.deepEqual(r.images.map((i) => i.mimeType).sort(), ["image/jpeg", "image/png"]);
assert.equal(r.text.split(`[image: ${LOOK}]`).length - 1, 2, "both occurrences wrapped");

// Unreadable file: no attachment, no transform at all when nothing reads.
assert.equal(upgradePastePaths(CLIP, TMP, () => null), undefined);
// Missing from text: untouched.
assert.equal(upgradePastePaths(`no artifacts here`, TMP, ok), undefined);
// Outside tmpdir or wrong prefix/short-uuid: not matched.
assert.equal(upgradePastePaths(`/var/tmp/pi-clipboard-${U}.png`, TMP, ok), undefined);
assert.equal(upgradePastePaths(`${TMP}/pi-clipboard-short.png`, TMP, ok), undefined);
// Non-image extension of the same prefix: not matched.
assert.equal(upgradePastePaths(`${TMP}/pi-clipboard-${U}.txt`, TMP, ok), undefined);

// Already-wrapped reference is not double-wrapped; bare second occurrence still is.
r = upgradePastePaths(`[image: ${CLIP}] again ${CLIP}`, TMP, ok);
assert.equal(r.text, `[image: ${CLIP}] again [image: ${CLIP}]`);

console.log("test-paste: 9/9 passed");
