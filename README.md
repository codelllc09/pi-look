# pi-look

**English** · [简体中文](#中文)

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
  "pythonPath": "~/.virtualenvs/main/bin/python",
  "minAutoConf": 0.3,
  "vlmEndpoints": { "zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions" }
}
```

The API key is read from `<agent-dir>/auth.json[provider].key` and never
logged. Endpoints are OpenAI-compatible; add providers in `ENDPOINTS`.

## Install

Analyzer deps (Pillow = pixel stats lane, RapidOCR = OCR lane; heavier CV —
opencv etc. — is deliberately NOT a dependency, it stays in the model's
bash domain). Pinned in `scripts/requirements.txt` for fixture comparability:

```bash
uv pip install -p ~/.virtualenvs/main/bin/python -r scripts/requirements.txt
pi install ~/Work/pi-look
```

## Dev

```bash
npx esbuild look.ts --outfile=/dev/null   # syntax gate
~/.virtualenvs/main/bin/python tests/test-analyze.py
node tests/test-router.mjs
```

---

# 中文

一个 `look` 工具、三条车道，**路由器就是调用它的主模型**。

- 默认调用返回 Lane 0+1（像素统计 + 本地 OCR，秒级、免费）附提示行；
  主模型看 OCR 结果自己决定够不够，不够再 `mode="vlm"` 走视觉模型
  （携带本地 OCR 作锚定，降低幻觉）。
- 自动升级只看**客观信号**（无文本/低置信度），且主模型自身有视觉时
  永不代调 VLM（可显式要求第二意见）。
- 有视觉的模型也欢迎用 stats/ocr 车道：眼睛估不准的精确数字
  （逐字文本、计数、颜色）由本地测量给出。
- 更重的 CV（轮廓、模板匹配、检测器）留在模型的 bash+python 域内。

配置见 `<agent-dir>/pi-look.json`；密钥读 `auth.json`，不落日志。
