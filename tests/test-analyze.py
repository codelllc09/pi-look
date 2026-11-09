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
            # pixel-projection columns agree with the box-based ones
            self.assertEqual(r["stats"]["columns"], 2)
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

    def test_blob_stats(self):
        with tempfile.TemporaryDirectory() as td:
            # 3x3 grid of equal squares -> 9 small uniform blobs, no skew
            p = f"{td}/squares.png"
            img = Image.new("RGB", (480, 480), (250, 250, 250))
            d = ImageDraw.Draw(img)
            for r in range(3):
                for c in range(3):
                    x, y = 60 + c * 140, 60 + r * 140
                    d.rectangle([x, y, x + 40, y + 40], fill=(20, 20, 20))
            img.save(p)
            b = analyze(p)["stats"].get("blobs")
            self.assertIsNotNone(b)
            self.assertEqual(b["count"], 9)
            self.assertEqual(b["size"], "small")
            self.assertTrue(b["uniform"])
            self.assertIsNone(b["skew"])
            # one big block -> a single large blob
            p2 = f"{td}/block.png"
            img2 = Image.new("RGB", (480, 480), (250, 250, 250))
            ImageDraw.Draw(img2).rectangle([80, 80, 400, 400], fill=(20, 20, 20))
            img2.save(p2)
            b2 = analyze(p2)["stats"].get("blobs")
            self.assertEqual(b2["count"], 1)
            self.assertEqual(b2["size"], "large")

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

    def test_structure_color_and_gray(self):
        with tempfile.TemporaryDirectory() as td:
            # gray text image: grayscale, low colorfulness, grid present, ink separable
            p = f"{td}/gray.png"
            make_text_image(p, ["灰度文本行"])
            s = analyze(p)["stats"]
            self.assertTrue(s["gray"])
            self.assertEqual(s["colorfulness"], "low")
            self.assertIn("cells", s["grid"])
            self.assertTrue(any(ch in "░▒▓█≡" for row in s["grid"]["cells"] for ch in row))  # ≡ = glyph texture since batch 5
            self.assertNotIn("accent", s)
            self.assertTrue(s["ink"], "ink must resolve on a text image")
            # saturated red block on gray bg: accent fires, colorful, not gray
            p2 = f"{td}/red.png"
            img = Image.new("RGB", (400, 300), (200, 200, 200))
            d = ImageDraw.Draw(img)
            d.rectangle([40, 40, 360, 260], fill=(220, 30, 30))
            img.save(p2)
            s2 = analyze(p2)["stats"]
            self.assertFalse(s2["gray"])
            self.assertIn(s2["colorfulness"], ("medium", "high"))
            self.assertTrue(any(a["hex"] not in ("#c8c8c8",) for a in s2.get("accent", [])), s2.get("accent"))
            # a hue letter must appear in the grid for the red block
            self.assertTrue(any("R" in row for row in s2["grid"]["cells"]), s2["grid"]["cells"])


if __name__ == "__main__":
    unittest.main()
