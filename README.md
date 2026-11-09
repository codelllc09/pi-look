# pi-look

**English** · [简体中文](./docs/README.zh-CN.md)

One `look` tool, three lanes; **the calling model is the router**.

Gives every model — text-only or not — a single entry point for image
questions, with local-first lanes and a vision-model lane only when needed:

| Lane | What | Cost |
|---|---|---|
| 0 · pixel stats + structure | dimensions, theme, bg/ink colors, colorfulness, accents, column bands, row-gap regularity, ink blobs, texture-aware grid thumbnail | ~50 ms, local |
| 1 · OCR (RapidOCR, PP-OCRv6) | verbatim text in reading order, column count, markdown tables, low-conf markers, CJK share, tofu-marker count | ~1–2 s, local, free |
| 2 · VLM relay | a configurable vision model, **grounded with Lane 0+1 output** | per call |

## Protocol

- `look(path)` — returns Lane 0+1 plus a hint. The caller reads the OCR text
  and decides: answered → move on; semantics needed → call again with
  `mode="vlm"`. No intent classification in code — the caller is a language
  model and routes better than any keyword heuristic.
- `auto` escalation fires **only** on objective signals (no text found, or
  `avgConf < minAutoConf`), and **never** spends a VLM call when the active
  model has its own vision (`mode="vlm"` remains available as second opinion).
- `mode="stats"` runs pixel analysis only. `mode="ocr"` returns local OCR
  with pixel grounding.
- Stats and OCR use EXIF-corrected coordinates and composite transparency
  onto a contrasting matte. The VLM receives those same pixels as PNG when
  normalization is needed, otherwise it receives the original image.
- OCR output is layout-aware: lines come in reading order (column-major,
  columns left-to-right; full-width lines bridge columns and collapse to
  plain top-down), aligned multi-box rows render as markdown tables
  (conservative ≥2×2 + left-edge alignment gate), lines below 0.8 confidence
  carry a `⟨0.42⟩` marker, and the header shows CJK share and column count.
- Heavier classical CV (contours, template matching, color segmentation,
  connected components, etc.) stays in the model's bash+python domain by design.
- Lane 0 is structure-aware: `[structure]` reports bg/ink separation,
  colorfulness, grayscale, saturated accent colors, pixel-projection column
  count, row-gap regularity, and ink-blob statistics (count, dominant size
  class, uniformity, horizontal skew). `[grid WxH]` shows ink density
  (`·░▒▓█`), high Sobel edge density (`≡`), and hue letters (`RGBYCM`)
  for saturated cells whose average RGB differs from the image average.
  Hue is measured independently of the ink mask.

## Takeover for text-only models

With no vision in the active model, pi strips image content into omission
placeholders, and `read` on an image returns "the image will be omitted".
With `takeover` (default on) pi-look takes over instead — model-driven, zero
pre-analysis:

- **input**: base64 attachments (CLI `@file`, RPC) are persisted to
  `/tmp/pi-look-<uuid>.<ext>`, referenced by path in the text, and the
  attachment stripped — the model calls `look` itself only if it wants to.
  TUI-pasted images are already paths (pi's own behavior); vision models are
  never touched.
- **read relay**: when a text-only model `read()`s an image (an explicit
  request), lane 0+1 analysis is served in the result — same shape as
  `look`'s default output, with the vlm hint. Nested codemode calls keep the
  image block; analyzer failures pass the original result through.

## Native paste (replaces third-party paste extensions)

Pi's own `Ctrl+V` writes pasted clipboard images to
`/tmp/pi-clipboard-<uuid>.<ext>`. The editor shows `[fig1]`, `[fig2]`, and
so on immediately. On submit, `paste.ts` resolves the labels to image paths:

- **vision model**: paste artifacts (`/tmp/pi-clipboard-*`, `/tmp/pi-look-*`)
  found in the input are upgraded to real image attachments; the path text
  stays as `[image: <path>]` so the model can still call `look` for the exact
  numbers eyes estimate poorly.
- **text-only model**: the path lets the model call `look` or use the
  read takeover.

The transcript keeps the same session-scoped labels. In Pi fullscreen with
Kitty graphics and hyperlinks enabled, click a sent figure link to view it
inside Pi. Use the wheel or `+`/`-` to zoom, drag or use the arrow keys to
pan, and press `0` to fit. Press `Esc` or click outside the image to close.
Without Kitty graphics, Pi fullscreen opens the file in the system viewer.
In regular mode the terminal handles hyperlinks. Without hyperlinks, the
transcript shows plain labels.

Hover over a draft label or a sent figure link to preview a thumbnail
in Kitty fullscreen. Typing, scrolling, or moving away within the same
area closes it. It also closes after three seconds without a mouse move
over the label. Both views use Pi's temporary image file.

No chips, no cards, no rejection. If a third-party paste extension (e.g.
pi-image-paste-cards) is installed, remove it — it rejects sends for text-only
models outright, and both extensions compete on the input chain:

```bash
pi remove npm:pi-image-paste-cards && pi update --extensions
```

## Progress feedback for long calls (whitebox VLM)

VLM calls can take tens of seconds (reasoning judges emit nothing while
thinking). When the host passes `onUpdate`, `look` switches the request to
**streaming (SSE)** and reports continuously:

- first token pushes immediately, then content-driven throttling
  (≥64 chars and ≥2s);
- a ≥5s heartbeat during thinking (`waiting for first token · Ns`);
- a pi-taskwatcher status file
  (`~/.pi/agent/status/look-<id>.json`, footer chip, best-effort);
- host abort stops local analysis or the VLM fetch. The fetch has a 180s timeout.

Without `onUpdate` (older hosts) the request is non-streaming, identical to
legacy behavior; a streaming endpoint that yields no text falls back to one
non-streaming attempt.

## Config

`<agent-dir>/pi-look.json` (all optional):

```json
{
  "visionModel": "zai-coding-cn/glm-5.3-flash",
  "minAutoConf": 0.3,
  "takeover": true,
  "ocrTier": "v6-small",
  "ocrTierRetry": true,
  "vlmEndpoints": { "zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions" }
}
```

`ocrTier` selects the OCR model tier: `v6-small` (default — PP-OCRv6 det+rec
small, bundled in the `rapidocr` wheel, fully offline) or `v6-medium` /
`v5-mobile` / `v5-server` / `v4-mobile` (downloaded on first use). The
EOL `rapidocr-onnxruntime` package (PP-OCRv4) is no longer used.

`ocrTierRetry` (default `true`) excludes wide, aligned solid bands from
the retry count. If at least four bands remain and the default tier finds
at most half as many OCR lines, `look` retries once with `v6-medium`.
Medium wins only with more lines and is marked `tier=…`. A retry on a
large image can take 10–15 s. Set `false` to disable it.

`pythonPath` (optional) pins an explicit analyzer interpreter. Default:
auto-resolve — central uv venv (`~/.virtualenvs/main/bin/python`) if
present, else `python3` (Windows users should set it).

The API key is read from `<agent-dir>/auth.json[provider].key` and never
logged. Endpoints are OpenAI-compatible; add providers in `ENDPOINTS`.

## Install

Analyzer deps (Pillow = pixel stats lane, RapidOCR = OCR lane; heavier CV —
opencv etc. — is deliberately NOT a dependency, it stays in the model's
bash domain). Pinned in `scripts/requirements.txt` for fixture comparability:

```bash
uv pip install -r scripts/requirements.txt   # or your usual pip/venv
pi install npm:pi-look
```

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm test            # analyzer (python) + router + takeover + paste + VLM streaming tests
```

The analyzer test picks its interpreter in order: `$PI_LOOK_PY` →
`~/.virtualenvs/main/bin/python` → `python3`. It needs Pillow + RapidOCR
installed for that interpreter (`scripts/requirements.txt`).

## License

MIT
