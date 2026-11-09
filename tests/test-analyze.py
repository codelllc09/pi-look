#!/usr/bin/env python3
"""Lane 0+1 analyzer tests. Run with the central venv python (needs PIL + rapidocr):
    ~/.virtualenvs/main/bin/python tests/test-analyze.py
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def find_cjk_font() -> str | None:
    """Resolve a Noto CJK font via fontconfig at runtime — no hardcoded paths.
    PIL's default bitmap font cannot draw CJK, so without a font we skip those
    assertions instead of fabricating tofu."""
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}", "Noto Sans Mono CJK SC"], capture_output=True, text=True, timeout=10)
        p = out.stdout.strip()
        if out.returncode == 0 and p and Path(p).exists():
            return p
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


CJK = find_cjk_font()


def analyze(path: str, tier: str | None = None) -> dict:
    cmd = [PY, str(ROOT / "scripts" / "analyze.py"), path]
    if tier:
        cmd.append(tier)
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "usage:" not in out.stderr, "usage error leaked"
    return json.loads(out.stdout)


def make_text_image(path: str, lines: list[str]) -> None:
    assert CJK, "no CJK font (fc-match Noto Sans Mono CJK SC) — caller must skip"
    img = Image.new("RGB", (800, 60 + 70 * len(lines)), (18, 18, 22))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(CJK, 22)
    for i, t in enumerate(lines):
        d.text((24, 24 + i * 70), t, font=f, fill=(230, 230, 230))
    img.save(path)


def make_layout_image(path: str, cells: list[tuple[int, int, str]], size: tuple[int, int] = (800, 220), bg=(18, 18, 22), fg=(230, 230, 230), fontsize=20) -> None:
    """Place text cells at explicit (x, y) — for column/table layout tests."""
    assert CJK, "no CJK font — caller must skip"
    img = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(CJK, fontsize)
    for x, y, t in cells:
        d.text((x, y), t, font=f, fill=fg)
    img.save(path)


class AnalyzerTests(unittest.TestCase):
    def test_text_image(self):
        if not CJK:
            self.skipTest("no CJK font found; install noto-sans-mono-cjk-vf-fonts (or any fontconfig CJK font)")
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/t.png"
            make_text_image(p, ["pi-look unit 42", "中文行识别测试"])
            r = analyze(p)
            self.assertEqual(r["stats"]["width"], 800)
            self.assertEqual(r["stats"]["theme"], "dark")
            self.assertLessEqual(abs(r["stats"]["estimatedTextRows"] - 2), 1)
            self.assertTrue(r["ocr"]["available"])
            self.assertGreaterEqual(len(r["ocr"]["lines"]), 2)
            self.assertEqual(r["ocr"]["tier"], "v6-small")  # provenance: which tier ran
            self.assertGreater(r["ocr"]["avgConf"], 0.5)
            self.assertIn("pi-look", r["ocr"]["text"])
            for line in r["ocr"]["lines"]:
                self.assertIn("box", line, "every OCR line must carry a box")
                x1, y1, x2, y2 = line["box"]
                self.assertTrue(0 <= x1 < x2 <= r["stats"]["width"], f"box x invalid: {line['box']}")
                self.assertTrue(0 <= y1 < y2 <= r["stats"]["height"], f"box y invalid: {line['box']}")

    def test_blank_image(self):
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/blank.png"
            Image.new("RGB", (300, 200), (10, 120, 240)).save(p)
            r = analyze(p)
            self.assertEqual(r["stats"]["estimatedTextRows"], 0)
            self.assertEqual(len(r["ocr"]["lines"]), 0)
            self.assertEqual(r["ocr"]["tofuCount"], 0)

    def test_missing_image(self):
        with tempfile.TemporaryDirectory() as td:
            missing = Path(td) / "missing.png"
            out = subprocess.run([PY, str(ROOT / "scripts" / "analyze.py"), str(missing)], capture_output=True, text=True)
            self.assertEqual(out.returncode, 3)
            self.assertIn("error", out.stdout)

    def test_invalid_tier_falls_back(self):
        if not CJK:
            self.skipTest("no CJK font found")
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/t.png"
            make_text_image(p, ["pi-look unit 42"])
            r = analyze(p, tier="bogus-tier")  # falls back to v6-small, still works
            self.assertTrue(r["ocr"]["available"])
            self.assertGreaterEqual(len(r["ocr"]["lines"]), 1)

    def test_usage_error(self):
        out = subprocess.run([PY, str(ROOT / "scripts" / "analyze.py")], capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)

    def test_two_column_reading_order(self):
        if not CJK:
            self.skipTest("no CJK font found")
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/cols.png"
            make_layout_image(p, [
                (30, 20, "左栏甲行"), (30, 70, "左栏乙行"), (30, 120, "左栏丙行"),
                (430, 20, "右栏甲行"), (430, 70, "右栏乙行"), (430, 120, "右栏丙行"),
            ])
            r = analyze(p)
            o = r["ocr"]
            self.assertEqual(o["columns"], 2)
            self.assertEqual(len(o["lines"]), 6)
            # column-major: the first three lines are the left column
            self.assertTrue(all("左栏" in l["text"] for l in o["lines"][:3]), o["text"])
            self.assertTrue(all("右栏" in l["text"] for l in o["lines"][3:]), o["text"])

    def test_table_detection(self):
        if not CJK:
            self.skipTest("no CJK font found")
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/table.png"
            make_layout_image(p, [
                (40, 30, "名称"), (300, 30, "数值"), (560, 30, "备注"),
                (40, 80, "资金"), (300, 80, "430"), (560, 80, "开局"),
            ])
            r = analyze(p)
            o = r["ocr"]
            self.assertEqual(len(o["tables"]), 1, f"tables={o['tables']}")
            t = o["tables"][0]
            self.assertEqual([len(row) for row in t["rows"]], [3, 3])
            cells = [[o["lines"][i]["text"] for i in row] for row in t["rows"]]
            self.assertIn("名称", cells[0])
            self.assertIn("430", cells[1])

    def test_cjk_fields(self):
        if not CJK:
            self.skipTest("no CJK font found")
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/t.png"
            make_text_image(p, ["pi-look unit 42", "中文行识别测试"])
            r = analyze(p)
            o = r["ocr"]
            self.assertGreater(o["cjkShare"], 0.2)
            for l in o["lines"]:
                self.assertIn("cjk", l)
            en = next(l for l in o["lines"] if "pi-look" in l["text"])
            zh = next(l for l in o["lines"] if "中文" in l["text"])
            self.assertLess(en["cjk"], 0.1)
            self.assertGreater(zh["cjk"], 0.9)


if __name__ == "__main__":
    unittest.main()
