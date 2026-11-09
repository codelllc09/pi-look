/** Takeover pure-function tests. Bundles look.ts with esbuild first (TS import). */
import { execSync } from "node:child_process";
import assert from "node:assert";
import { join } from "node:path";

const bundle = join(import.meta.dirname, "..", "look.takeover.bundle.mjs");
execSync(`npx esbuild ${join(import.meta.dirname, "..", "look.ts")} --bundle --format=esm --platform=node --external:@earendil-works/pi-coding-agent --external:typebox --outfile=${bundle}`, { stdio: "pipe" });
const { imageExtForMime, stripOmissionNote, mergeReadTakeover } = await import(bundle);

// imageExtForMime: common mimes map, unknown/missing fall back to png (inspectable data).
assert.equal(imageExtForMime("image/png"), "png");
assert.equal(imageExtForMime("image/jpeg"), "jpg");
assert.equal(imageExtForMime("image/webp"), "webp");
assert.equal(imageExtForMime("image/gif"), "gif");
assert.equal(imageExtForMime("image/bmp"), "bmp");
assert.equal(imageExtForMime("image/tiff"), "png"); // unsupported → fallback
assert.equal(imageExtForMime(undefined), "png"); // missing → fallback
assert.equal(imageExtForMime("IMAGE/PNG; charset=binary"), "png"); // case + params tolerated
assert.equal(imageExtForMime("IMAGE/JPEG"), "jpg");

// stripOmissionNote: removes the host's omission note lines, keeps factual lines.
const note = "Read image file [image/png]\nresized to 1600x900\n[Current model does not support images. The image will be omitted from this request.]";
assert.equal(stripOmissionNote(note), "Read image file [image/png]\nresized to 1600x900");
assert.equal(stripOmissionNote("[user image omitted: model does not support images]"), "");
assert.equal(stripOmissionNote("plain text survives"), "plain text survives");

// mergeReadTakeover: note + analysis + vlm hint; empty note leaves no leading blank.
const merged = mergeReadTakeover(note, "[stats] 10x10 dark-theme rows≈1");
assert.ok(merged.startsWith("Read image file [image/png]"));
assert.ok(merged.includes("[stats] 10x10 dark-theme rows≈1"));
assert.ok(merged.endsWith(`[hint] semantics needed? call look(path, mode="vlm", question="...")`));
const noNote = mergeReadTakeover("[user image omitted: model does not support images]", "[stats] x");
assert.ok(noNote.startsWith("[stats]"), "no leading blank when the read note is fully stripped");

console.log("test-takeover: 15/15 passed");
