#!/usr/bin/env python3
"""バド帖アイコン生成スクリプト。一度実行してPNGを作る。"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
FONT_CANDIDATES = [
    os.path.expanduser("~/Library/Fonts/ZenOldMincho-Black.ttf"),
    os.path.expanduser("~/Library/Fonts/ZenOldMincho-Bold.ttf"),
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]

# 暗めの暖色（焦茶〜深紅褐色の中間）
BG = (90, 41, 24)        # #5A2918
INK = (247, 241, 227)    # #F7F1E3 (ベージュ、style.cssの--bgと一致)
ACCENT = (184, 168, 127) # #B8A87F (style.cssの--accent-soft)


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    raise RuntimeError("Japanese font not found")


def make_icon(size, char="帖", out_name=None):
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)

    # 細い縁取り（伝統的な印章のニュアンス）
    border = max(2, size // 96)
    inset = size // 14
    draw.rectangle(
        [inset, inset, size - inset - 1, size - inset - 1],
        outline=ACCENT,
        width=border,
    )

    # 文字を中央に配置
    font_size = int(size * 0.6)
    font = load_font(font_size)
    bbox = draw.textbbox((0, 0), char, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), char, font=font, fill=INK)

    out_path = os.path.join(OUT_DIR, out_name)
    img.save(out_path, "PNG")
    print(f"wrote {out_path}")


def make_maskable(size, char="帖", out_name=None):
    """maskable icon: safe area = inner 80%"""
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)
    font_size = int(size * 0.45)
    font = load_font(font_size)
    bbox = draw.textbbox((0, 0), char, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), char, font=font, fill=INK)
    out_path = os.path.join(OUT_DIR, out_name)
    img.save(out_path, "PNG")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    make_icon(192, out_name="icon-192.png")
    make_icon(512, out_name="icon-512.png")
    make_maskable(512, out_name="icon-maskable-512.png")
    # Apple touch icon
    make_icon(180, out_name="apple-touch-icon.png")
