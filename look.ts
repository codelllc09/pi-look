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
 *     "pythonPath":  "~/.virtualenvs/main/bin/python",
 *     "minAutoConf": 0.3 }
 * API key is read from <agent-dir>/auth.json[provider].key; no key is ever
 * written or logged. Endpoint map is in ENDPOINTS below.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface LookConfig {
	visionModel: string; // "provider/model-id"
	pythonPath: string;
	minAutoConf: number;
}

const DEFAULTS: LookConfig = {
	visionModel: "zai-coding-cn/glm-5.3-flash",
	pythonPath: "~/.virtualenvs/main/bin/python",
	minAutoConf: 0.3,
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
const visionCapable = () => Array.isArray(currentModel?.input) && currentModel.input.includes("image");

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
	stats?: { width: number; height: number; theme: string; dominantColors: { hex: string; share: number }[]; estimatedTextRows: number };
	ocr?: { available: boolean; error?: string; lines: { conf: number; text: string }[]; avgConf: number | null; text: string; tofuCount: number };
	error?: string;
}

async function analyze(cfg: LookConfig, imgPath: string): Promise<Analysis> {
	const script = path.join(import.meta.dirname, "scripts", "analyze.py");
	const out = await runPython(cfg.pythonPath, [script, imgPath]);
	return JSON.parse(out) as Analysis;
}

function apiKey(provider: string): string {
	const auth = JSON.parse(fs.readFileSync(path.join(agentDir(), "auth.json"), "utf-8"));
	const key = auth?.[provider]?.key;
	if (typeof key !== "string" || !key) throw new Error(`no API key for provider "${provider}" in auth.json`);
	return key;
}

async function callVLM(cfg: LookConfig, question: string, imgPath: string, grounding: string): Promise<string> {
	const slash = cfg.visionModel.indexOf("/");
	const provider = cfg.visionModel.slice(0, slash);
	const model = cfg.visionModel.slice(slash + 1);
	const endpoint = ENDPOINTS[provider];
	if (!endpoint) throw new Error(`no endpoint mapped for provider "${provider}" — add it in pi-look config or ENDPOINTS`);
	const b64 = fs.readFileSync(imgPath).toString("base64");
	const body = {
		model,
		max_tokens: 1800,
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: question + (grounding ? `\n\n[grounding] Local OCR and pixel stats (may be partial or wrong; trust the image when they conflict):\n${grounding}` : "") },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
			],
		}],
	};
	const res = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey(provider)}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`VLM ${provider}/${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const out = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
	let content = out.choices?.[0]?.message?.content ?? "";
	if (Array.isArray(content)) content = content.map((c: { text?: string }) => c?.text ?? "").join("");
	return String(content).trim();
}

function fmtAnalysis(a: Analysis): string {
	const s = a.stats, o = a.ocr;
	const parts: string[] = [];
	if (s) parts.push(`[stats] ${s.width}x${s.height} ${s.theme}-theme rows≈${s.estimatedTextRows} colors=${s.dominantColors.map((c) => `${c.hex}(${Math.round(c.share * 100)}%)`).join(" ")}`);
	if (!o) return parts.join("\n");
	if (!o.available) parts.push(`[ocr] unavailable: ${o.error}`);
	else {
		parts.push(`[ocr] ${o.lines.length} lines, avgConf=${o.avgConf ?? "n/a"}${o.tofuCount ? `, tofuMarkers=${o.tofuCount}` : ""}`);
		parts.push(o.text || "(no text recognized)");
	}
	return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();

	pi.on("session_start", async (_e, ctx) => { currentModel = ctx.model; });
	pi.on("model_select", async (e) => { currentModel = e.model; });

	pi.registerTool({
		name: "look",
		description:
			"Look at an image file through a three-lane pipeline. Useful even if you can already see images: the stats/OCR lanes give EXACT numbers your eyes estimate poorly (dimensions, colors, verbatim text, counts). Default (no mode): pixel stats + local OCR — cheap and local; check whether that answers your question before going further. mode='vlm' with a question: asks a vision model grounded with the local OCR — use for semantics ('what is this', shapes, UIs, likeness), when you cannot see images, or as a second opinion. mode='stats'/'ocr': force one lane. Heavier CV (contours, template matching, detectors) you can always write yourself in bash+python.",
		parameters: Type.Object({
			path: Type.String({ description: "Image file path (png/jpg/webp/bmp)" }),
			mode: Type.Optional(Type.String({ description: "Lane selection: auto (default) | stats | ocr | vlm" })),
			question: Type.Optional(Type.String({ description: "For mode=vlm: what to answer about the image" })),
		}),
		async execute(_toolCallId: string, args: { path?: string; mode?: string; question?: string } = {}) {
			const img = expand(String(args?.path ?? ""));
			if (!args?.path || !fs.existsSync(img)) return { content: [{ type: "text", text: `file not found: ${args?.path}` }], isError: true };
			const mode = ["auto", "stats", "ocr", "vlm"].includes(String(args.mode)) ? String(args.mode) : "auto";
			try {
				if (mode === "vlm") {
					const a = await analyze(cfg, img);
					const answer = await callVLM(cfg, args.question?.trim() || "Describe this image precisely.", img, fmtAnalysis(a));
					return { content: [{ type: "text", text: answer + `\n\n[grounding used]\n${fmtAnalysis(a).slice(0, 600)}` }] };
				}
				const a = await analyze(cfg, img);
				if (mode === "auto" && shouldAutoEscalate(a.ocr ?? { lines: [], avgConf: null }, cfg.minAutoConf)) {
					if (visionCapable()) {
						// Never spend a VLM call on a model with its own eyes (explicit mode=vlm still allowed).
						return { content: [{ type: "text", text: fmtAnalysis(a) + `\n\n[hint] OCR found little; you have vision — inspect the image yourself, or call look(path, mode="vlm", question="...") for a second opinion.` }] };
					}
					const answer = await callVLM(cfg, args.question?.trim() || "Describe this image precisely; OCR found little or no text.", img, fmtAnalysis(a));
					return { content: [{ type: "text", text: `[auto→vlm: ocr empty/low-conf]\n${answer}\n\n[grounding used]\n${fmtAnalysis(a).slice(0, 600)}` }] };
				}
				return { content: [{ type: "text", text: fmtAnalysis(a) + `\n\n[hint] semantics needed? call look(path, mode="vlm", question="...")` }] };
			} catch (e) {
				return { content: [{ type: "text", text: `look failed: ${String(e instanceof Error ? e.message : e)}` }], isError: true };
			}
		},
	});
}
