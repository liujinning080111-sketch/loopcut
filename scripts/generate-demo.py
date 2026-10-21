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
WIDTH, HEIGHT, FPS = 360, 640, 15
LOOP_FRAMES, LOOPS = 30, 3


def draw_frame(index: int) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "#f4f5f8")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=20)
    small = ImageFont.load_default(size=12)
    draw.rounded_rectangle((0, 0, 359, 80), radius=16, fill="#ffffff")
    draw.text((24, 24), "Comments", font=font, fill="#20283b")
    draw.text((24, 55), "A synthetic recording for LoopCut", font=small, fill="#8b92a4")
    for y, color, widths in [(115, "#c9d7f8", [170, 230]), (210, "#e2cbf5", [140]), (505, "#bfe5d8", [196, 150])]:
        draw.ellipse((22, y, 54, y + 32), fill=color)
        draw.rounded_rectangle((72, y + 3, 148, y + 10), radius=3, fill="#a8afbd")
        for row, width in enumerate(widths):
            draw.rounded_rectangle((72, y + 22 + row * 14, 72 + width, y + 28 + row * 14), radius=3, fill="#d1d6df")
    draw.rounded_rectangle((24, 590, 336, 626), radius=18, fill="#ffffff")
    draw.text((44, 602), "Write a comment...", font=small, fill="#9ba2b0")

    # Known sticker canvas: x=80, y=260, width=200, height=200.
    # The untouched white border is a reliable background-keying reference.
    draw.rectangle((80, 260, 279, 459), fill="#ffffff")
    phase = 2 * math.pi * (index % LOOP_FRAMES) / LOOP_FRAMES
    cx, cy = 177, 363 + 4 * math.sin(phase)
    yellow, outline, ink = "#ffcf4b", "#e4ac30", "#36364b"
    # The face bobs slightly; its body remains present throughout the animation.
    draw.ellipse((cx - 54, cy - 54, cx + 54, cy + 54), fill=yellow, outline=outline, width=2)
    draw.ellipse((cx - 30, cy + 44, cx - 9, cy + 59), fill=yellow, outline=outline, width=2)
    draw.ellipse((cx + 9, cy + 44, cx + 30, cy + 59), fill=yellow, outline=outline, width=2)
    # Once-per-cycle blink disambiguates the complete loop from half a wave.
    blink = 12 <= index % LOOP_FRAMES <= 14
    for x in [cx - 18, cx + 18]:
        if blink:
            draw.line((x - 5, cy - 12, x + 5, cy - 12), fill=ink, width=4)
        else:
            draw.ellipse((x - 4, cy - 19, x + 4, cy - 6), fill=ink)
    draw.arc((cx - 22, cy - 8, cx + 22, cy + 28), start=10, end=170, fill=ink, width=4)
    draw.ellipse((cx - 37, cy + 3, cx - 23, cy + 10), fill="#f5ab60")
    draw.ellipse((cx + 23, cy + 3, cx + 37, cy + 10), fill="#f5ab60")
    hx, hy = 244 + 9 * math.sin(phase), 316 + 17 * math.cos(phase)
    draw.line((cx + 46, cy + 8, hx, hy), fill=outline, width=15)
    draw.line((cx + 46, cy + 8, hx, hy), fill=yellow, width=11)
    draw.ellipse((hx - 12, hy - 12, hx + 12, hy + 12), fill=yellow, outline=outline, width=2)
    draw.line((hx - 5, hy - 8, hx - 3, hy), fill=outline, width=2)
    draw.line((hx + 2, hy - 9, hx + 3, hy), fill=outline, width=2)
    return image


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
               "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264",
               "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
               "-crf", "23", "-preset", "medium", "-movflags", "+faststart", str(OUTPUT)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for index in range(LOOP_FRAMES * LOOPS):
            process.stdin.write(draw_frame(index).tobytes())
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("Fixture encoding failed")
    if OUTPUT.stat().st_size >= 300_000:
        raise RuntimeError("Fixture exceeds the 300 kB budget")
    print(f"{OUTPUT}: {OUTPUT.stat().st_size} bytes; {WIDTH}x{HEIGHT}; {FPS} fps; 6 s; 2 s loop × 3")


if __name__ == "__main__":
    main()
