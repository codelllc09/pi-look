/** VLM streaming whitebox tests: mock OpenAI-compatible SSE endpoint.
 * Covers: SSE frame parsing (split frames, CRLF, array/string deltas, [DONE]),
 * onUpdate forwarding, taskwatcher status file, non-stream fallback, abort. */
import { execSync } from "node:child_process";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const bundle = join(import.meta.dirname, "..", "look.test.bundle.mjs");
execSync(`npx esbuild ${join(import.meta.dirname, "..", "look.ts")} --bundle --format=esm --platform=node --external:@earendil-works/pi-coding-agent --external:typebox --outfile=${bundle}`, { stdio: "pipe" });

// isolated agent dir (fake auth.json) + status dir
const agent = mkdtempSync(join(tmpdir(), "look-vlm-agent-"));
const statusDir = mkdtempSync(join(tmpdir(), "look-vlm-status-"));
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_TASK_STATUS_DIR = statusDir;
writeFileSync(join(agent, "auth.json"), JSON.stringify({ mockprov: { type: "api", key: "sk-test" } }));
// tiny valid PNG (1x1)
const png = join(agent, "px.png");
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPkz8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));

const { callVLM, default: registerLook } = await import(bundle);

let n = 0; // test counter
const done = (name) => console.log(`ok ${++n} - ${name}`);

// ---- mock server -----------------------------------------------------------
const frames = (arr) => arr.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";
let handler = () => {};
const server = http.createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const cfg = { visionModel: "mockprov/mock-1", minAutoConf: 0.3, vlmEndpoints: { mockprov: `${base}/v1/chat` } };

const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(JSON.parse(b))); });
const sseHeaders = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" };

// 1-3: SSE parsing + progress + status file --------------------------------
{
	const updates = [];
	const chunks = [
		// frame split across TCP writes + CRLF line endings + string delta
		'data: {"choices":[{"delta":{"content":"Hel',
		'lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":[" wor","ld"]}}]}\n\n', // array delta (zai style)
		'data: {"choices":[{"delta":{}},{"delta":{"reasoning_content":"ignore me"},"finish_reason":null}]}\n\n',
		'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
		"data: [DONE]\n\n",
	];
	handler = async (req, res) => {
		const body = await readBody(req);
		assert.equal(body.stream, true, "stream flag sent");
		assert.equal(body.model, "mock-1");
		res.writeHead(200, sseHeaders);
		for (const c of chunks) { res.write(c); await new Promise((r) => setTimeout(r, 30)); }
		res.end();
	};
	const answer = await callVLM(cfg, "q", png, "", { onUpdate: (u) => updates.push(u.content[0].text), taskId: "look-t1", owner: "sess-1" });
	assert.equal(answer, "Hello world!"); // split frame + CRLF + array/string deltas + reasoning_content ignored
	done("SSE parsing: split frames, CRLF, array+string deltas, [DONE]");
	assert.ok(updates.some((t) => t.includes("asking")), "asking notice pushed");
	assert.ok(updates.some((t) => t.includes("look:") && t.includes("streaming")), "streaming progress pushed");
	done("onUpdate: asking + streaming notices forwarded");
	const st = JSON.parse(readFileSync(join(statusDir, "look-t1.json"), "utf8"));
	assert.equal(st.label, "look"); assert.equal(st.owner, "sess-1"); assert.ok(st.note.length > 0);
	done("taskwatcher status file written (label/owner/note)");
}

// 4: no onUpdate → legacy non-streaming request ---------------------------
{
	handler = async (req, res) => {
		const body = await readBody(req);
		assert.equal(body.stream, false, "no onUpdate → non-streaming");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "plain answer" }, finish_reason: "stop" }] }));
	};
	const answer = await callVLM(cfg, "q", png, "", {});
	assert.equal(answer, "plain answer");
	done("no onUpdate: legacy non-streaming path intact");
}

// 5: empty stream → non-streaming fallback ---------------------------------
{
	let calls = 0;
	handler = async (req, res) => {
		calls++;
		const body = await readBody(req);
		if (body.stream) { // SSE that yields nothing (endpoint without SSE support)
			res.writeHead(200, sseHeaders);
			res.end("data: [DONE]\n\n");
		} else {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { content: "fallback ok" }, finish_reason: "stop" }] }));
		}
	};
	const answer = await callVLM(cfg, "q", png, "", { onUpdate: () => {} });
	assert.equal(answer, "fallback ok");
	assert.equal(calls, 2, "stream attempt then non-stream retry");
	done("empty stream falls back to one non-streaming attempt");
}

// 6: abort kills the fetch ---------------------------------------------------
{
	handler = () => { /* hang forever */ };
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 300);
	await assert.rejects(
		() => callVLM(cfg, "q", png, "", { signal: ac.signal, onUpdate: () => {} }),
		(e) => /abort/i.test(e.message),
	);
	done("host abort rejects the in-flight VLM call");
}

// Tool entry point: analyzer flags, relay selection, and cancellation during retry.
{
	const analyzer = join(agent, "fake-python");
	const retryPid = join(agent, "retry.pid");
	writeFileSync(analyzer, `#!/usr/bin/env node
const fs = require("node:fs");
const [first, second] = process.argv.slice(3);
const stats = { width: 1, height: 1, theme: "dark", dominantColors: [], estimatedTextRows: 0 };
if (first === "--stats-only") {
  console.log(JSON.stringify({ stats }));
} else if (first === "--relay") {
  console.log(JSON.stringify({ data: fs.readFileSync(${JSON.stringify(png)}, "base64") }));
} else if (second === "v6-medium") {
  fs.writeFileSync(${JSON.stringify(retryPid)}, String(process.pid));
  setTimeout(() => process.exit(91), 5000);
} else {
  if (first.endsWith("retry.jpg")) stats.estimatedTextRows = 6;
  const image = { mimeType: "image/jpeg", normalized: first.endsWith("rotated.jpg") };
  const ocr = { available: true, lines: [], avgConf: null };
  console.log(JSON.stringify({ stats, image, ocr }));
}
`, { mode: 0o700 });
	writeFileSync(join(agent, "pi-look.json"), JSON.stringify({ ...cfg, pythonPath: analyzer }));
	let tool;
	const hooks = {};
	registerLook({ on(name, hook) { hooks[name] = hook; }, registerTool(spec) { tool = spec; } });
	const textModel = { input: ["text"] };
	const visionModel = { input: ["text", "image"] };
	await hooks.session_start({}, { model: textModel });

	const stats = await tool.execute("stats", { path: png, mode: "stats" });
	assert.match(stats.content[0].text, /^\[stats\] 1x1/);
	assert.ok(!stats.content[0].text.includes("[ocr]"));
	done("stats mode requests pixel analysis only");

	const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
	for (const [filename, mode, expected] of [
		["plain.jpg", "vlm", `data:image/jpeg;base64,${jpegBytes.toString("base64")}`],
		["rotated.jpg", "auto", `data:image/png;base64,${readFileSync(png, "base64")}`],
	]) {
		const path = join(agent, filename);
		writeFileSync(path, jpegBytes);
		handler = async (req, res) => {
			const body = await readBody(req);
			const [prompt, image] = body.messages[0].content;
			assert.match(prompt.text, /\[grounding\][^\n]*\n\[stats\]/);
			assert.equal(image.image_url.url, expected);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
		};
		const result = await tool.execute(filename, { path, mode });
		assert.ok(!result.isError, result.content[0].text);
	}
	done("VLM forwards original JPEG bytes or the normalized PNG with grounding");

	let relayCalls = 0;
	handler = (_req, res) => {
		relayCalls++;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "unexpected relay" } }] }));
	};
	for (const mode of ["auto", "vlm"]) {
		// The execution context takes precedence over the session's last selected model.
		const result = await tool.execute(mode, { path: png, mode }, undefined, undefined, { model: visionModel });
		assert.ok(!result.isError, result.content[0].text);
		assert.match(result.content[0].text, /\[ocr\] 0 lines/);
		assert.match(result.content[0].text, /Inspect the original image directly/);
		assert.doesNotMatch(result.content[0].text, /call look\(path, mode="vlm"/);
	}
	await hooks.model_select({ model: visionModel });
	const fallback = await tool.execute("legacy", { path: png, mode: "vlm" });
	assert.match(fallback.content[0].text, /Inspect the original image directly/);
	await hooks.session_start({}, {});
	const unknown = await tool.execute("unknown", { path: png, mode: "vlm" });
	assert.match(unknown.content[0].text, /\[ocr\] 0 lines/);
	assert.equal(relayCalls, 0);
	done("vision-capable and unknown callers stay local, including explicit vlm mode");

	const retry = join(agent, "retry.jpg");
	writeFileSync(retry, jpegBytes);
	const ac = new AbortController();
	const pending = tool.execute("retry", { path: retry, mode: "ocr" }, ac.signal);
	let pid;
	try {
		const deadline = Date.now() + 3000;
		while (!existsSync(retryPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		pid = Number(readFileSync(retryPid, "utf8"));
	} finally {
		ac.abort();
	}
	const canceled = await pending;
	assert.equal(canceled.isError, true);
	assert.equal(canceled.content[0].text, "look: aborted by user");
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	done("abort stops the active Python retry and propagates to the caller");
}

server.close();
console.log(`test-vlm-stream: ${n}/${n} passed`);
