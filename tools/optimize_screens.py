#!/usr/bin/env python3
"""Build web-optimized screenshots for the landing page.

Usage:
    python3 tools/optimize_screens.py
"""
import os

from PIL import Image

SCREENS = ["dashboard", "problems", "contests", "analytics", "practice"]
SRC_DIR = "docs"
OUT_DIR = "docs/img"
DISPLAY_W = 1105


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name in SCREENS:
        src = f"{SRC_DIR}/{name}.png"
        im = Image.open(src)
        h = int(im.height * DISPLAY_W / im.width)
        out = im.resize((DISPLAY_W, h), Image.LANCZOS)

        webp_path = f"{OUT_DIR}/{name}.webp"
        png_path = f"{OUT_DIR}/{name}.png"
        out.save(webp_path, "WEBP", quality=80, method=6)
        out.save(png_path, "PNG", optimize=True)

        webp_kb = os.path.getsize(webp_path) // 1024
        png_kb = os.path.getsize(png_path) // 1024
        print(f"{name}: webp {webp_kb}K, png {png_kb}K")


if __name__ == "__main__":
    main()
