/**
 * pi-look — one tool, three lanes, the model is the router.
 *
 *   look(path)              → Lane 0+1 (pixel stats + OCR, local, ~2s) plus a
 *                             hint line. The calling model reads the OCR text
 *                             and decides whether that answered its question.
 *   look(path, mode="vlm",
 *        question="...")    → Lane 2: VLM call with Lane 0+1 output as
 *                             grounding (OCR text anchors the judgment).
 *   look(path, mode="stats"|"ocr") → force a single lane.
 *
 * auto mode only escalates inline on an OBJECTIVE signal (no text found or
 * avgConf < minAutoConf) — intent classification is deliberately absent: the
 * caller is a language model and routes better than any keyword heuristic.
 *
 * Config: <agent-dir>/pi-look.json
 *   { "visionModel": "zai-coding-cn/glm-5.3-flash",   // provider/id, user-set
 *     "pythonPath": "python3",                        // optional, auto-resolved
 *     "minAutoConf": 0.3,
 *     "takeover": true }                              // image takeover for non-vision models
 * API key is read from <agent-dir>/auth.json[provider].key; no key is ever
 * written or logged. Endpoint map is in ENDPOINTS below.
 *
 * Takeover for text-only models (model-driven, zero pre-analysis): when the
 * active model has no vision, pi strips image content into placeholders and
 * read() on an image returns an "omitted" note. pi-look takes over instead —
 *   input        non-vision model + base64 attachments → persist each to
 *                /tmp/pi-look-<uuid>.<ext>, reference the paths in the text,
 *                strip the attachments (kills the omission placeholder). The
 *                model then calls look itself if it wants the content.
 *   tool_result  non-vision model read()s an image (an explicit request) →
 *                serve lane 0+1 analysis in the result, same shape as look's
 *                default output, plus the vlm hint. Nested (codemode) calls
 *                and analyzer failures pass the original result through —
 *                never trade the omission note for an error.
 *
 * Whitebox VLM calls (pi-hear convention): execute() takes the host's
 * (signal, onUpdate). With onUpdate the VLM request streams (SSE) — deltas
 * forward to the host throttled (content-driven ≥2s, heartbeat ≥5s for
 * reasoning models that emit nothing while thinking) and to a pi-taskwatcher
 * footer chip (~/.pi/agent/status/look-<id>.json); without it the request is
 * non-streaming, identical to the legacy behavior. abort kills the fetch
 * (host signal ∧ 180s timeout). A stream that yields no text falls back to
 * one non-streaming retry.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
interface LookConfig {
	visionModel: string; // "provider/model-id"
	pythonPath?: string; // explicit interpreter; auto-resolved otherwise
	minAutoConf: number;
	vlmMaxTokens?: number; // default 8192; reasoning judges burn hidden tokens first
	vlmThinking?: boolean; // default true; false sends thinking:disabled (faster, shallower)
	vlmEndpoints?: Record<string, string>; // provider -> OpenAI-compatible chat endpoint; overrides the built-in fallback map
	takeover?: boolean; // default true; image takeover for non-vision models (persist-to-path + read() relay)
	ocrTier?: string; // analyzer OCR model tier; default "v6-small" (bundled, offline). Others: v6-medium | v5-mobile | v5-server | v4-mobile (download on first use)
	ocrTierRetry?: boolean; // default true; when the default tier finds ≤ half the estimated text rows, retry once with v6-medium
}

const DEFAULTS: LookConfig = {
	visionModel: "zai-coding-cn/glm-5.3-flash",
	minAutoConf: 0.3,
	takeover: true,
};

/** OpenAI-compatible chat endpoints per provider in auth.json. */
const ENDPOINTS: Record<string, string> = {
	"zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
	deepseek: "https://api.deepseek.com/v1/chat/completions",
};

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const expand = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** Tracked so the auto lane never spends a VLM call on a model with its own eyes. */
let currentModel: { provider?: string; id?: string; input?: ("text" | "image")[] } | undefined;
/** The models-store `input` declaration is authoritative — never infer vision from a model name. */
const modelHasVision = (m: { input?: ("text" | "image")[] } | undefined) => Array.isArray(m?.input) && m.input.includes("image");
const visionCapable = () => modelHasVision(currentModel);

function loadConfig(): LookConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(agentDir(), "pi-look.json"), "utf-8"));
		return { ...DEFAULTS, ...raw };
	} catch {
		return { ...DEFAULTS };
	}
}

/** Objective auto-escalation signal: only image-side facts, never intent. */
export function shouldAutoEscalate(ocr: { lines: unknown[]; avgConf: number | null }, minConf: number): boolean {
	if (ocr.lines.length === 0) return true;
	if (ocr.avgConf === null) return true;
	return ocr.avgConf < minConf;
}

function runPython(script: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(expand(script), args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`analyzer exit ${code}: ${err.slice(0, 400)}`))));
		child.on("error", reject);
	});
}

interface Analysis {
	stats?: {
		width: number; height: number; theme: string;
		dominantColors: { hex: string; share: number }[]; estimatedTextRows: number;
		bg?: string; ink?: string | null; colorfulness?: string; gray?: boolean;
		accent?: { hex: string; share: number }[]; columns?: number;
		rowGap?: number; rowGapRegular?: boolean;
		blobs?: { count: number; size?: "small" | "medium" | "large"; uniform?: boolean | null; skew?: "left" | "right" | null } | null;
		grid?: { cols: number; rows: number; cells: string[] };
	};
	ocr?: {
		available: boolean; error?: string; tier?: string;
		lines: { conf: number; text: string; box?: number[]; cjk?: number }[];
		avgConf: number | null; text: string; tofuCount: number;
		columns?: number; cjkShare?: number; tables?: { rows: number[][] }[];
	};
	error?: string;
}

/** Analyzer interpreter: explicit config → central uv venv if present → python3. */
let pyCache: string | undefined;
function resolvePython(cfg: LookConfig): string {
	if (cfg.pythonPath) return expand(cfg.pythonPath);
	if (pyCache === undefined) {
		const venv = path.join(os.homedir(), ".virtualenvs", "main", "bin", "python");
		pyCache = fs.existsSync(venv) ? venv : "python3";
	}
	return pyCache;
}

async function analyze(cfg: LookConfig, imgPath: string, forceTier?: string): Promise<Analysis> {
	const script = path.join(import.meta.dirname, "scripts", "analyze.py");
	const tier = forceTier ?? (cfg.ocrTier && cfg.ocrTier !== "v6-small" ? cfg.ocrTier : undefined); // analyzer defaults to v6-small
	const args = [script, imgPath];
	if (tier) args.push(tier);
	const out = await runPython(resolvePython(cfg), args);
	return JSON.parse(out) as Analysis;
}

/** Narrow weak-signal gate (batch 2, user-ruled 2026-11-09): the default tier
 *  found at most half the row bands the pixel lane estimates — det likely
 *  merged or missed lines (dense tables/documents). Escalate once to
 *  v6-medium. Photos with 0 lines can also fire (documented latency caveat);
 *  a non-default configured tier opts out entirely. Exported for tests. */
export function shouldTierRetry(a: Analysis, configuredTier: string | undefined): boolean {
	if (configuredTier && configuredTier !== "v6-small") return false;
	const rows = a.stats?.estimatedTextRows ?? 0;
	const lines = a.ocr?.lines.length ?? 0;
	if (rows < 4) return false;
	return lines <= Math.floor(rows / 2);
}

/** analyze + one-shot tier escalation; the retry wins only on strictly more
 *  lines, is best-effort (never fails the run), and never re-runs lane 0. */
async function analyzeWithRetry(cfg: LookConfig, imgPath: string): Promise<Analysis> {
	const a = await analyze(cfg, imgPath);
	if (cfg.ocrTierRetry === false || !shouldTierRetry(a, cfg.ocrTier)) return a;
	try {
		const b = await analyze(cfg, imgPath, "v6-medium");
		if ((b.ocr?.lines.length ?? 0) > (a.ocr?.lines.length ?? 0)) return b;
	} catch { /* retry is best-effort — keep the first pass */ }
	return a;
}

/** Analyzer memo (resolved path + mtime + size) — repeat reads (retries, lookups) stay free. Bounded FIFO. */
const analysisCache = new Map<string, { mtimeMs: number; size: number; a: Analysis }>();
async function analyzeCached(cfg: LookConfig, imgPath: string): Promise<Analysis> {
	let st: fs.Stats | undefined;
	try { st = fs.statSync(imgPath); } catch { st = undefined; }
	const hit = analysisCache.get(imgPath);
	if (st && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.a;
	const a = await analyze(cfg, imgPath);
	if (st) {
		if (analysisCache.size >= 32) analysisCache.delete(analysisCache.keys().next().value ?? "");
		analysisCache.set(imgPath, { mtimeMs: st.mtimeMs, size: st.size, a });
	}
	return a;
}

function apiKey(provider: string): string {
	const auth = JSON.parse(fs.readFileSync(path.join(agentDir(), "auth.json"), "utf-8"));
	const key = auth?.[provider]?.key;
	if (typeof key !== "string" || !key) throw new Error(`no API key for provider "${provider}" in auth.json`);
	return key;
}

/** Host progress callback — may be missing (old hosts / nested calls). */
type OnUpdate = (partial: { content: { type: "text"; text: string }[]; details: undefined }) => void;

interface VlmOpts {
	signal?: AbortSignal; // host abort → abort the fetch
	onUpdate?: OnUpdate; // present → stream + progress forwarding
	taskId?: string; // pi-taskwatcher status id; undefined → no status file
	owner?: string; // owning conversation id
}

// pi-taskwatcher status file (~/.pi/agent/status/<id>.json, atomic tmp+rename):
// shows a live footer chip while long VLM calls run. Best-effort only.
const STATUS_DIR = process.env.PI_TASK_STATUS_DIR ?? path.join(os.homedir(), ".pi", "agent", "status");

function writeStatus(id: string, done: number, total: number, note: string, owner?: string): void {
	try {
		fs.mkdirSync(STATUS_DIR, { recursive: true });
		const p = path.join(STATUS_DIR, `${id}.json`);
		fs.writeFileSync(`${p}.tmp`, JSON.stringify({ id, label: "look", done, total, note, ...(owner ? { owner } : {}), updated: Math.floor(Date.now() / 1000) }));
		fs.renameSync(`${p}.tmp`, p);
	} catch { /* footer chip is optional — never fail the run */ }
}

function removeStatus(id: string): void {
	try { fs.rmSync(path.join(STATUS_DIR, `${id}.json`), { force: true }); } catch { /* best-effort */ }
}

/** Consume an OpenAI-compatible SSE body: accumulate deltas, throttled progress. Exported for tests. */
export async function readSSE(res: Response, model: string, opts: VlmOpts, t0: number): Promise<{ text: string; finish: string | undefined }> {
	let text = "", finish: string | undefined;
	let lastPush = 0, pushedLen = 0;
	const push = () => {
		lastPush = Date.now();
		const secs = Math.round((Date.now() - t0) / 1000);
		const note = text ? `vlm streaming ${text.length} chars · ${secs}s` : `vlm waiting for first token · ${secs}s`;
		try {
			opts.onUpdate?.({ content: [{ type: "text", text: `look: ${note} …` }], details: undefined });
			if (opts.taskId) writeStatus(opts.taskId, 0, 0, `${note} · ${model}`, opts.owner);
		} catch { /* progress must never fail the run */ }
	};
	// heartbeat: reasoning judges can think for tens of seconds emitting nothing
	const heart = setInterval(() => { if (Date.now() - lastPush >= 5000) push(); }, 5000);
	heart.unref?.();
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let sep: number;
			while ((sep = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, sep);
				buf = buf.slice(sep + 2);
				for (const raw of frame.split("\n")) {
					const line = raw.replace(/\r$/, "");
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trimStart();
					if (!payload || payload === "[DONE]") continue;
					let j: { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string }> };
					try { j = JSON.parse(payload); } catch { continue; /* skip malformed frame */ }
					const c0 = j.choices?.[0];
					let d = c0?.delta?.content ?? "";
					if (Array.isArray(d)) d = d.map((c: unknown) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? "")).join("");
					if (d) text += String(d);
					if (c0?.finish_reason) finish = c0.finish_reason;
				}
			}
			// first token arriving is itself news (long thinking just ended);
			// afterwards content-driven ≥64 chars/≥2s, heartbeat ≥5s
			if ((pushedLen === 0 && text) || (text.length - pushedLen >= 64 && Date.now() - lastPush >= 2000)) { pushedLen = text.length; push(); }
		}
	} finally {
		clearInterval(heart);
	}
	return { text: text.trim(), finish };
}

export async function callVLM(cfg: LookConfig, question: string, imgPath: string, grounding: string, opts: VlmOpts = {}): Promise<string> {
	const slash = cfg.visionModel.indexOf("/");
	const provider = cfg.visionModel.slice(0, slash);
	const model = cfg.visionModel.slice(slash + 1);
	const endpoint = cfg.vlmEndpoints?.[provider] ?? ENDPOINTS[provider];
	if (!endpoint) throw new Error(`no endpoint for provider "${provider}" — set vlmEndpoints["${provider}"] in pi-look.json`);
	const b64 = fs.readFileSync(imgPath).toString("base64");
	const askOnce = async (maxTokens: number, stream: boolean) => {
		const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens,
		stream,
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: question + `\n\n[protocol] Separate what is VISIBLE in the image from what you INFER. Mark inferences that lack in-image evidence as "(uncertain)" instead of asserting them.` + (grounding ? `\n\n[grounding] Local OCR and pixel stats (may be partial or wrong; trust the image when they conflict):\n${grounding}` : "") },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
				],
			}],
		};
		if (cfg.vlmThinking === false) body.thinking = { type: "disabled" };
		const timeout = AbortSignal.timeout(180_000);
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey(provider)}` },
			body: JSON.stringify(body),
			signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
		});
		if (!res.ok) throw new Error(`VLM ${provider}/${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		if (!stream || !res.body) {
			const out = (await res.json()) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> };
			let content = out.choices?.[0]?.message?.content ?? "";
			if (Array.isArray(content)) content = content.map((c: { text?: string }) => c?.text ?? "").join("");
			return { text: String(content).trim(), finish: out.choices?.[0]?.finish_reason };
		}
		return readSSE(res, cfg.visionModel, opts, Date.now());
	};
	// Reasoning judges can burn the whole budget on hidden thinking: empty body +
	// finish=length means the ANSWER never got tokens — retry once with double.
	if (opts.onUpdate) {
		try { opts.onUpdate({ content: [{ type: "text", text: `look: asking ${cfg.visionModel} …` }], details: undefined }); } catch { /* never fail the run */ }
		if (opts.taskId) writeStatus(opts.taskId, 0, 0, `vlm asking · ${cfg.visionModel}`, opts.owner);
	}
	let budget = cfg.vlmMaxTokens ?? 8192;
	let r = await askOnce(budget, !!opts.onUpdate);
	if (!r.text && r.finish === "length") r = await askOnce((budget *= 2), !!opts.onUpdate);
	// A stream that yielded nothing (endpoint without SSE support?) → one
	// legacy non-streaming attempt before giving up.
	if (!r.text && !r.finish) r = await askOnce(budget, false);
	if (!r.text) throw new Error(`VLM ${provider}/${model} returned empty content (finish=${r.finish})`);
	return r.text;
}

export function fmtAnalysis(a: Analysis, cfg?: LookConfig): string {
	const s = a.stats, o = a.ocr;
	const parts: string[] = [];
	if (s) {
		parts.push(`[stats] ${s.width}x${s.height} ${s.theme}-theme rows≈${s.estimatedTextRows} colors=${s.dominantColors.map((c) => `${c.hex}(${Math.round(c.share * 100)}%)`).join(" ")}`);
		// Structure lane (batch 4): objective pixel facts, appended below the stable header line.
		const st: string[] = [];
		if (s.bg) st.push(`bg=${s.bg}`);
		if (s.ink) st.push(`ink=${s.ink}`);
		if (s.colorfulness) st.push(`colorfulness=${s.colorfulness}`);
		if (s.gray) st.push("grayscale");
		for (const a of s.accent ?? []) st.push(`accent=${a.hex}(${Math.round(a.share * 100)}%)`);
		if (s.columns && s.columns > 1) st.push(`cols=${s.columns}`);
		if (s.rowGap && s.rowGapRegular) st.push(`rowGap≈${s.rowGap}px(regular)`);
		if (s.blobs) st.push(`blobs=${s.blobs.count}${s.blobs.size ? ` ${s.blobs.size}` : ""}${s.blobs.uniform ? "-uniform" : ""}${s.blobs.skew ? ` ${s.blobs.skew}` : ""}`);
		if (st.length) parts.push(`[structure] ${st.join(" ")}`);
		if (s.grid && s.grid.cells.length) parts.push(`[grid ${s.grid.cols}x${s.grid.rows}]\n${s.grid.cells.join("\n")}`);
	}
	if (!o) return parts.join("\n");
	if (!o.available) parts.push(`[ocr] unavailable: ${o.error}`);
	else {
		const defTier = cfg?.ocrTier ?? "v6-small";
		const tierTag = o.tier && o.tier !== defTier ? `, tier=${o.tier}` : ""; // tier retry won
		const cjkTag = o.cjkShare && o.cjkShare > 0 ? `, cjk=${Math.round(o.cjkShare * 100)}%` : "";
		const colsTag = o.columns && o.columns > 1 ? `, cols=${o.columns}` : "";
		parts.push(`[ocr] ${o.lines.length} lines, avgConf=${o.avgConf ?? "n/a"}${tierTag}${cjkTag}${colsTag}${o.tofuCount ? `, tofuMarkers=${o.tofuCount}` : ""}`);
		// Table member lines render as markdown tables below — not repeated inline.
		const inTable = new Set<number>();
		for (const t of o.tables ?? []) for (const row of t.rows) for (const li of row) inTable.add(li);
		o.lines.forEach((l, i) => {
			if (inTable.has(i)) return;
			const at = l.box ? `[@${l.box[0]},${l.box[1]}→${l.box[2]},${l.box[3]}]` : "";
			const low = l.conf < 0.8 ? ` ⟨${l.conf.toFixed(2)}⟩` : "";
			parts.push(`${at} ${l.text}${low}`);
		});
		for (const t of o.tables ?? []) {
			const md = t.rows.map((row, ri) => {
				const cells = row.map((li) => (o.lines[li]?.text ?? "").replace(/\|/g, "\\|"));
				return ri === 0 ? `| ${cells.join(" | ")} |\n|${cells.map(() => " --- ").join("|")}|` : `| ${cells.join(" | ")} |`;
			});
			parts.push(md.join("\n"));
		}
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Takeover helpers (exported for tests)
// ---------------------------------------------------------------------------

/** File extension for an image mime type; png fallback keeps the data inspectable. */
export function imageExtForMime(mimeType: string | undefined): string {
	switch ((mimeType ?? "").split(";")[0].trim().toLowerCase()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		case "image/bmp": return "bmp";
		default: return "png";
	}
}

/** Drop the host's non-vision omission note lines from a read result text; keep factual lines. */
export function stripOmissionNote(text: string): string {
	return text
		.split("\n")
		.filter((l) => !l.includes("does not support images") && !l.includes("will be omitted"))
		.join("\n")
		.trim();
}

/** Compose the takeover replacement for a read-image result — same shape as look's default output. */
export function mergeReadTakeover(readNote: string, analysis: string): string {
	return [stripOmissionNote(readNote), analysis, `[hint] semantics needed? call look(path, mode="vlm", question="...")`]
		.filter(Boolean)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();

	pi.on("session_start", async (_e, ctx) => { currentModel = ctx.model; });
	pi.on("model_select", async (e) => { currentModel = e.model; });

	// Takeover, surface A — non-vision model + base64 attachments: persist each
	// image to /tmp, reference the path in the text, strip the attachment (the
	// host would serialize it into an omission placeholder anyway). Persist
	// failures keep their attachment — nothing is ever lost. The model routes
	// itself: it calls look on the path only if it wants the content.
	pi.on("input", async (event, ctx) => {
		if (!cfg.takeover || event.source === "extension" || modelHasVision(ctx.model ?? currentModel)) return;
		const images = event.images ?? [];
		if (images.length === 0) return;
		const lines: string[] = [];
		const kept: typeof images = [];
		for (const img of images) {
			try {
				const p = path.join(os.tmpdir(), `pi-look-${crypto.randomUUID()}.${imageExtForMime(img.mimeType)}`);
				fs.writeFileSync(p, Buffer.from(img.data, "base64"));
				lines.push(`[image: ${p}]`);
			} catch {
				kept.push(img);
			}
		}
		if (lines.length === 0) return;
		const text = event.text ? `${event.text}\n${lines.join("\n")}` : lines.join("\n");
		return { action: "transform", text, images: kept };
	});

	// Takeover, surface B — a non-vision model read()s an image (explicit
	// request for content): serve lane 0+1 in place of the stripped image block,
	// same shape as look's default output. Nested (codemode) calls expect the
	// image block programmatically — leave them alone. Analyzer failure passes
	// the original result through; the omission note is never traded for an error.
	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.takeover || event.toolName !== "read" || event.parentToolCallId) return;
		if (modelHasVision(ctx.model ?? currentModel)) return; // ctx.model is authoritative at hook time
		if (!Array.isArray(event.content) || !event.content.some((c) => c?.type === "image")) return;
		const raw = typeof event.input?.["path"] === "string" ? String(event.input["path"]) : "";
		if (!raw) return;
		const img = path.resolve(ctx.cwd ?? process.cwd(), expand(raw.replace(/^@/, "")));
		if (!fs.existsSync(img)) return;
		let a: Analysis;
		try { a = await analyzeCached(cfg, img); } catch { return; }
		const note = event.content.find((c) => c.type === "text");
		return { content: [{ type: "text", text: mergeReadTakeover(note && "text" in note ? note.text : "", fmtAnalysis(a, cfg)) }] };
	});

	pi.registerTool({
		name: "look",
		label: "look",
		promptSnippet: "Inspect image files — local pixel stats + OCR, VLM relay on demand",
		promptGuidelines: [
			"When the conversation references an image path and you cannot see images natively, call look(path): local pixel stats and verbatim OCR answer most questions. Add mode=\"vlm\" with a question only when visual semantics are needed.",
		],
		description:
			"Look at an image file through a three-lane pipeline. Useful even if you can already see images: the stats/OCR lanes give EXACT numbers your eyes estimate poorly (dimensions, colors, verbatim text, counts). Default (no mode): pixel stats + local OCR — cheap and local; check whether that answers your question before going further. mode='vlm' with a question: asks a vision model grounded with the local OCR — use for semantics ('what is this', shapes, UIs, likeness), when you cannot see images, or as a second opinion. mode='stats'/'ocr': force one lane. Heavier classical CV (contours, template matching, color segmentation, connected components, etc.) you can always write yourself in bash+python.",
		parameters: Type.Object({
			path: Type.String({ description: "Image file path (png/jpg/webp/bmp)" }),
			mode: Type.Optional(Type.String({ description: "Lane selection: auto (default) | stats | ocr | vlm" })),
			question: Type.Optional(Type.String({ description: "For mode=vlm: what to answer about the image" })),
		}),
		async execute(toolCallId: string, args, signal?: AbortSignal, onUpdate?: OnUpdate, ctx?: { sessionManager?: { getSessionId?: () => string } }) {
			if (!args?.path) return { content: [{ type: "text", text: `path required` }], isError: true, details: undefined };
			const img = expand(String(args.path));
			if (!fs.existsSync(img)) return { content: [{ type: "text", text: `file not found: ${args.path}` }], isError: true, details: undefined };
			const mode = ["auto", "stats", "ocr", "vlm"].includes(String(args.mode)) ? String(args.mode) : "auto";
			// footer progress chip (pi-taskwatcher convention) — only when a host
			// actually watches progress; short ids keep the filename sane
			const short = (toolCallId ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(-8) || Math.random().toString(36).slice(2, 8);
			const taskId = onUpdate && mode !== "stats" && mode !== "ocr" ? `look-${short}` : undefined;
			const vopts: VlmOpts = { signal, onUpdate, taskId, owner: ctx?.sessionManager?.getSessionId?.() };
			try {
				if (mode === "vlm") {
					const a = await analyze(cfg, img);
					const answer = await callVLM(cfg, args.question?.trim() || "Describe this image precisely.", img, fmtAnalysis(a, cfg), vopts);
					if (taskId) writeStatus(taskId, 1, 1, `vlm done · ${answer.length} chars`, vopts.owner);
					return { content: [{ type: "text", text: answer + `\n\n[grounding used]\n${fmtAnalysis(a, cfg).slice(0, 600)}` }], details: undefined };
				}
				// Tier-retry gate serves text extraction (auto/ocr); stats-only and vlm
				// grounding paths skip it (no OCR consumer / vlm has its own eyes).
				const a = mode === "stats" ? await analyze(cfg, img) : await analyzeWithRetry(cfg, img);
				if (mode === "auto" && shouldAutoEscalate(a.ocr ?? { lines: [], avgConf: null }, cfg.minAutoConf)) {
					if (visionCapable()) {
						// Never spend a VLM call on a model with its own eyes (explicit mode=vlm still allowed).
						return { content: [{ type: "text", text: fmtAnalysis(a, cfg) + `\n\n[hint] OCR found little; you have vision — inspect the image yourself, or call look(path, mode="vlm", question="...") for a second opinion.` }], details: undefined };
					}
					const answer = await callVLM(cfg, args.question?.trim() || "Describe this image precisely; OCR found little or no text.", img, fmtAnalysis(a, cfg), vopts);
					if (taskId) writeStatus(taskId, 1, 1, `vlm done · ${answer.length} chars`, vopts.owner);
					return { content: [{ type: "text", text: `[auto→vlm: ocr empty/low-conf]\n${answer}\n\n[grounding used]\n${fmtAnalysis(a, cfg).slice(0, 600)}` }], details: undefined };
				}
				return { content: [{ type: "text", text: fmtAnalysis(a, cfg) + `\n\n[hint] semantics needed? call look(path, mode="vlm", question="...")` }], details: undefined };
			} catch (e) {
				if (taskId) removeStatus(taskId);
				const msg = e instanceof Error ? e.message : String(e);
				const text = signal?.aborted ? "look: aborted by user" : `look failed: ${msg}`;
				return { content: [{ type: "text", text }], isError: true, details: undefined };
			}
		},
	});
}
