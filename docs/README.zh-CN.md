[English](../README.md) · **简体中文**

# pi-look

一个 `look` 工具、三条车道，**路由器就是调用它的主模型**。

让每一个模型——无论有无视觉——都拥有图像问题的统一入口：本地车道优先，
确有需要才花一次视觉模型调用：

| 车道 | 内容 | 成本 |
|---|---|---|
| 0 · 像素统计 + 结构 | 尺寸、明暗、背景/墨色分离、鲜艳度、强调色、列带、行距规律、墨水连通域、纹理感知缩略图 | ~50 ms，本地 |
| 1 · OCR（RapidOCR，PP-OCRv6） | 阅读顺序逐字文本、列数、markdown 表格、低置信标记、CJK 占比、豆腐计数 | ~1–2 s，本地免费 |
| 2 · VLM 转发 | 可配置的视觉模型，**携带 Lane 0+1 输出作锚定** | 按次计费 |

## 协议

- `look(path)` —— 返回 Lane 0+1 外加一行提示。调用方读完 OCR 文本自行
  决定：够用了就走；需要语义理解就带 `mode="vlm"` 再调一次。代码里
  不做任何意图分类——调用方是语言模型，路由得比任何关键词启发式都好。
- `auto` 升级**只看客观信号**（没找到文本，或 `avgConf < minAutoConf`），
  且当前模型自带视觉时**绝不**代调 VLM（`mode="vlm"` 仍可作为第二意见
  显式调用）。
- `mode="stats"` 只做像素分析。`mode="ocr"` 返回本地 OCR 与像素依据。
- 像素与 OCR 共用按 EXIF 校正的坐标，透明像素合成到对比底色。
  需要校正时 VLM 收到相同像素的 PNG，其余情况传原图。
- OCR 输出带版面感知：行按阅读顺序排列（列内自上而下、列间从左到
  右；通栏行会桥接两列并退化为纯自上而下），对齐多盒行渲染为
  markdown 表格（保守门椓 ≥2×2 且左缘对齐），置信度低于 0.8 的行带
  `⟨0.42⟩` 标记，头部显示 CJK 占比与列数。
- 更重的经典 CV（轮廓、模板匹配、颜色分割、连通域等）刻意留在模型
  自己的 bash+python 域内。
- 车道 0 带结构感知：`[structure]` 报背景/墨色分离、鲜艳度、灰度、
  饱和强调色、像素投影列数、行距规律与墨水连通域统计（数量、主尺寸
  档、均匀性、水平偏侧）。`[grid WxH]` 用 `·░▒▓█` 表示墨水密度，
  用 `≡` 表示 Sobel 边缘密集，用 `RGBYCM` 表示饱和且平均 RGB 与
  全图平均有差异的格子。色相独立于灰阶墨水遮罩。

## 纯文本模型接管

当前模型无视觉时，pi 会把图像内容剥成占位符，`read` 读图也只得到
“该图像将从本次请求中移除”。开启 `takeover`（默认开）后由 pi-look
接管——模型驱动，零预分析：
- **input 接管**：base64 附件（CLI `@file`、RPC）落盘为
  `/tmp/pi-look-<uuid>.<ext>`，文本里引用路径，附件剥空——模型想要
  内容时自行调 `look`。TUI 贴图本来就是路径（pi 自身行为）；
  视觉模型零介入。
- **read 接管**：纯文本模型 `read()` 图像（显式请求内容）时，结果
  直接换成 Lane 0+1 分析——与 `look` 默认输出同构，附 vlm 提示。
  codemode 嵌套调用保留图像块；分析器失败则原样放行。

## 贴图显示

按原生 `Ctrl+V` 粘贴图片后，输入框立即显示 `[fig1]`、`[fig2]`。
发送时恢复路径，已发送的对话继续显示相同的会话编号。
Pi 全屏启用 Kitty 图形协议和超链接时，点击已发送的图片链接可在 Pi 内查看大图。
滚轮或 `+`/`-` 缩放，拖曳或方向键平移，`0` 恢复适合窗口的大小。
按 `Esc` 或点击图片外关闭。全屏不支持 Kitty 图形时，改用系统看图器。
普通模式由终端处理超链接。无超链接时显示纯文本代号。

全屏启用 Kitty 图形时，悬停在输入框的代号或已发送的图片链接上可预览缩略图。
打字、滚动、移到同区域的其他位置，或停留三秒无鼠标移动时收起。
两种预览都沿用 Pi 的临时图片文件。

## 长调用的进度反馈（白盒执行）

VLM 调用可能耗时数十秒（推理型判官 thinking 阶段一个字都不出）。
宿主传了 `onUpdate` 时，`look` 自动改用**流式（SSE）**请求并持续回报：

- 首 token 到达立即推一条，之后内容驱动节流（≥64 字符且 ≥2s）；
- thinking 期间每 5s 心跳一条（`waiting for first token · Ns`）；
- 同时写 pi-taskwatcher 状态文件
  （`~/.pi/agent/status/look-<id>.json`，footer 芯片，尽力而为）；
- 宿主 abort 信号中断 `look` 的本地分析或 VLM 请求。VLM 请求超时为 180s。

老宿主不传 `onUpdate` 时退回非流式，行为与旧版完全一致；流式端点
  异常返回空文本时也会自动回退一次非流式请求。

## 配置

`<agent-dir>/pi-look.json`（全部可选）：

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

`ocrTier` 选择 OCR 模型档位：`v6-small`（默认，PP-OCRv6 det+rec small，
随 `rapidocr` wheel 捆绑、完全离线）或 `v6-medium` / `v5-mobile` /
`v5-server` / `v4-mobile`（首次使用时联网下载）。已停更的
`rapidocr-onnxruntime`（PP-OCRv4）不再使用。

`ocrTierRetry`（默认 `true`）先从重试计数中扣除宽且对齐的实心带。
剩余至少四带，且默认档位的 OCR 行数不超过带数一半时，`look` 用
`v6-medium` 重试一次。medium 行数更多才胜出，以 `tier=…` 标注。
大图重试可能耗时 10–15 秒，设 `false` 可关闭。

`pythonPath`（可选）钉死分析器解释器。默认自动解析：中央 uv venv
（`~/.virtualenvs/main/bin/python`）存在则用之，否则 `python3`
（Windows 用户建议显式设置）。

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
npm test            # 分析器（python）+ 路由器 + 接管 + 贴图 + VLM 流式测试
```

分析器测试按顺序选解释器：`$PI_LOOK_PY` →
`~/.virtualenvs/main/bin/python` → `python3`。要求该解释器已装
Pillow + RapidOCR（见 `scripts/requirements.txt`）。

## 许可

[MIT](../LICENSE)
