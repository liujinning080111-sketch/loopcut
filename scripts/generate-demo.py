#!/usr/bin/env python3
"""Generate the synthetic local MP4 fixture; no screenshots or external images.

Python dependencies (fixture generation only): Pillow 13.0.0, imageio-ffmpeg 0.6.0.
Example: python -m pip install Pillow==13.0.0 imageio-ffmpeg==0.6.0
         python scripts/generate-demo.py
"""
from __future__ import annotations

import math
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "demo.mp4"
SCALE = 3
WIDTH, HEIGHT, FPS = 360 * SCALE, 640 * SCALE, 30
LOOP_FRAMES, LOOPS = 60, 3
STICKER_X, STICKER_Y, STICKER_WIDTH, STICKER_HEIGHT = 240, 780, 600, 600


def coordinates(values: tuple[float, ...]) -> tuple[float, ...]:
    """Scale vector coordinates before drawing, never resize a raster image."""
    return tuple(value * SCALE for value in values)


def draw_frame(index: int) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "#f4f5f8")
    draw = ImageDraw.Draw(image)
    # Every shape, stroke and font is rasterized directly at 1080 × 1920.
    # There is no low-resolution intermediate or image.resize() operation.
    font = ImageFont.load_default(size=20 * SCALE)
    small = ImageFont.load_default(size=12 * SCALE)
    draw.rounded_rectangle((0, 0, WIDTH - 1, 80 * SCALE), radius=16 * SCALE, fill="#ffffff")
    draw.text(coordinates((24, 24)), "Comments", font=font, fill="#20283b")
    draw.text(coordinates((24, 55)), "A synthetic recording for LoopCut", font=small, fill="#8b92a4")
    for y, color, widths in [(115, "#c9d7f8", [170, 230]), (210, "#e2cbf5", [140]), (505, "#bfe5d8", [196, 150])]:
        draw.ellipse(coordinates((22, y, 54, y + 32)), fill=color)
        draw.rounded_rectangle(coordinates((72, y + 3, 148, y + 10)), radius=3 * SCALE, fill="#a8afbd")
        for row, width in enumerate(widths):
            draw.rounded_rectangle(coordinates((72, y + 22 + row * 14, 72 + width, y + 28 + row * 14)), radius=3 * SCALE, fill="#d1d6df")
    draw.rounded_rectangle(coordinates((24, 590, 336, 626)), radius=18 * SCALE, fill="#ffffff")
    draw.text(coordinates((44, 602)), "Write a comment...", font=small, fill="#9ba2b0")

    # Known native sticker canvas: x=240, y=780, width=600, height=600.
    # The untouched white border is a reliable background-keying reference.
    draw.rectangle((STICKER_X, STICKER_Y,
                    STICKER_X + STICKER_WIDTH - 1, STICKER_Y + STICKER_HEIGHT - 1), fill="#ffffff")
    phase = 2 * math.pi * (index % LOOP_FRAMES) / LOOP_FRAMES
    cx, cy = 177, 363 + 4 * math.sin(phase)
    yellow, outline, ink = "#ffcf4b", "#e4ac30", "#36364b"
    # The face bobs slightly; its body remains present throughout the animation.
    draw.ellipse(coordinates((cx - 54, cy - 54, cx + 54, cy + 54)), fill=yellow, outline=outline, width=2 * SCALE)
    draw.ellipse(coordinates((cx - 30, cy + 44, cx - 9, cy + 59)), fill=yellow, outline=outline, width=2 * SCALE)
    draw.ellipse(coordinates((cx + 9, cy + 44, cx + 30, cy + 59)), fill=yellow, outline=outline, width=2 * SCALE)
    # Once-per-cycle blink disambiguates the complete loop from half a wave.
    blink = 24 <= index % LOOP_FRAMES < 30
    for x in [cx - 18, cx + 18]:
        if blink:
            draw.line(coordinates((x - 5, cy - 12, x + 5, cy - 12)), fill=ink, width=4 * SCALE)
        else:
            draw.ellipse(coordinates((x - 4, cy - 19, x + 4, cy - 6)), fill=ink)
    draw.arc(coordinates((cx - 22, cy - 8, cx + 22, cy + 28)), start=10, end=170, fill=ink, width=4 * SCALE)
    draw.ellipse(coordinates((cx - 37, cy + 3, cx - 23, cy + 10)), fill="#f5ab60")
    draw.ellipse(coordinates((cx + 23, cy + 3, cx + 37, cy + 10)), fill="#f5ab60")
    hx, hy = 244 + 9 * math.sin(phase), 316 + 17 * math.cos(phase)
    draw.line(coordinates((cx + 46, cy + 8, hx, hy)), fill=outline, width=15 * SCALE)
    draw.line(coordinates((cx + 46, cy + 8, hx, hy)), fill=yellow, width=11 * SCALE)
    draw.ellipse(coordinates((hx - 12, hy - 12, hx + 12, hy + 12)), fill=yellow, outline=outline, width=2 * SCALE)
    draw.line(coordinates((hx - 5, hy - 8, hx - 3, hy)), fill=outline, width=2 * SCALE)
    draw.line(coordinates((hx + 2, hy - 9, hx + 3, hy)), fill=outline, width=2 * SCALE)
    return image


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
               "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264",
               "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p",
               "-crf", "18", "-preset", "medium", "-movflags", "+faststart", str(OUTPUT)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for index in range(LOOP_FRAMES * LOOPS):
            process.stdin.write(draw_frame(index).tobytes())
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("Fixture encoding failed")
    if OUTPUT.stat().st_size >= 1024 * 1024:
        raise RuntimeError("Fixture exceeds the 1 MiB budget")
    print(f"{OUTPUT}: {OUTPUT.stat().st_size} bytes; {WIDTH}x{HEIGHT}; {FPS} fps; 6 s; 2 s loop × 3")


if __name__ == "__main__":
    main()
