[English](../README.md) · **简体中文**

# pi-look

一个 `look` 工具、三条车道，**路由器就是调用它的主模型**。

让每一个模型——无论有无视觉——都拥有图像问题的统一入口：本地车道优先，
确有需要才花一次视觉模型调用：

| 车道 | 内容 | 成本 |
|---|---|---|
| 0 · 像素统计 | 尺寸、明暗主题、主色、估算文本行数 | ~50 ms，本地 |
| 1 · OCR（RapidOCR） | 逐字文本 + 每行置信度 + 豆腐标记计数 | ~1–2 s，本地免费 |
| 2 · VLM 转发 | 可配置的视觉模型，**携带 Lane 0+1 输出作锚定** | 按次计费 |

## 协议

- `look(path)` —— 返回 Lane 0+1 外加一行提示。调用方读完 OCR 文本自行
  决定：够用了就走；需要语义理解就带 `mode="vlm"` 再调一次。代码里
  不做任何意图分类——调用方是语言模型，路由得比任何关键词启发式都好。
- `auto` 升级**只看客观信号**（没找到文本，或 `avgConf < minAutoConf`），
  且当前模型自带视觉时**绝不**代调 VLM（`mode="vlm"` 仍可作为第二意见
  显式调用）。
- `mode="stats" | "ocr"` 强制单车道。对有视觉的模型同样有用：眼睛估
  不准的精确数字（逐字文本、计数、颜色）由本地测量给出。
- 更重的经典 CV（轮廓、模板匹配、颜色分割、连通域等）刻意留在模型
  自己的 bash+python 域内。

## 配置

`<agent-dir>/pi-look.json`（全部可选）：

```json
{
  "visionModel": "zai-coding-cn/glm-5.3-flash",
  "pythonPath": "~/.virtualenvs/main/bin/python",
  "minAutoConf": 0.3,
  "vlmEndpoints": { "zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions" }
}
```

API 密钥读自 `<agent-dir>/auth.json[provider].key`，永不落日志。
端点为 OpenAI 兼容格式；在 `vlmEndpoints` 里加 provider 即可，无需改代码。

## 安装

```bash
pi install npm:pi-look
```

分析器依赖（Pillow = 像素统计车道，RapidOCR = OCR 车道；更重的 CV——
opencv 等——刻意不做依赖，留在模型的 bash 域内）。版本钉死在
`scripts/requirements.txt` 以保证语料可比性：

```bash
uv pip install -r scripts/requirements.txt   # 或你习惯的 pip/venv 方式
```

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # 分析器（python）+ 路由器（node）测试
```

分析器测试按顺序选解释器：`$PI_LOOK_PY` →
`~/.virtualenvs/main/bin/python` → `python3`。要求该解释器已装
Pillow + RapidOCR（见 `scripts/requirements.txt`）。

## 许可

[MIT](../LICENSE)
