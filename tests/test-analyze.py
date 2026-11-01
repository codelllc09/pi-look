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


def analyze(path: str) -> dict:
    out = subprocess.run([PY, str(ROOT / "scripts" / "analyze.py"), path], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def make_text_image(path: str, lines: list[str]) -> None:
    assert CJK, "no CJK font (fc-match Noto Sans Mono CJK SC) — caller must skip"
    img = Image.new("RGB", (800, 60 + 70 * len(lines)), (18, 18, 22))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(CJK, 22)
    for i, t in enumerate(lines):
        d.text((24, 24 + i * 70), t, font=f, fill=(230, 230, 230))
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


if __name__ == "__main__":
    unittest.main()
