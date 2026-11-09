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
import { CustomEditor, UserMessageComponent, resizeImage, type ExtensionAPI, type ResizedImage } from "@earendil-works/pi-coding-agent";
import {
	Container, Image, Text, getCapabilities, getCellDimensions, getImageDimensions, getOsc8LinkAtColumn, hyperlink,
	matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type EditorComponent,
	type OverlayHandle, type TUI, type TuiAltScreen, type TuiMouseEvent,
} from "@earendil-works/pi-tui";

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

/** Match against the rendered line so ANSI styling and wide characters count correctly. */
export function figureLabelAtColumn(line: string, column: number): { number: number; column: number } | undefined {
	const text = stripTerminalSequences(line);
	for (const match of text.matchAll(FIGURE_LABEL)) {
		const start = visibleWidth(text.slice(0, match.index));
		if (column >= start && column < start + match[0].length) {
			return { number: Number(match[1]), column: start };
		}
	}
}

async function readFigure(path: string, options: Parameters<typeof resizeImage>[2]): Promise<ResizedImage | null> {
	const mime = MIME_BY_EXT[path.split(".").pop() ?? ""];
	const stat = await fs.promises.stat(path);
	// Bound encoded input and decoded pixels before starting Pi's resize worker.
	if (!mime || !stat.isFile() || stat.size > 12 * 1024 * 1024) return null;
	const bytes = await fs.promises.readFile(path);
	if (bytes.length > 12 * 1024 * 1024) return null;
	const size = getImageDimensions(bytes.toString("base64"), mime);
	if (!size || size.widthPx * size.heightPx > 16_000_000) return null;
	return resizeImage(bytes, mime, options);
}

function figureLink(number: number, path: string): string {
	const label = `[fig${number}]`;
	if (!getCapabilities().hyperlinks) return label;
	// BEL survives Markdown's backslash handling, including paths in code spans.
	return hyperlink(`\x1b[4m${label}\x1b[24m`, pathToFileURL(path).href).replaceAll("\x1b\\", "\x07");
}

type CaptureMessageFigures = (render: () => string[], capture: (numbers: number[]) => void) => string[];

function attachTranscriptChips(
	tui: TUI, paths: readonly string[], showImages: () => boolean, captureFigures: CaptureMessageFigures,
): (() => void) | undefined {
	const document = tui?.children?.[0];
	// Pi mounts the chat container after its header and resource list.
	const chat = document instanceof Container ? document.children.at(-1) : undefined;
	if (!(chat instanceof Container)) return;
	const screen = tui as Partial<TuiAltScreen>;
	const supportsImages = () => tui.mode === "fullscreen" && getCapabilities().images === "kitty" &&
		typeof screen.getScreenLines === "function" && showImages();
	const thumbnails = new Map<number, ResizedImage | null>();
	const decorated = new WeakMap<UserMessageComponent, () => void>();
	let active = true;
	let busy = false;
	const schedule = () => {
		if (!active || busy || !supportsImages()) return;
		busy = true;
		// The fullscreen renderer lays out all messages. Read only chips visible in the finished frame.
		queueMicrotask(async () => {
			try {
				if (!active || !supportsImages()) return;
				const visible = new Set<number>();
				for (const line of screen.getScreenLines?.() ?? []) {
					if (!line.includes("▧")) continue;
					const caption = line.split("\x1b_G", 1)[0];
					const match = /^\s*▧ \[fig([1-9]\d*)\]/.exec(stripTerminalSequences(caption));
					if (match) visible.add(Number(match[1]));
				}
				const number = [...visible].find((id) => paths[id - 1] && !thumbnails.has(id));
				if (number === undefined) return;
				if (thumbnails.size >= 64) {
					const oldestOffscreen = [...thumbnails.keys()].find((id) => !visible.has(id));
					if (oldestOffscreen === undefined) return;
					thumbnails.delete(oldestOffscreen);
				}
				const image = await readFigure(paths[number - 1], { maxWidth: 128, maxHeight: 96, maxBytes: 32 * 1024 })
					.catch(() => null);
				if (active) {
					thumbnails.set(number, image);
					tui.requestRender();
				}
			} finally {
				busy = false;
			}
		});
	};
	const decorate = (message: Component) => {
		if (!(message instanceof UserMessageComponent) || decorated.has(message)) return;
		let numbers: number[] = [];
		const images = new Map<number, { data: ResizedImage; component: Image }>();
		const footer: Component = {
			invalidate() {
				for (const { component } of images.values()) component.invalidate();
			},
			render(width) {
				if (numbers.length) schedule();
				return numbers.map((number) => {
					const label = `  ▧ ${figureLink(number, paths[number - 1])}`;
					const available = width - visibleWidth(label) - 2;
					const data = thumbnails.get(number);
					if (!data) images.delete(number);
					if (!data || available < 3 || !supportsImages()) {
						return truncateToWidth(label, width);
					}
					let image = images.get(number);
					if (image?.data !== data) {
						image = { data, component: new Image(data.data, data.mimeType, { fallbackColor: (text) => text }, {
							maxWidthCells: 8, maxHeightCells: 1,
						}) };
						images.set(number, image);
					}
					const line = image.component.render(available)[0];
					return line.startsWith("\x1b_G") ? `${label}  ${line}` : label;
				});
			},
		};
		const render = message.render;
		const withFooter = (width: number) => {
			if (!message.children.includes(footer)) message.addChild(footer);
			return captureFigures(() => render.call(message, width), (next) => { numbers = next; });
		};
		message.render = withFooter;
		message.invalidate();
		decorated.set(message, () => {
			if (message.render === withFooter) message.render = render;
			message.removeChild(footer);
		});
	};
	const originalAdd = chat.addChild;
	const add = (component: Component) => {
		decorate(component);
		originalAdd.call(chat, component);
	};
	chat.addChild = add;
	for (const child of chat.children) decorate(child);
	return () => {
		active = false;
		if (chat.addChild === add) chat.addChild = originalAdd;
		for (const child of chat.children) {
			if (child instanceof UserMessageComponent) decorated.get(child)?.();
		}
		thumbnails.clear();
	};
}

const ZOOM_LEVELS = [1, 1.25, 1.5, 2, 2.5, 3, 4];

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function figureViewport(
	image: Pick<ResizedImage, "width" | "height">, width: number, height: number, zoom: number, center: { x: number; y: number },
) {
	const cell = getCellDimensions();
	const scale = zoom * Math.min(width * cell.widthPx / image.width, height * cell.heightPx / image.height);
	const cropWidth = zoom === 1 ? image.width : clamp(Math.floor(width * cell.widthPx / scale), 1, image.width);
	const cropHeight = zoom === 1 ? image.height : clamp(Math.floor(height * cell.heightPx / scale), 1, image.height);
	return {
		cropX: clamp(Math.round(center.x * image.width - cropWidth / 2), 0, image.width - cropWidth),
		cropY: clamp(Math.round(center.y * image.height - cropHeight / 2), 0, image.height - cropHeight),
		cropWidth,
		cropHeight,
		columns: clamp(Math.round(cropWidth * scale / cell.widthPx), 1, width),
		rows: clamp(Math.round(cropHeight * scale / cell.heightPx), 1, height),
	};
}

function figureViewer(tui: TUI, number: number, close: () => void) {
	let image: ResizedImage | null | undefined;
	let component: Image | undefined;
	let zoomLevel = 0;
	let center = { x: 0.5, y: 0.5 };
	let viewport: ReturnType<typeof figureViewport> | undefined;
	let bounds: { x: number; y: number; width: number; height: number } | undefined;
	let drag: { x: number; y: number } | undefined;
	let placement: { prefix: string; upload: string; line: string } | undefined;
	const zoomTo = (level: number) => {
		if (!image) return;
		const next = clamp(level, 0, ZOOM_LEVELS.length - 1);
		if (next === zoomLevel) return;
		zoomLevel = next;
		if (next === 0) center = { x: 0.5, y: 0.5 };
		tui.requestRender();
	};
	const pan = (dx: number, dy: number) => {
		if (!zoomLevel || !viewport || !image) return;
		const { cropWidth, cropHeight, columns, rows } = viewport;
		const offset = (position: number, delta: number, pixels: number, crop: number, cells: number) => {
			const min = crop / 2;
			const max = pixels - min;
			return clamp(clamp(position * pixels, min, max) + delta * crop / cells, min, max) / pixels;
		};
		center = {
			x: offset(center.x, dx, image.width, cropWidth, columns),
			y: offset(center.y, dy, image.height, cropHeight, rows),
		};
		tui.requestRender();
	};
	const panel: Component = {
		invalidate: () => component?.invalidate(),
		handleInput(data) {
			if (matchesKey(data, "escape")) close();
			else if (matchesKey(data, "+") || matchesKey(data, "=")) zoomTo(zoomLevel + 1);
			else if (matchesKey(data, "-")) zoomTo(zoomLevel - 1);
			else if (matchesKey(data, "0")) zoomTo(0);
			else if (matchesKey(data, "left")) pan(-4, 0);
			else if (matchesKey(data, "right")) pan(4, 0);
			else if (matchesKey(data, "up")) pan(0, -2);
			else if (matchesKey(data, "down")) pan(0, 2);
		},
		handleMouse(event) {
			const inside = bounds && event.x >= bounds.x && event.y >= bounds.y &&
				event.x < bounds.x + bounds.width && event.y < bounds.y + bounds.height;
			if (event.type === "wheel" && event.wheelDelta) zoomTo(zoomLevel + (event.wheelDelta < 0 ? 1 : -1));
			else if (event.type === "press" && event.button === "left" && inside) drag = { x: event.x, y: event.y };
			else if (event.type === "drag" && drag) {
				pan(drag.x - event.x, drag.y - event.y);
				drag = { x: event.x, y: event.y };
			} else if (event.type === "release") drag = undefined;
			else if (event.type === "click" && event.button === "left" && !inside) close();
			return { handled: true, render: false };
		},
		render(width) {
			const rows = Math.max(1, tui.terminal.rows);
			const lines = Array<string>(rows).fill("");
			const size = image ? ` · ${image.originalWidth}×${image.originalHeight}` : "";
			lines[0] = truncateToWidth(`Image [fig${number}]${size} · ${ZOOM_LEVELS[zoomLevel] * 100}% · Esc to close`, width);
			bounds = undefined;
			viewport = undefined;
			if (rows < 4) return lines;
			if (!image) {
				lines[Math.floor(rows / 2)] = truncateToWidth(image === null ? "Image unavailable" : "Loading image…", width);
				return lines;
			}
			component ??= new Image(image.data, image.mimeType, { fallbackColor: (text) => text });
			const nativeImage = component.render(40)[0];
			const header = /^\x1b_G([^;]*);/.exec(nativeImage);
			if (!header) {
				lines[Math.floor(rows / 2)] = truncateToWidth(nativeImage, width);
				return lines;
			}
			viewport = figureViewport(image, Math.max(1, width - 2), rows - 3, ZOOM_LEVELS[zoomLevel], center);
			const { cropX, cropY, cropWidth, cropHeight, columns, rows: imageRows } = viewport;
			const x = Math.floor((width - columns) / 2);
			const y = Math.floor((rows - imageRows) / 2);
			// Keep the native Image upload and ID. Pi's compositor can reuse it for each cropped placement.
			const controls = header[1].replace(/,[cr]=\d+/g, "");
			const prefix = " ".repeat(x) +
				`\x1b_G${controls},c=${columns},r=${imageRows},x=${cropX},y=${cropY},w=${cropWidth},h=${cropHeight};`;
			if (placement?.prefix !== prefix || placement.upload !== nativeImage) {
				placement = { prefix, upload: nativeImage, line: prefix + nativeImage.slice(header[0].length) };
			}
			lines[y] = placement.line;
			lines[rows - 1] = truncateToWidth("Wheel / +/- Zoom   0 Fit   Drag / arrows Pan", width);
			bounds = { x, y, width: columns, height: imageRows };
			return lines;
		},
	};
	return { panel, setImage: (result: ResizedImage | null) => { image = result; } };
}

function attachFigurePreview(
	editor: EditorComponent, tui: TUI, paths: readonly string[], showImages: () => boolean,
) {
	// getScreenLines is a public API of Pi's fullscreen renderer.
	const screen = tui as Partial<TuiAltScreen>;
	if (!screen) return;
	const supported = () => tui.mode === "fullscreen" && getCapabilities().images === "kitty" &&
		typeof screen.getScreenLines === "function";
	const figureAt = (column: number, row: number, transcript: boolean) => {
		const line = screen.getScreenLines?.()[row] ?? "";
		const hit = figureLabelAtColumn(line, column);
		const path = hit && paths[hit.number - 1];
		if (!hit || !path) return;
		if (transcript && getOsc8LinkAtColumn(line, column) !== pathToFileURL(path).href) return;
		return { ...hit, row, path, transcript };
	};
	let hovered: ReturnType<typeof figureAt>;
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let overlay: OverlayHandle | undefined;
	let viewer: OverlayHandle | undefined;
	let pressedFigure: (NonNullable<typeof hovered> & { x: number }) | undefined;
	let cached: { path: string; image: ResizedImage } | undefined;
	let loading = Promise.resolve();

	const dismiss = () => {
		hovered = undefined;
		clearTimeout(openTimer);
		clearTimeout(idleTimer);
		overlay?.hide();
		overlay = undefined;
	};
	const show = async (target: NonNullable<typeof hovered>) => {
		const stillHere = () => hovered === target && supported() && showImages() && !tui.hasOverlay() &&
			figureAt(target.column, target.row, target.transcript)?.path === target.path;
		if (!stillHere()) return;
		const image = cached?.path === target.path ? cached.image : await readFigure(target.path, {
			maxWidth: 384, maxHeight: 240, maxBytes: 256 * 1024,
		});
		if (!image || !stillHere()) return;
		cached = { path: target.path, image };

		const { columns, rows } = tui.terminal;
		const width = Math.min(40, columns);
		const above = target.row;
		const below = rows - target.row - 1;
		const available = Math.max(above, below);
		if (width < 12 || available < 3) return;
		const panel = new Container();
		panel.addChild(new Text(`[fig${target.number}] · ${image.originalWidth}×${image.originalHeight}`, 0, 0));
		panel.addChild(new Image(image.data, image.mimeType, { fallbackColor: (text) => text }, {
			maxHeightCells: Math.min(10, available - 1),
		}));
		const height = panel.render(width).length;
		overlay = tui.showOverlay(panel, {
			width,
			row: above >= below ? above - height : target.row + 1,
			col: Math.min(target.column, columns - width),
			nonCapturing: true,
			visible: (w, h) => w === columns && h === rows,
		});
	};
	const closeViewer = () => {
		viewer?.hide();
		viewer = undefined;
	};
	const openViewer = (target: NonNullable<typeof hovered>) => {
		const { panel, setImage } = figureViewer(tui, target.number, closeViewer);
		const handle = tui.showOverlay(panel, { width: "100%" });
		viewer = handle;
		loading = loading.then(async () => {
			if (viewer !== handle) return;
			const image = await readFigure(target.path, {
				maxWidth: 1920, maxHeight: 1440, maxBytes: 2 * 1024 * 1024,
			}).catch(() => null);
			if (viewer !== handle) return;
			setImage(image);
			tui.requestRender();
		});
	};
	const observe = (event: TuiMouseEvent, transcript: boolean) => {
		const target = event.type === "move" && supported()
			? figureAt(event.screenX, event.screenY, transcript) : undefined;
		if (!target) {
			dismiss();
			return;
		}
		if (hovered?.path !== target.path || hovered.row !== target.row ||
			hovered.column !== target.column || hovered.transcript !== transcript) {
			dismiss();
			hovered = target;
			openTimer = setTimeout(() => {
				// Serialize resizes. Stale requests bail out before reading or displaying.
				loading = loading.then(() => show(target)).catch(() => {});
			}, 250);
		}
		clearTimeout(idleTimer);
		// Pi dispatches moves inside the owning component only. Expire on idle.
		idleTimer = setTimeout(dismiss, 3_000);
	};

	// Pi mounts its transcript document as the first top-level component.
	// Keep Pi's selection and scrolling. Intercept only the release of a figure click.
	const document = tui.children?.[0];
	let detachTranscript: (() => void) | undefined;
	if (document instanceof Container) {
		const documentMouse = document.handleMouse;
		const transcriptMouse: typeof documentMouse = (event) => {
			observe(event, true);
			const pressed = pressedFigure;
			pressedFigure = undefined;
			const { screenX, screenY } = event;
			if ((event.type === "press" || (event.type === "release" && pressed)) &&
				!event.shift && !event.alt && !event.ctrl && supported() && showImages() && !tui.hasOverlay() &&
				typeof screen.resetTextSelection === "function") {
				if (event.type === "press" && event.button === "left") {
					const figure = figureAt(screenX, screenY, true);
					if (figure) pressedFigure = { ...figure, x: screenX };
				} else if (event.type === "release" && pressed?.x === screenX && pressed.row === screenY &&
					(event.button === "left" || event.button === "none") &&
					figureAt(screenX, screenY, true)?.path === pressed.path) {
					screen.resetTextSelection();
					openViewer(pressed);
					return {
						handled: true,
						target: { component: document, originX: screenX - event.x, originY: screenY - event.y,
							width: event.width, height: event.height },
					};
				}
			}
			return documentMouse.call(document, event);
		};
		document.handleMouse = transcriptMouse;
		detachTranscript = () => {
			if (document.handleMouse === transcriptMouse) document.handleMouse = documentMouse;
		};
	}
	const editorMouse = editor.handleMouse;
	const draftMouse = (event: TuiMouseEvent) => {
		pressedFigure = undefined;
		observe(event, false);
		return editorMouse?.call(editor, event);
	};
	editor.handleMouse = draftMouse;
	const editorInput = editor.handleInput;
	const handleInput = (data: string) => {
		dismiss();
		editorInput.call(editor, data);
	};
	editor.handleInput = handleInput;
	return {
		dismiss,
		hasOverlay: () => Boolean(overlay || viewer),
		dispose: () => {
			dismiss();
			closeViewer();
			detachTranscript?.();
			if (editor.handleMouse === draftMouse) editor.handleMouse = editorMouse;
			if (editor.handleInput === handleInput) editor.handleInput = editorInput;
		},
	};
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
	let disposePreview: (() => void) | undefined;
	let captureMessageFigures: ((numbers: number[]) => void) | undefined;
	const withMessageFigures: CaptureMessageFigures = (render, capture) => {
		const previous = captureMessageFigures;
		captureMessageFigures = capture;
		try {
			return render();
		} finally {
			captureMessageFigures = previous;
		}
	};
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
		pi.on("session_shutdown", () => disposePreview?.());
		pi.on("session_start", (_event, ctx) => {
			disposePreview?.();
			disposePreview = undefined;
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
				disposePreview?.();
				const showImages = () => pi.getSettings?.().terminal?.showImages !== false;
				const preview = attachFigurePreview(editor, tui, paths, showImages);
				// Pi composites over text rows. Let our overlays cover the entire message while open.
				const detachChips = attachTranscriptChips(tui, paths, () => showImages() && !preview?.hasOverlay(), withMessageFigures);
				disposePreview = () => {
					preview?.dispose();
					detachChips?.();
				};
				const insert = editor.insertTextAtCursor?.bind(editor);
				if (insert) {
					editor.insertTextAtCursor = (text) => {
						preview?.dismiss();
						const image = findPastePaths(text, references).has(text);
						insert(image && !isCommandDraft(editor.getText()) ? shortenDraft(text) : text);
					};
				}
				const setText = editor.setText.bind(editor);
				let submitWired = false;
				editor.setText = (text) => {
					preview?.dismiss();
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
			const numbers = captureMessageFigures && new Set<number>();
			const rendered = markdown.replace(references, (reference, wrapped, bare) => {
				const path = wrapped ?? bare;
				const number = figures.get(path);
				if (number === undefined) return reference;
				numbers?.add(number);
				return figureLink(number, path);
			});
			if (numbers) captureMessageFigures?.([...numbers]);
			return rendered;
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
