#!/usr/bin/env python3
"""Generate and verify a synthetic native 1280 x 32, 60 fps H.264 fixture.

Generation-only dependencies: Pillow==13.0.0, imageio-ffmpeg==0.6.0.
Run from any directory: python scripts/generate-timing-fixture.py
No screenshots, downloaded images, personal media, or raster upscaling are used.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import subprocess

import imageio_ffmpeg
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests" / "fixtures" / "native-60.mp4"
WIDTH, HEIGHT, FPS, FRAME_COUNT = 1280, 32, 60, 30
BIT_LEFT, BIT_WIDTH, BIT_COUNT, SAMPLE_Y = 16, 64, 6, 16


def draw_frame(index: int) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), (96, 96, 96))
    draw = ImageDraw.Draw(image)
    # Six LSB-first binary blocks. Centers are x = 48 + 64 * bit, y = 16.
    for bit in range(BIT_COUNT):
        left = BIT_LEFT + BIT_WIDTH * bit
        value = 255 if index & (1 << bit) else 0
        draw.rectangle((left, 0, left + BIT_WIDTH - 1, HEIGHT - 1),
                       fill=(value, value, value))
    # Native one-pixel vertical stripes expose accidental width downsampling.
    for x in range(416, WIDTH):
        value = 224 if x % 2 else 32
        draw.line((x, 0, x, HEIGHT - 1), fill=(value, value, value))
    # A separate moving marker makes every frame visually distinct as well.
    marker_left = 432 + index * 24
    draw.rectangle((marker_left, 8, marker_left + 15, 23), fill=(255, 0, 0))
    return image


def verify(ffmpeg: str) -> None:
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "info", "-i", str(OUTPUT),
         "-vf", "showinfo", "-fps_mode", "passthrough", "-pix_fmt", "rgb24",
         "-f", "rawvideo", "pipe:1"],
        check=True, capture_output=True,
    )
    frame_bytes = WIDTH * HEIGHT * 3
    assert len(result.stdout) == FRAME_COUNT * frame_bytes, "Wrong native frame count or dimensions"
    for expected in range(FRAME_COUNT):
        frame = result.stdout[expected * frame_bytes:(expected + 1) * frame_bytes]
        actual = 0
        for bit in range(BIT_COUNT):
            x = BIT_LEFT + BIT_WIDTH * bit + BIT_WIDTH // 2
            offset = (SAMPLE_Y * WIDTH + x) * 3
            rgb = frame[offset:offset + 3]
            if sum(rgb) / 3 > 128:
                actual |= 1 << bit
        assert actual == expected, f"Decoded frame {expected} contains number {actual}"
    log = result.stderr.decode("utf-8", errors="replace")
    frames = re.findall(r"\bn:\s*(\d+)\s+pts:.*?pts_time:([\d.eE+-]+).*?type:([IPB])", log)
    assert len(frames) == FRAME_COUNT, "Could not inspect presentation timestamps"
    assert any(kind == "B" for _, _, kind in frames), "Fixture must contain B-frames"
    for expected, (number, timestamp, _) in enumerate(frames):
        assert int(number) == expected
        assert abs(float(timestamp) - expected / FPS) < 1e-6, "Unexpected presentation timing"
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    print(f"Verified {WIDTH}x{HEIGHT}, {FPS} fps, {FRAME_COUNT} frames, 0.5 seconds, B-frames present")
    print(f"Frame numbers: 0..{FRAME_COUNT - 1}; binary centers x=48+64*bit, y={SAMPLE_Y}")
    print(f"SHA-256 {digest}")


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
               "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264",
               "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p",
               "-crf", "12", "-preset", "medium", "-bf", "3", "-g", "60",
               "-x264-params", "b-adapt=0:scenecut=0", "-movflags", "+faststart", str(OUTPUT)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for index in range(FRAME_COUNT):
            process.stdin.write(draw_frame(index).tobytes())
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("FFmpeg fixture encoding failed")
    verify(ffmpeg)


if __name__ == "__main__":
    main()
