#!/usr/bin/env python3
"""Lane 0+1 analyzer tests. Run with the central venv python (needs PIL + rapidocr):
    ~/.virtualenvs/main/bin/python tests/test-analyze.py
"""
import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
sys.path.insert(0, str(ROOT))
from scripts.analyze import _blob_stats, lane0


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


def analyze(path: str, tier: str | None = None, *, mode: str | None = None) -> dict:
    cmd = [PY, str(ROOT / "scripts" / "analyze.py")]
    if mode:
        cmd.append(mode)
    cmd.append(path)
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
    def test_exif_coordinates_match_ocr_and_relay(self):
        display = Image.new("RGB", (240, 400), "white")
        ImageDraw.Draw(display).text((20, 300), "TEST 12345", fill="black", font=ImageFont.load_default(size=26))
        raw = display.transpose(Image.Transpose.ROTATE_90)
        exif = raw.getexif()
        exif[274] = 6
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/rotated.jpg"
            raw.save(p, exif=exif)
            result = analyze(p)
            self.assertEqual(result["image"], {"mimeType": "image/jpeg", "normalized": True})
            self.assertEqual((result["stats"]["width"], result["stats"]["height"]), display.size)
            line = next(line for line in result["ocr"]["lines"] if "12345" in line["text"])
            self.assertTrue(240 < line["box"][1] < line["box"][3] <= display.height, line)
            relay = base64.b64decode(analyze(p, mode="--relay")["data"])
            with Image.open(io.BytesIO(relay)) as png, Image.open(p) as jpeg:
                self.assertEqual(png.format, "PNG")
                self.assertEqual(png.size, display.size)
                self.assertIsNone(ImageChops.difference(png, ImageOps.exif_transpose(jpeg)).getbbox())

    def test_transparent_rgb_does_not_change_stats_or_relay(self):
        with tempfile.TemporaryDirectory() as td:
            outputs = []
            for i, hidden in enumerate(((0, 0, 0, 0), (255, 0, 0, 0))):
                img = Image.new("RGBA", (480, 240), hidden)
                ImageDraw.Draw(img).rectangle((160, 80, 319, 159), fill=(0, 140, 255, 200))
                p = f"{td}/{i}.png"
                img.save(p)
                result = analyze(p, mode="--stats-only")
                self.assertNotIn("ocr", result)
                self.assertEqual(result["image"], {"mimeType": "image/png", "normalized": True})
                outputs.append((result["stats"], analyze(p, mode="--relay")["data"]))
            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(outputs[0][0]["bg"], "#ffffff")

    def test_blob_limit_stops_scanning(self):
        class Checkerboard:
            shape = (480, 480)

            def __getitem__(self, row):
                # 240 runs per row. Row 83 crosses the 20,000-run limit.
                if row > 83:
                    raise AssertionError("CCL kept scanning past the run limit")
                return (np.arange(self.shape[1]) + row) % 2 == 0

        self.assertIsNone(_blob_stats(Checkerboard()))

    def test_lined_text_separates_solid_bands_from_ocr_rows(self):
        if not CJK:
            self.skipTest("no CJK font found")
        img = Image.new("L", (520, 300), 245)
        draw = ImageDraw.Draw(img)
        font = ImageFont.truetype(CJK, 17)
        expected = []
        for i in range(6):
            y = 16 + i * 34
            text = f"第{i+1:02d}行 金额{1206 + i * 17} 项目AB{i+41}"
            expected.append(text.replace(" ", ""))
            draw.text((32, y), text, font=font, fill=25)
            draw.line((10, y+29, 509, y+29), fill=25)
        with tempfile.TemporaryDirectory() as td:
            p = f"{td}/lined.png"
            img.save(p)
            result = analyze(p)
        self.assertEqual(result["stats"]["estimatedTextRows"], 12)
        self.assertEqual(result["stats"]["solidRowBands"], 6)
        self.assertEqual(["".join(line["text"].split()) for line in result["ocr"]["lines"]], expected)

    def test_row_gap_uses_the_same_merged_bands_as_the_count(self):
        img = Image.new("L", (480, 240), 255)
        draw = ImageDraw.Draw(img)
        for y in (60, 80, 100):
            draw.line((60, y, 140, y), fill=0)
            draw.line((60, y+3, 140, y+3), fill=0)
        stats = lane0(img)
        self.assertEqual(stats["estimatedTextRows"], 3)
        self.assertEqual(stats["rowGap"], 20)
        self.assertTrue(stats["rowGapRegular"])

    def test_grid_hue_is_independent_of_the_ink_mask(self):
        img = Image.new("RGB", (480, 240), (255, 0, 0))
        self.assertEqual(lane0(img)["grid"]["cells"], ["········"] * 6)
        ImageDraw.Draw(img).rectangle((240, 0, 479, 239), fill=(0, 130, 0))
        stats = lane0(img)
        self.assertEqual(stats["estimatedTextRows"], 0)  # both halves have gray value 76
        self.assertEqual(stats["grid"]["cells"], ["RRRRGGGG"] * 6)

        img = Image.new("RGB", (480, 240), "black")
        draw = ImageDraw.Draw(img)
        draw.rectangle((120, 40, 179, 79), fill=(255, 248, 0))
        draw.rectangle((300, 40, 359, 79), fill=(0, 204, 255))
        self.assertEqual(lane0(img)["grid"]["cells"][1], "··Y··C··")

        with Image.open(ROOT / "tests/fixtures/judge-2026-11-01/judge3.png") as img:
            self.assertIn("Y", "".join(lane0(img)["grid"]["cells"]))  # thin yellow ring

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
            self.assertTrue(any(ch in "░▒▓█≡" for row in s["grid"]["cells"] for ch in row))
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
