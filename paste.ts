/**
 * pi-look paste — rides pi's native Ctrl+V image paste; no third-party chip UI.
 *
 * pi writes pasted clipboard images to /tmp/pi-clipboard-<uuid>.<ext> and
 * inserts the path into the editor (wl-paste / xclip / native clipboard).
 * That path protocol is exactly right for text-only models — they call
 * look(path) themselves, guided by the look tool's prompt guidelines.
 *
 * This extension's single job: for vision models, upgrade those paste paths
 * to real attachments so the model sees the pixels directly. The path text
 * stays in the message (wrapped as "[image: <path>]") so even a vision model
 * can still call look for the exact numbers eyes estimate poorly.
 *
 * Text-only models are never touched here — the path protocol plus look.ts's
 * takeover surfaces own that flow end to end.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	const esc = tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// (?<![\w/]) — the tmpdir path must start a path segment, so /var/tmp/...
	// does not match an inner /tmp/... substring.
	const re = new RegExp(`(?<![\\w/])${esc}/pi-(?:clipboard|look)-[0-9a-f-]{36}\\.(png|jpe?g|webp|gif|bmp)`, "g");
	const found = [...new Set(text.match(re) ?? [])];
	if (!found.length) return undefined;
	const images: { data: string; mimeType: string }[] = [];
	for (const p of found) {
		const mime = MIME_BY_EXT[p.split(".").pop()?.toLowerCase() ?? ""];
		const buf = mime ? read(p) : null;
		if (!buf || !mime) continue;
		images.push({ data: buf.toString("base64"), mimeType: mime });
		const escP = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		text = text.replace(new RegExp(`(?<!\\[image: )${escP}`, "g"), `[image: ${p}]`);
	}
	return images.length ? { text, images } : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		const m = ctx.model;
		if (!m || !Array.isArray(m.input) || !m.input.includes("image")) return; // text-only: path protocol, model routes via look
		const upgraded = upgradePastePaths(event.text, os.tmpdir(), (p) => {
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
