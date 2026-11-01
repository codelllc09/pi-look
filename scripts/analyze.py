#!/usr/bin/env python3
"""pi-look analyzer — Lane 0 (pixel stats) + Lane 1 (RapidOCR) in one shot.

Prints a single JSON object to stdout. Exit codes: 0 ok, 2 usage, 3 image error.

Lane 0 measures objective, pixel-level facts only (dimensions, dominant
colors, estimated text rows via horizontal projection). It never interprets.
Lane 1 runs RapidOCR and reports per-line confidence. Tofu markers (□,
U+FDD0..U+FDEF, U+FFFD) are counted in the *recognized text*, where they are
unambiguous characters — not guessed from pixels.
"""
import io
import json
import sys
import unicodedata

try:
    from PIL import Image
except ImportError:
    print(
        "pi-look analyzer deps missing. Install for this interpreter, e.g.:\n"
        "  uv pip install pillow rapidocr-onnxruntime\n"
        "  pip install pillow rapidocr-onnxruntime",
        file=sys.stderr,
    )
    sys.exit(3)


def lane0(img: Image.Image) -> dict:
    rgb = img.convert("RGB")
    w, h = rgb.size
    # Dominant colors via downscaled quantize (fast, good enough for hints).
    small = rgb.resize((min(w, 160), min(h, 160)))
    q = small.quantize(colors=6)
    palette = q.getpalette() or []
    counts = sorted(q.getcolors() or [], reverse=True)[:3]
    dom = []
    for cnt, idx in counts:
        base = idx * 3
        if base + 2 < len(palette):
            r, g, b = palette[base : base + 3]
            dom.append({"hex": f"#{r:02x}{g:02x}{b:02x}", "share": round(cnt / (small.size[0] * small.size[1]), 3)})
    # Text-row estimate: horizontal projection of "ink" (dark on light or
    # light on dark) density, then count row-bands above a threshold.
    gray = rgb.convert("L").resize((min(w, 480), min(h, 480)))
    px = list(gray.getdata()) if not hasattr(gray, "get_flattened_data") else list(gray.get_flattened_data())
    gw, gh = gray.size
    dark_bg = sum(px) / len(px) < 128
    row_ink = []
    for y in range(gh):
        ink = 0
        for x in range(gw):
            v = px[y * gw + x]
            if (dark_bg and v > 150) or (not dark_bg and v < 70):
                ink += 1
        row_ink.append(ink / gw)
    bands_raw = []
    inside = False
    for y, v in enumerate(row_ink):
        if v > 0.02 and not inside:
            bands_raw.append([y, y])
            inside = True
        elif v > 0.02:
            bands_raw[-1][1] = y
        else:
            inside = False
    # Merge bands separated by tiny gaps (descenders/antialiasing splits).
    bands = 0
    prev_end = None
    for start, end in bands_raw:
        if prev_end is not None and start - prev_end <= 4:
            prev_end = end
        else:
            bands += 1
            prev_end = end
    return {
        "width": w,
        "height": h,
        "theme": "dark" if dark_bg else "light",
        "dominantColors": dom,
        "estimatedTextRows": bands,
    }


def _is_tofu(ch: str) -> bool:
    cp = ord(ch)
    return ch == "□" or ch == "\ufffd" or 0xFDD0 <= cp <= 0xFDEF


def lane1(path: str) -> dict:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:  # pragma: no cover - environment dependent
        return {"available": False, "error": f"rapidocr unavailable: {e}", "lines": [], "avgConf": None, "text": "", "tofuCount": 0}
    ocr = RapidOCR()
    result, _ = ocr(path)
    lines = []
    tofu = 0
    for item in result or []:
        # RapidOCR items: [box, text, confidence]
        try:
            text = str(item[1])
            conf = float(item[2])
            pts = [(float(p[0]), float(p[1])) for p in item[0]]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            box = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
        except Exception:
            continue
        tofu += sum(1 for c in text if _is_tofu(c))
        lines.append({"conf": round(conf, 3), "text": text, "box": box})
    avg = round(sum(l["conf"] for l in lines) / len(lines), 3) if lines else None
    joined = "\n".join(l["text"] for l in lines)
    return {"available": True, "lines": lines, "avgConf": avg, "text": joined, "tofuCount": tofu}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: analyze.py <image>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    try:
        img = Image.open(io.open(path, "rb"))
        img.load()
    except Exception as e:
        print(json.dumps({"error": f"cannot open image: {e}"}))
        return 3
    out = {"stats": lane0(img), "ocr": lane1(path)}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
