#!/usr/bin/env python3
"""Render CPOS screen grids (produced by `cargo run --bin gen_screenshots`)
into PNG screenshots with a terminal-style window chrome.

Usage:
    python3 tools/render_screens.py
"""
import glob
import json
import os

from PIL import Image, ImageDraw, ImageFont

SS = 3  # supersample factor for crisp anti-aliasing
SIZE = 17
DPI_SCALE = 2  # 2× output for retina displays
FONT_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Monaco.ttf",
    "/Library/Fonts/DejaVuSansMono.ttf",
]
SRC_DIR = "docs/screens"
OUT_DIR = "docs"

OUTER = "#07070b"
WINDOW = "#0d0d14"
WINDOW_BORDER = "#23233a"
TITLE_FG = "#6c6c84"
DEFAULT_FG = "#d6d6e0"
DOTS = ["#ff5f57", "#febc2e", "#28c840"]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render(grid, out_path, title):
    font = load_font(SIZE * SS)
    title_font = load_font(int(SIZE * SS * 0.82))
    ascent, descent = font.getmetrics()
    cw = round(font.getlength("M"))
    ch = ascent + descent

    cols, rows = grid["cols"], grid["rows"]
    pad = 18 * SS
    titlebar = 34 * SS
    inner = 14 * SS

    grid_w = cols * cw
    grid_h = rows * ch
    win_w = grid_w + inner * 2
    win_h = titlebar + grid_h + inner * 2
    margin = 22 * SS
    W = win_w + margin * 2
    H = win_h + margin * 2

    img = Image.new("RGB", (W, H), OUTER)
    draw = ImageDraw.Draw(img)

    # Window panel with rounded corners.
    draw.rounded_rectangle(
        [margin, margin, margin + win_w, margin + win_h],
        radius=14 * SS,
        fill=WINDOW,
        outline=WINDOW_BORDER,
        width=max(1, SS),
    )

    # Title bar dots + label.
    cy = margin + titlebar // 2
    for i, color in enumerate(DOTS):
        cx = margin + (20 + i * 22) * SS
        r = 6 * SS
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    tw = title_font.getlength(title)
    draw.text((margin + win_w / 2 - tw / 2, cy - (SIZE * SS * 0.5)), title,
              font=title_font, fill=TITLE_FG)

    ox = margin + inner
    oy = margin + titlebar + inner

    for cell in grid["cells"]:
        x, y = cell["x"], cell["y"]
        px = ox + x * cw
        py = oy + y * ch
        if "bg" in cell and cell["bg"]:
            draw.rectangle([px, py, px + cw, py + ch], fill=cell["bg"])
        symbol = cell["ch"]
        if symbol.strip():
            fg = cell.get("fg") or DEFAULT_FG
            draw.text((px, py), symbol, font=font, fill=fg)
            if cell.get("b"):
                draw.text((px + SS, py), symbol, font=font, fill=fg)

    img = img.resize(((W // SS) * DPI_SCALE, (H // SS) * DPI_SCALE), Image.LANCZOS)
    img.save(out_path, optimize=True)
    print(f"rendered {out_path}")

    # Web-optimized copies for the landing page.
    web_dir = os.path.join(OUT_DIR, "img")
    os.makedirs(web_dir, exist_ok=True)
    display_w = 1800
    display_h = int(img.height * display_w / img.width)
    web = img.resize((display_w, display_h), Image.LANCZOS)
    base = os.path.splitext(os.path.basename(out_path))[0]
    if base in {"dashboard", "problems", "contests", "analytics", "practice", "recommend"}:
        web.save(os.path.join(web_dir, f"{base}.webp"), "WEBP", quality=92, method=6)
        web.save(os.path.join(web_dir, f"{base}.png"), "PNG", optimize=True)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for path in sorted(glob.glob(f"{SRC_DIR}/*.json")):
        name = os.path.splitext(os.path.basename(path))[0]
        with open(path) as f:
            grid = json.load(f)
        title = f"cpos — {name}"
        render(grid, f"{OUT_DIR}/{name}.png", title)


if __name__ == "__main__":
    main()
