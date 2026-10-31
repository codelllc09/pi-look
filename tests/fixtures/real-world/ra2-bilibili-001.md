# ra2-bilibili-001 — first real-world fixture (2026-11-01)

Source: user pasted screenshot (Bilibili, UP 红警HBK08, Red Alert 2).
Judge under test: glm-5.3-flash via look(mode=vlm), grounding on.

## Checklist (fact-based scoring, not text similarity)

Perception facts (visible in the image) — all reproduced correctly:
- [x] 游戏 = 红色警戒2
- [x] 来源 = B站视频, UP主名可读（红警HBK08）
- [x] 地图 = 水路迷宫式, 沙洲连接
- [x] 阵营 = ≥4 个不同颜色基地
- [x] 资金 = 430
- [x] 侧栏 = 经典 RA2 HUD 布局

Inference facts (world-state beyond the image) — the failure:
- [ ] 游戏阶段 = **刚刚开局**；判官回答"游戏中期" ✗
  — RA2 HUD 不显示计时器，阶段推断缺乏图像内依据，属于
    无锚定知识的猜测。见 fixture 教训。

## Lesson (design feedback into look.ts)

Grounding (stats+OCR) anchors PERCEPTION; it cannot anchor INFERENCE
about state not present in the image. Mitigation shipped: the VLM prompt
now instructs the judge to separate visible facts from inferences and
mark low-evidence judgments as uncertain. Regression: re-run this
fixture when swapping judges; perception must stay 6/6, phase answer
must either be correct or explicitly marked uncertain — a confident
wrong phase claim is the failure signature to catch.
