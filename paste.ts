/**
 * pi-look paste — rides pi's native Ctrl+V image paste; no third-party chip UI.
 *
 * pi writes pasted clipboard images to /tmp/pi-clipboard-<uuid>.<ext> and
 * inserts the path into the editor (wl-paste / xclip / native clipboard).
 * That path protocol is exactly right for text-only models — they call
 * look(path) themselves, guided by the look tool's prompt guidelines.
 *
 * For vision models, attach the image and keep the path for look().
 * The user transcript renders known paths as [figN] with a native file link
 * when supported. The original message remains available to the model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
};

function pasteReferences(tmp: string): RegExp {
	const escaped = tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Keep an inner /tmp/... or a prefix of a longer filename from matching.
	const path = `(?<![\\w/])${escaped}/pi-(?:clipboard|look)-[0-9a-f-]{36}\\.(?:png|jpe?g|webp|gif|bmp)(?![\\w/]|\\.\\w)`;
	return new RegExp(`\\[image: (${path})\\]|(${path})`, "g");
}

function findPastePaths(text: string, references: RegExp): Set<string> {
	return new Set(Array.from(text.matchAll(references), ([, wrapped, bare]) => wrapped ?? bare));
}

/**
 * Pure: find pi paste artifacts (pi-clipboard-* / pi-look-* in tmpdir) in the
 * text, wrap them as "[image: <path>]" (never double-wrapped), and spec the
 * attachments. read() returning null skips that file — its path stays in the
 * text and the model can still read() it. Returns undefined when nothing
 * attachable was found (no transform). Exported for tests.
 */
export function upgradePastePaths(
	text: string,
	tmp: string,
	read: (p: string) => Buffer | null,
): { text: string; images: { data: string; mimeType: string }[] } | undefined {
	const references = pasteReferences(tmp);
	const attached = new Set<string>();
	const images: { data: string; mimeType: string }[] = [];
	for (const p of findPastePaths(text, references)) {
		const mime = MIME_BY_EXT[p.split(".").pop()?.toLowerCase() ?? ""];
		const buf = mime ? read(p) : null;
		if (!buf || !mime) continue;
		images.push({ data: buf.toString("base64"), mimeType: mime });
		attached.add(p);
	}
	if (!images.length) return undefined;
	text = text.replace(references, (reference, wrapped, bare) =>
		!wrapped && attached.has(bare) ? `[image: ${bare}]` : reference,
	);
	return { text, images };
}

export default function (pi: ExtensionAPI) {
	const tmp = os.tmpdir();
	if (typeof pi.registerMarkdownTransformer === "function") {
		const references = pasteReferences(tmp);
		const figures = new Map<string, number>();
		const remember = (content: string | (ImageContent | { type: "text"; text: string })[]) => {
			const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
			for (const path of findPastePaths(text, references)) {
				if (!figures.has(path)) figures.set(path, figures.size + 1);
			}
		};
		// Read the append order across the whole session, including other
		// branches, so revisiting a branch or reloading doesn't renumber it.
		pi.on("session_start", (_event, ctx) => {
			figures.clear();
			if (ctx.mode !== "tui") return;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "user") remember(entry.message.content);
			}
		});
		pi.on("message_start", (event, ctx) => {
			if (ctx.mode === "tui" && event.message.role === "user") remember(event.message.content);
		});
		pi.registerMarkdownTransformer((markdown, { messageType }) => {
			if (messageType !== "user" || !figures.size) return markdown;
			const links = getCapabilities().hyperlinks;
			return markdown.replace(references, (reference, wrapped, bare) => {
				const path = wrapped ?? bare;
				const number = figures.get(path);
				if (number === undefined) return reference;
				const label = `[fig${number}]`;
				if (!links) return label;
				// BEL keeps the OSC 8 terminator intact through Markdown's
				// backslash handling, including paths inside code spans.
				return hyperlink(`\x1b[4m${label}\x1b[24m`, pathToFileURL(path).href).replaceAll("\x1b\\", "\x07");
			});
		});
	}

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		const m = ctx.model;
		if (!m || !Array.isArray(m.input) || !m.input.includes("image")) return; // text-only: path protocol, model routes via look
		const upgraded = upgradePastePaths(event.text, tmp, (p) => {
			try {
				return fs.readFileSync(p);
			} catch {
				return null;
			}
		});
		if (!upgraded) return;
		const images: ImageContent[] = [...(event.images ?? []), ...upgraded.images.map((i) => ({ type: "image" as const, ...i }))];
		return { action: "transform", text: upgraded.text, images };
	});
}
