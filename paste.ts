/**
 * pi-look paste — rides pi's native Ctrl+V image paste; no third-party chip UI.
 *
 * pi writes pasted clipboard images to /tmp/pi-clipboard-<uuid>.<ext> and
 * inserts the path into the editor (wl-paste / xclip / native clipboard).
 * That path protocol is exactly right for text-only models — they call
 * look(path) themselves, guided by the look tool's prompt guidelines.
 *
 * For vision models, attach the image and keep the path for look().
 * The editor shows [figN] on paste and the input hook resolves it to a path.
 * The user transcript uses the same label with a native file link.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

const FIGURE_ENTRY = "pi-look-figure";
const FIGURE_LABEL = /\[fig([1-9]\d*)\]/g;

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

function isCommandDraft(text: string): boolean {
	const start = text.trimStart();
	return start.startsWith("!") || /^\/[\w:-]+(?:\s|$)/.test(start);
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
	const references = pasteReferences(tmp);
	const figures = new Map<string, number>();
	const paths: string[] = [];
	const remember = (path: string): number => {
		const known = figures.get(path);
		if (known !== undefined) return known;
		const number = paths.push(path);
		figures.set(path, number);
		return number;
	};
	const save = (path: string): number | undefined => {
		if (!figures.has(path)) {
			try {
				pi.appendEntry(FIGURE_ENTRY, path);
			} catch {
				return undefined;
			}
		}
		return remember(path);
	};
	const rememberMessage = (content: string | (ImageContent | { type: "text"; text: string })[], record: (path: string) => void) => {
		const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		for (const path of findPastePaths(text, references)) record(path);
	};
	const shortenDraft = (text: string) => text.replace(references, (reference, wrapped, bare) => {
		const number = save(wrapped ?? bare);
		return number === undefined ? reference : `[fig${number}]`;
	});
	const expandFigures = (text: string, format: (path: string) => string) => text.replace(FIGURE_LABEL, (label, number) => {
		const path = paths[Number(number) - 1];
		return path === undefined ? label : format(path);
	});

	if (typeof pi.registerMarkdownTransformer === "function") {
		pi.on("session_start", (_event, ctx) => {
			figures.clear();
			paths.length = 0;
			if (ctx.mode !== "tui") return;
			// Replay in session order, including draft aliases and other branches.
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === FIGURE_ENTRY && typeof entry.data === "string" &&
					findPastePaths(entry.data, references).has(entry.data)) {
					remember(entry.data);
				} else if (entry.type === "message" && entry.message.role === "user") {
					rememberMessage(entry.message.content, remember);
				}
			}
			if (!ctx.ui?.setEditorComponent) return;
			const previous = ctx.ui.getEditorComponent?.();
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
				const insert = editor.insertTextAtCursor?.bind(editor);
				if (insert) {
					editor.insertTextAtCursor = (text) => {
						const image = findPastePaths(text, references).has(text);
						insert(image && !isCommandDraft(editor.getText()) ? shortenDraft(text) : text);
					};
				}
				const setText = editor.setText.bind(editor);
				let submitWired = false;
				editor.setText = (text) => {
					// Pi installs onSubmit before handing the editor its draft.
					// Commands bypass input hooks, so restore bare paths there.
					const submit = editor.onSubmit?.bind(editor);
					if (!submitWired && submit) {
						editor.onSubmit = (value) => submit(isCommandDraft(value) ? expandFigures(value, (path) => path) : value);
						submitWired = true;
					}
					setText(isCommandDraft(text) ? text : shortenDraft(text));
				};
				return editor;
			});
		});
		pi.on("message_start", (event, ctx) => {
			if (ctx.mode === "tui" && event.message.role === "user") {
				rememberMessage(event.message.content, (path) => save(path) ?? remember(path));
			}
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
		const text = event.source === "interactive" ? expandFigures(event.text, (path) => `[image: ${path}]`) : event.text;
		const expanded = text === event.text ? undefined : { action: "transform" as const, text };
		const m = ctx.model;
		if (!m || !Array.isArray(m.input) || !m.input.includes("image")) return expanded;
		const upgraded = upgradePastePaths(text, tmp, (p) => {
			try {
				return fs.readFileSync(p);
			} catch {
				return null;
			}
		});
		if (!upgraded) return expanded;
		const images: ImageContent[] = [...(event.images ?? []), ...upgraded.images.map((i) => ({ type: "image" as const, ...i }))];
		return { action: "transform", text: upgraded.text, images };
	});
}
