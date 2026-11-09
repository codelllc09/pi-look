#!/usr/bin/env python3
"""pi-look analyzer — Lane 0 (pixel stats) + Lane 1 (RapidOCR, PP-OCRv6) in one shot.

Prints a single JSON object to stdout. Exit codes: 0 ok, 2 usage, 3 image error.

Lane 0 measures objective, pixel-level facts only (dimensions, dominant
colors, estimated text rows via horizontal projection). It never interprets.
Lane 1 runs RapidOCR (the `rapidocr` package; `rapidocr-onnxruntime` is EOL)
and reports per-line confidence. Tofu markers (□, U+FDD0..U+FDEF, U+FFFD)
are counted in the *recognized text*, where they are unambiguous characters
— not guessed from pixels.

Usage: analyze.py [--stats-only | --relay] <image> [tier]
  --stats-only: skip OCR; --relay: output the normalized image as base64 PNG
  tier: v6-small (default, bundled in the wheel, offline) | v6-medium
        | v5-mobile | v5-server | v4-mobile   (non-bundled tiers download
        on first use; invalid tiers fall back to v6-small)
Known v6 rec quirk: fullwidth punctuation may be normalized to halfwidth
(：→:); spacing between CJK and latin runs is preserved as recognized.
"""
import base64
import io
import json
import sys
from colorsys import rgb_to_hsv

try:
    import numpy as np
    from PIL import Image, ImageOps
except ImportError as e:
    print(
        f"pi-look analyzer deps missing ({e}). Install for this interpreter, e.g.:\n"
        "  uv pip install -r scripts/requirements.txt",
        file=sys.stderr,
    )
    sys.exit(3)


def _otsu(gray: "np.ndarray") -> tuple[int, bool]:
    """Otsu threshold (t, valid). valid=False on unimodal images (no split
    reduces within-class variance) — callers must treat ink as empty."""
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total = float(gray.size)
    sum_all = float((np.arange(256) * hist).sum())
    w_b = 0.0
    sum_b = 0.0
    best_t, best_var = 0, -1.0
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        var_between = w_b * w_f * (sum_b / w_b - (sum_all - sum_b) / w_f) ** 2
        if var_between > best_var:
            best_var, best_t = var_between, t
    return best_t, best_var > 0


def _sobel_mag(gray: "np.ndarray") -> "np.ndarray":
    """Sobel gradient magnitude (pure numpy slicing, no scipy/cv2)."""
    g = gray.astype(np.float32)
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[1:-1, 1:-1] = (g[:-2, 2:] + 2 * g[1:-1, 2:] + g[2:, 2:]) - (g[:-2, :-2] + 2 * g[1:-1, :-2] + g[2:, :-2])
    gy[1:-1, 1:-1] = (g[2:, :-2] + 2 * g[2:, 1:-1] + g[2:, 2:]) - (g[:-2, :-2] + 2 * g[:-2, 1:-1] + g[:-2, 2:])
    return np.hypot(gx, gy)


def _blob_stats(mask: "np.ndarray") -> dict | None:
    """Run-based connected components over the ink mask (union-find +
    two-pointer overlap). Returns compact objective facts: count, dominant
    size class, area uniformity, horizontal skew. None when nothing or the
    mask is noise-dense (>20k runs — photos)."""
    h, w = mask.shape
    parent: list[int] = []
    runs: list[tuple[int, int, int]] = []  # (start, end, row)

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    prev: list[int] = []  # run indexes of the previous row
    for y in range(h):
        row = mask[y]
        d = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
        starts = np.flatnonzero(d == 1)
        if len(runs) + len(starts) > 20000:
            return None
        ends = np.flatnonzero(d == -1)
        cur: list[int] = []
        for s, e in zip(starts.tolist(), ends.tolist()):
            idx = len(runs)
            runs.append((s, e, y))
            parent.append(idx)
            cur.append(idx)
        # two-pointer union with overlapping previous-row runs (both sorted by start)
        pi = 0
        for idx in cur:
            s0, e0, _ = runs[idx]
            while pi < len(prev) and runs[prev[pi]][1] <= s0:
                pi += 1
            pj = pi
            while pj < len(prev) and runs[prev[pj]][0] < e0:
                ri, rj = find(idx), find(prev[pj])
                if ri != rj:
                    parent[ri] = rj
                pj += 1
        prev = cur
    if not runs:
        return None

    area: dict[int, int] = {}
    cxw: dict[int, int] = {}  # centroid-x weight (sum of run center × length)
    for i, (s, e, y) in enumerate(runs):
        r = find(i)
        area[r] = area.get(r, 0) + (e - s)
        cxw[r] = cxw.get(r, 0) + (s + e) // 2 * (e - s)
    kept = {r: a for r, a in area.items() if a >= 8}
    if not kept:
        return None
    total_px = w * h
    classes = {"small": 0, "medium": 0, "large": 0}
    areas = []
    for a in kept.values():
        areas.append(a)
        classes["small" if a < 0.01 * total_px else "medium" if a < 0.08 * total_px else "large"] += 1
    size = max(classes, key=lambda k: classes[k])
    arr = np.array(areas, dtype=np.float64)
    uniform = bool(arr.std() / arr.mean() < 0.5) if len(arr) > 2 else None
    centroid = sum(cxw[r] for r in kept) / sum(kept.values())
    skew = "left" if centroid < 0.35 * w else "right" if centroid > 0.65 * w else None
    return {"count": len(kept), "size": size, "uniform": uniform, "skew": skew}


def _hex(c) -> str:
    r, g, b = (int(max(0, min(255, round(float(v))))) for v in c)
    return f"#{r:02x}{g:02x}{b:02x}"


def _projection_bands(coverage: "np.ndarray") -> list[list[int]]:
    """Merge active spans separated by up to three blank pixels."""
    bands: list[list[int]] = []
    for pos in np.flatnonzero(coverage > 0.02).tolist():
        if bands and pos - bands[-1][1] <= 4:
            bands[-1][1] = pos
        else:
            bands.append([pos, pos])
    return bands


def _is_solid_row_band(band: "np.ndarray") -> bool:
    """Each scanline must have one aligned run at least half the image wide."""
    width = band.shape[1]
    lengths = band.sum(axis=1)
    if np.any(lengths * 2 < width):
        return False
    left = band.argmax(axis=1)
    right = width - band[:, ::-1].argmax(axis=1)
    return bool(np.all(right - left == lengths) and np.ptp(left) <= 2 and np.ptp(right) <= 2)


def _structure(rgb480: "np.ndarray", gray: "np.ndarray", mask: "np.ndarray", valid: bool, bands: list[list[int]], h: int, small: Image.Image) -> dict:
    """Objective structure facts derived from pixels: bg/ink separation,
    colorfulness, grayscale, accent colors, column bands, row-gap regularity,
    and a density/hue grid thumbnail. Never interprets."""
    out: dict = {}
    f = rgb480.astype(np.float32)
    if valid and mask.any():
        out["bg"] = _hex(f[~mask].mean(axis=0))
        out["ink"] = _hex(f[mask].mean(axis=0))
    else:
        out["bg"] = _hex(f.mean(axis=(0, 1)))
        out["ink"] = None

    rg = f[..., 0] - f[..., 1]
    yb = 0.5 * (f[..., 0] + f[..., 1]) - f[..., 2]
    cf = float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))
    out["colorfulness"] = "low" if cf < 15 else "medium" if cf < 45 else "high"
    spread = f.max(axis=2) - f.min(axis=2)
    out["gray"] = bool(np.percentile(spread, 95) < 8)

    # Accent: saturated, small-share palette colors (12-color quantize).
    try:
        q12 = small.quantize(colors=12)
        pal = q12.getpalette() or []
        for cnt, idx in sorted(q12.getcolors() or [], reverse=True):
            base = idx * 3
            if base + 2 >= len(pal) or len(out.get("accent", [])) >= 2:
                break
            r, g, b = float(pal[base]), float(pal[base + 1]), float(pal[base + 2])
            mx, mn = max(r, g, b), min(r, g, b)
            share = cnt / (small.size[0] * small.size[1])
            if mx <= 0 or (mx - mn) / mx < 0.35 or not (0.005 <= share <= 0.15):
                continue
            out.setdefault("accent", []).append({"hex": f"#{int(r):02x}{int(g):02x}{int(b):02x}", "share": round(share, 3)})
    except Exception:
        pass

    # Merge per-character gaps before dropping bands narrower than 5%.
    xbands = _projection_bands(mask.mean(axis=0))
    xbands = [b for b in xbands if (b[1] - b[0]) >= 0.05 * mask.shape[1]]
    out["columns"] = min(len(xbands), 5) if len(xbands) >= 2 else 1

    out["blobs"] = _blob_stats(mask) if valid else None

    # Row-gap regularity (display scale = original px).
    gh, gw = mask.shape
    if len(bands) >= 3:
        gaps = np.diff([start for start, _ in bands])
        out["rowGap"] = int(round(float(np.median(gaps)) * h / gh))
        out["rowGapRegular"] = bool(float(gaps.std() / gaps.mean()) < 0.15)

    # Hue uses RGB contrast independently of the grayscale ink mask.
    image_rgb = np.asarray(small).mean(axis=(0, 1))
    edge = _sobel_mag(gray) > 48
    cn, rn = min(8, max(1, gw // 40)), min(6, max(1, gh // 40))
    rows = []
    for r in range(rn):
        s = ""
        for c in range(cn):
            ys, ye = r * gh // rn, (r + 1) * gh // rn
            xs, xe = c * gw // cn, (c + 1) * gw // cn
            cell = mask[ys:ye, xs:xe]
            d = float(cell.mean()) if cell.size else 0.0
            de = float(edge[ys:ye, xs:xe].mean()) if cell.size else 0.0
            mean_rgb = f[ys:ye, xs:xe].mean(axis=(0, 1))
            hue, saturation, _ = rgb_to_hsv(*(mean_rgb / 255))
            if saturation > 0.30 and np.abs(mean_rgb - image_rgb).max() >= 10:
                s += "RYGCBM"[int(hue * 6 + 0.5) % 6]
            elif de >= 0.10:
                s += "≡"
            else:
                s += "·" if d < 0.05 else "░" if d < 0.2 else "▒" if d < 0.5 else "▓" if d < 0.8 else "█"
        rows.append(s)
    out["grid"] = {"cols": cn, "rows": rn, "cells": rows}
    return out


def _normalize_image(img: Image.Image) -> tuple[Image.Image, bool]:
    """Shared RGB pixels and whether the original needs re-encoding for VLM."""
    oriented = img.getexif().get(274) in range(2, 9)
    if oriented:
        ImageOps.exif_transpose(img, in_place=True)
    if img.has_transparency_data:
        rgba = img if img.mode == "RGBA" else img.convert("RGBA")
        alpha = rgba.getchannel("A")
        if alpha.getextrema()[0] < 255:
            # Estimate visible brightness with a small, alpha-weighted sample.
            # A contrasting matte keeps both light and dark glyphs legible.
            sample = rgba.resize((min(img.width, 160), min(img.height, 160)), Image.Resampling.BOX)
            weights = np.asarray(sample.getchannel("A"))
            lightness = np.asarray(sample.convert("L"))
            matte = 255 if not weights.any() or np.average(lightness, weights=weights) < 128 else 0
            rgb = Image.new("RGB", img.size, (matte, matte, matte))
            rgb.paste(rgba, mask=alpha)
            return rgb, True
    return (img if img.mode == "RGB" else img.convert("RGB")), oriented


def lane0(img: Image.Image) -> dict:
    rgb = img if img.mode == "RGB" else img.convert("RGB")
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
    # Vectorized numpy; ink cut at the Otsu threshold (adaptive, replaces the
    # old fixed 150/70 cuts that broke on low-contrast antialiasing).
    gray_img = rgb.convert("L").resize((min(w, 480), min(h, 480)))
    gray = np.asarray(gray_img, dtype=np.uint8)
    dark_bg = bool(gray.mean() < 128)
    t, valid = _otsu(gray)
    if not valid:
        mask = np.zeros(gray.shape, dtype=bool)
    else:
        # `<=` on light bg: Otsu's t can sit exactly on the dark mode's bin
        # (variance plateau), and a strict `<` would drop the whole mode.
        mask = gray > t if dark_bg else gray <= t
    bands = _projection_bands(mask.mean(axis=1))
    return {
        "width": w,
        "height": h,
        "theme": "dark" if dark_bg else "light",
        "dominantColors": dom,
        "estimatedTextRows": len(bands),
        "solidRowBands": sum(1 for start, end in bands if _is_solid_row_band(mask[start:end+1])),
        **_structure(np.asarray(rgb.resize(gray_img.size)), gray, mask, valid, bands, h, small),
    }


def _is_tofu(ch: str) -> bool:
    cp = ord(ch)
    return ch == "□" or ch == "\ufffd" or 0xFDD0 <= cp <= 0xFDEF


def _cjk_ratio(text: str) -> float:
    """Share of CJK chars (Han + kana + hangul, ext-A included) in text."""
    if not text:
        return 0.0
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf" or "\u3040" <= ch <= "\u30ff" or "\uac00" <= ch <= "\ud7af")
    return round(cjk / len(text), 3)


def _reading_order(lines: list) -> tuple[list, int]:
    """Order lines column-major (columns left-to-right, top-down inside a
    column) via an x-overlap component graph. Two lines share a column when
    their x-ranges overlap >= half the narrower box. Full-width lines bridge
    columns — transitivity then collapses the page to a single column, which
    degrades to plain top-down (never worse than the raw detector order).
    Returns (ordered indexes, column count >= 1)."""
    n = len(lines)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            a, b = lines[i]["box"], lines[j]["box"]
            ow = min(a[2], b[2]) - max(a[0], b[0])
            if ow > 0 and ow >= 0.5 * min(a[2] - a[0], b[2] - b[0]):
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj
    comps: dict[int, list[int]] = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(i)
    groups = sorted(comps.values(), key=lambda idxs: min(lines[i]["box"][0] for i in idxs))
    ordered: list[int] = []
    for g in groups:
        ordered.extend(sorted(g, key=lambda i: (lines[i]["box"][1], lines[i]["box"][0])))
    return ordered, max(len(groups), 1)


def _detect_tables(lines: list) -> list:
    """Conservative table detection: >=2 y-consecutive visual rows, each with
    >=2 separate boxes whose left edges align across rows (same cell count,
    tolerance max(6px, 2% width)). Each detected box is one cell. Merged
    single-box lines can never form tables. Returns [{"rows": [[line idx...]]}]
    with indexes into the (reordered) lines list."""
    if len(lines) < 2:
        return []
    heights = sorted(l["box"][3] - l["box"][1] for l in lines)
    mh = heights[len(heights) // 2] or 1
    width = max(l["box"][2] for l in lines)
    tol = max(6.0, 0.02 * width)

    idx = sorted(range(len(lines)), key=lambda i: (lines[i]["box"][1] + lines[i]["box"][3]) / 2)
    rows: list[dict] = []
    for i in idx:
        yc = (lines[i]["box"][1] + lines[i]["box"][3]) / 2
        if rows and abs(yc - rows[-1]["yc"]) <= 0.6 * mh:
            rows[-1]["idxs"].append(i)
            rows[-1]["yc"] = (rows[-1]["yc"] + yc) / 2
        else:
            rows.append({"yc": yc, "idxs": [i]})

    def aligned(a: list, b: list) -> bool:
        if len(a) != len(b) or len(a) < 2:
            return False
        ax = sorted(lines[i]["box"][0] for i in a)
        bx = sorted(lines[i]["box"][0] for i in b)
        return all(abs(x - y) <= tol for x, y in zip(ax, bx))

    tables = []
    i = 0
    while i < len(rows):
        if len(rows[i]["idxs"]) >= 2:
            j = i
            while (
                j + 1 < len(rows)
                and len(rows[j + 1]["idxs"]) >= 2
                and rows[j + 1]["yc"] - rows[j]["yc"] <= 2.5 * mh
                and aligned(rows[j]["idxs"], rows[j + 1]["idxs"])
            ):
                j += 1
            if j > i:
                tables.append({"rows": [sorted(rows[k]["idxs"], key=lambda x: lines[x]["box"][0]) for k in range(i, j + 1)]})
                i = j + 1
                continue
        i += 1
    return tables


def lane1(img: Image.Image, tier: str = "v6-small") -> dict:
    try:
        from rapidocr import RapidOCR, EngineType, ModelType, OCRVersion
    except Exception as e:  # pragma: no cover - environment dependent
        return {"available": False, "error": f"rapidocr unavailable: {e}", "lines": [], "avgConf": None, "text": "", "tofuCount": 0}
    tiers = {
        "v6-small": (OCRVersion.PPOCRV6, ModelType.SMALL),
        "v6-medium": (OCRVersion.PPOCRV6, ModelType.MEDIUM),
        "v5-mobile": (OCRVersion.PPOCRV5, ModelType.MOBILE),
        "v5-server": (OCRVersion.PPOCRV5, ModelType.SERVER),
        "v4-mobile": (OCRVersion.PPOCRV4, ModelType.MOBILE),
    }
    version, model_type = tiers.get(tier, tiers["v6-small"])
    params = {}
    for stage in ("Det", "Rec"):
        params[f"{stage}.engine_type"] = EngineType.ONNXRUNTIME
        params[f"{stage}.ocr_version"] = version
        params[f"{stage}.model_type"] = model_type
    ocr = RapidOCR(params=params)
    result = ocr(img)
    # numpy arrays: `or []` triggers ambiguous-truth ValueError — test against None
    txts = list(result.txts) if result.txts is not None else []
    scores = list(result.scores) if result.scores is not None else []
    boxes = list(result.boxes) if result.boxes is not None else []
    lines = []
    tofu = 0
    for text, conf, box in zip(txts, scores, boxes):
        try:
            text = str(text)
            conf = float(conf)
            pts = [(float(p[0]), float(p[1])) for p in box]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            b = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
        except Exception:
            continue
        tofu += sum(1 for c in text if _is_tofu(c))
        lines.append({"conf": round(conf, 3), "text": text, "box": b, "cjk": _cjk_ratio(text)})
    ordered, columns = _reading_order(lines)
    lines = [lines[i] for i in ordered]
    tables = _detect_tables(lines)
    total_chars = sum(len(l["text"]) for l in lines)
    cjk_share = round(sum(l["cjk"] * len(l["text"]) for l in lines) / total_chars, 3) if total_chars else 0.0
    avg = round(sum(l["conf"] for l in lines) / len(lines), 3) if lines else None
    joined = "\n".join(l["text"] for l in lines)
    return {
        "available": True,
        "tier": tier,
        "lines": lines,
        "avgConf": avg,
        "text": joined,
        "tofuCount": tofu,
        "columns": columns,
        "cjkShare": cjk_share,
        "tables": tables,
    }


def main() -> int:
    args = sys.argv[1:]
    mode = args.pop(0) if args and args[0] in ("--stats-only", "--relay") else None
    if len(args) not in (1, 2) or (mode is not None and len(args) != 1):
        print("usage: analyze.py [--stats-only | --relay] <image> [tier]", file=sys.stderr)
        return 2
    try:
        with Image.open(args[0]) as src:
            src.load()
            mime = Image.MIME.get(src.format)
            img, normalized = _normalize_image(src)
    except Exception as e:
        print(json.dumps({"error": f"cannot open image: {e}"}))
        return 3
    if mode == "--relay":
        png = io.BytesIO()
        img.save(png, format="PNG")
        print(json.dumps({"data": base64.b64encode(png.getbuffer()).decode("ascii")}))
        return 0
    out = {"stats": lane0(img), "image": {"mimeType": mime or "image/png", "normalized": normalized or mime is None}}
    if mode != "--stats-only":
        out["ocr"] = lane1(img, args[1] if len(args) == 2 else "v6-small")
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
