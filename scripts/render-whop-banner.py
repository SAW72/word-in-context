#!/usr/bin/env python3
"""Render Whop storefront assets (2000x1000 banner, 400x400 avatar)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG_TOP = (26, 37, 47)      # #1a252f
BG_BOTTOM = (44, 62, 80)   # #2c3e50
GOLD = (201, 162, 39)      # #c9a227
WHITE = (255, 255, 255)
MUTED = (245, 232, 211)    # #f5e8d3


def load_font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def vertical_gradient(size):
    w, h = size
    img = Image.new("RGB", size)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    return img


def draw_cross(draw, cx, cy, scale=1.0):
    t = int(28 * scale)
    v_h = int(220 * scale)
    h_w = int(140 * scale)
    draw.rectangle([cx - t // 2, cy - v_h // 2, cx + t // 2 - 1, cy + v_h // 2], fill=GOLD)
    draw.rectangle([cx - h_w // 2, cy - v_h // 2 + int(36 * scale), cx + h_w // 2 - 1, cy - v_h // 2 + int(36 * scale) + t - 1], fill=GOLD)


def render_banner():
    w, h = 2000, 1000
    img = vertical_gradient((w, h))
    draw = ImageDraw.Draw(img)

    draw_cross(draw, 320, h // 2, scale=1.35)

    title_font = load_font(108, bold=True)
    sub_font = load_font(52, bold=False)
    tag_font = load_font(36, bold=False)

    x = 520
    y = 300
    draw.text((x, y), "Ask AI, John", font=title_font, fill=WHITE)
    draw.text((x, y + 130), "Voice-first Bible study", font=sub_font, fill=GOLD)
    draw.text((x, y + 210), "Greek • Hebrew • Literal English • AI study", font=tag_font, fill=MUTED)

    # subtle bottom rule
    draw.rectangle([520, 880, 1880, 884], fill=GOLD)

    out = OUT / "whop-banner-2000x1000.png"
    img.save(out, "PNG", optimize=True)
    print(f"Wrote {out}")


def render_avatar():
    src = OUT / "icon-512.png"
    if not src.exists():
        raise SystemExit(f"Missing {src}")
    icon = Image.open(src).convert("RGBA")
    icon = icon.resize((400, 400), Image.Resampling.LANCZOS)
    out = OUT / "whop-avatar-400x400.png"
    icon.save(out, "PNG", optimize=True)
    print(f"Wrote {out}")


if __name__ == "__main__":
    render_banner()
    render_avatar()