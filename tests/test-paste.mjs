/** Paste attachment and transcript tests. */
import { execSync } from "node:child_process";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, getOsc8LinkAtColumn, setCapabilities, setCellDimensions, stripTerminalSequences } from "@earendil-works/pi-tui";

const bundle = join(import.meta.dirname, "..", "paste.test.bundle.mjs");
execSync(`npx esbuild ${join(import.meta.dirname, "..", "paste.ts")} --bundle --format=esm --platform=node --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-tui --outfile=${bundle}`, { stdio: "pipe" });
const { figureLabelAtColumn, figureViewport, upgradePastePaths, default: registerPaste } = await import(bundle);

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
// A real path in the same message cannot cause a substring elsewhere to be wrapped.
r = upgradePastePaths(`${CLIP}. /var${CLIP} ${CLIP}.bak`, TMP, ok);
assert.equal(r.text, `[image: ${CLIP}]. /var${CLIP} ${CLIP}.bak`);

const hooks = {};
let transform;
const entries = [];
registerPaste({
	on(name, handler) { hooks[name] = handler; },
	registerMarkdownTransformer(fn) { transform = fn; },
	appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
});
const first = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
const second = join(tmpdir(), `pi-look-${randomUUID()}.jpg`);
const historic = { role: "user", content: first };
const live = { role: "user", content: [{ type: "text", text: `See [image: ${second}] and ${first}` }] };
entries.push({ type: "message", message: historic });
const ctx = { mode: "tui", sessionManager: { getEntries: () => entries } };
const user = { messageType: "user" };
await hooks.session_start({}, ctx);
await hooks.message_start({ message: live }, ctx);

setCapabilities({ images: null, trueColor: true, hyperlinks: true });
const rendered = transform(live.content[0].text, user);
assert.equal(stripTerminalSequences(rendered), "See [fig2] and [fig1]");
assert.equal(getOsc8LinkAtColumn(rendered, 4), pathToFileURL(second).href);
assert.equal(getOsc8LinkAtColumn(rendered, 15), pathToFileURL(first).href);
assert.equal(transform(first, { messageType: "assistant" }), first);
assert.equal(live.content[0].text, `See [image: ${second}] and ${first}`);

setCapabilities({ images: null, trueColor: false, hyperlinks: false });
assert.equal(transform(live.content[0].text, user), "See [fig2] and [fig1]");
entries.push({ type: "message", message: live });
await hooks.session_start({}, ctx);
assert.equal(transform(live.content[0].text, user), "See [fig2] and [fig1]");
await hooks.session_start({}, { ...ctx, sessionManager: { getEntries: () => [] } });
assert.equal(transform(first, user), first);
await hooks.message_start({ message: live }, ctx);
assert.equal(transform(live.content[0].text, user), "See [fig1] and [fig2]");

writeFileSync(first, "image bytes", { flag: "wx" });
try {
	const input = { source: "interactive", text: `Check ${first}` };
	assert.equal(await hooks.input(input, { model: { input: ["text"] } }), undefined);
	const vision = await hooks.input(input, { model: { input: ["text", "image"] } });
	assert.equal(vision.text, `Check [image: ${first}]`);
	assert.deepEqual(vision.images, [{ type: "image", mimeType: "image/png", data: Buffer.from("image bytes").toString("base64") }]);
} finally {
	rmSync(first);
}

// The host creates the editor, installs onSubmit, and then restores the draft.
const draftHooks = {};
const draftEntries = [];
let factory;
let draftTransform;
let composed = 0;
let submitted;
const previous = () => {
	composed++;
	return {
		text: "",
		getText() { return this.text; },
		setText(text) { this.text = text; },
		insertTextAtCursor(text) { this.text += text; },
	};
};
registerPaste({
	on(name, handler) { draftHooks[name] = handler; },
	registerMarkdownTransformer(fn) { draftTransform = fn; },
	appendEntry(customType, data) { draftEntries.push({ type: "custom", customType, data }); },
});
const draftCtx = {
	mode: "tui",
	sessionManager: { getEntries: () => draftEntries },
	ui: {
		getEditorComponent: () => previous,
		setEditorComponent(next) { factory = next; },
	},
};
const openDraft = async (text, tui) => {
	await draftHooks.session_start({}, draftCtx);
	const editor = factory(tui);
	editor.onSubmit = (value) => { submitted = value; };
	editor.setText(text);
	return editor;
};
let draft = await openDraft(`See ${first}`);
assert.equal(draft.getText(), "See [fig1]");
draft.insertTextAtCursor(" ");
draft.insertTextAtCursor(second);
assert.equal(draft.getText(), "See [fig1] [fig2]");
assert.equal(draftEntries.length, 2);

// Deleting the first paste and reloading preserves the second number and path.
draft = await openDraft("See [fig2]");
assert.equal(composed, 2);
assert.equal(draft.getText(), "See [fig2]");
assert.deepEqual(await draftHooks.input({ source: "interactive", text: draft.getText() }, { model: { input: ["text"] } }),
	{ action: "transform", text: `See [image: ${second}]` });
assert.equal(await draftHooks.input({ source: "interactive", text: "[fig99]" }, {}), undefined);
assert.equal(await draftHooks.input({ source: "extension", text: "[fig2]" }, {}), undefined);
draft.onSubmit("! cat [fig2]");
assert.equal(submitted, `! cat ${second}`);
draft.setText("! cat ");
draft.insertTextAtCursor(second);
assert.equal(draft.getText(), `! cat ${second}`);

// The native user component places one chip per referenced figure at the end.
initTheme("dark");
const document = new Container();
const chat = new Container();
document.addChild(chat);
await openDraft("", { mode: "regular", children: [document] });
const message = new UserMessageComponent(`See ${first} again ${first} then ${second}`, undefined, 1, [draftTransform]);
chat.addChild(message);
const chipLines = () => message.render(100).map(stripTerminalSequences).filter((line) => line.includes("▧"));
assert.deepEqual(chipLines(), ["  ▧ [fig1]", "  ▧ [fig2]"]);
message.setOutputPad(2);
assert.deepEqual(chipLines(), ["  ▧ [fig1]", "  ▧ [fig2]"]);
await draftHooks.session_shutdown();
assert.deepEqual(chipLines(), []);

const renderedDraft = "\x1b[36m看 [fig1] [fig2]\x1b[0m";
assert.equal(figureLabelAtColumn(renderedDraft, 2), undefined);
assert.deepEqual(figureLabelAtColumn(renderedDraft, 3), { number: 1, column: 3 });
assert.deepEqual(figureLabelAtColumn(renderedDraft, 8), { number: 1, column: 3 });
assert.equal(figureLabelAtColumn(renderedDraft, 9), undefined);
assert.deepEqual(figureLabelAtColumn(renderedDraft, 10), { number: 2, column: 10 });

setCellDimensions({ widthPx: 10, heightPx: 20 });
const picture = { width: 1200, height: 600 };
const center = { x: 0.5, y: 0.5 };
assert.deepEqual(figureViewport(picture, 80, 30, 1, center), {
	cropX: 0, cropY: 0, cropWidth: 1200, cropHeight: 600, columns: 80, rows: 20,
});
assert.deepEqual(figureViewport(picture, 80, 30, 2, center), {
	cropX: 300, cropY: 75, cropWidth: 600, cropHeight: 450, columns: 80, rows: 30,
});
assert.deepEqual(figureViewport(picture, 80, 30, 2, { x: 1, y: 0 }), {
	cropX: 600, cropY: 0, cropWidth: 600, cropHeight: 450, columns: 80, rows: 30,
});

console.log("test-paste: attachment, figure link, and viewer assertions passed");
