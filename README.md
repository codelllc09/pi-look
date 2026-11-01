# pi-look

**English** · [简体中文](./docs/README.zh-CN.md)

One `look` tool, three lanes; **the calling model is the router**.

Gives every model — text-only or not — a single entry point for image
questions, with local-first lanes and a vision-model lane only when needed:

| Lane | What | Cost |
|---|---|---|
| 0 · pixel stats | dimensions, theme, dominant colors, estimated text rows | ~50 ms, local |
| 1 · OCR (RapidOCR) | verbatim text + per-line confidence + tofu-marker count | ~1–2 s, local, free |
| 2 · VLM relay | a configurable vision model, **grounded with Lane 0+1 output** | per call |

## Protocol

- `look(path)` — returns Lane 0+1 plus a hint. The caller reads the OCR text
  and decides: answered → move on; semantics needed → call again with
  `mode="vlm"`. No intent classification in code — the caller is a language
  model and routes better than any keyword heuristic.
- `auto` escalation fires **only** on objective signals (no text found, or
  `avgConf < minAutoConf`), and **never** spends a VLM call when the active
  model has its own vision (`mode="vlm"` remains available as second opinion).
- `mode="stats" | "ocr"` force a single lane. Useful even for vision models:
  exact numbers eyes estimate poorly (verbatim text, counts, colors).
- Heavier classical CV (contours, template matching, color segmentation,
  connected components, etc.) stays in the model's bash+python domain by design.

## Config

`<agent-dir>/pi-look.json` (all optional):

```json
{
  "visionModel": "zai-coding-cn/glm-5.3-flash",
  "minAutoConf": 0.3,
  "vlmEndpoints": { "zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions" }
}
```

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
npm test            # analyzer (python) + router (node) tests
```

The analyzer test picks its interpreter in order: `$PI_LOOK_PY` →
`~/.virtualenvs/main/bin/python` → `python3`. It needs Pillow + RapidOCR
installed for that interpreter (`scripts/requirements.txt`).

## License

MIT
