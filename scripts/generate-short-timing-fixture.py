#!/usr/bin/env python3
"""Re-time the existing 30 numbered frames to a 0.25s / 120fps fixture.

Generation-only dependency: imageio-ffmpeg==0.6.0. Rebuild native-60.mp4 with
generate-timing-fixture.py first if missing. No source frames are discarded.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import subprocess

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tests" / "fixtures" / "native-60.mp4"
OUTPUT = ROOT / "tests" / "fixtures" / "native-120.mp4"
WIDTH, HEIGHT, FPS, FRAME_COUNT = 1280, 32, 120, 30


def main() -> None:
    if not SOURCE.is_file():
        raise RuntimeError("Generate native-60.mp4 before this derivative fixture")
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(SOURCE),
        "-vf", "setpts=PTS/2", "-r", str(FPS), "-fps_mode", "cfr",
        "-an", "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1",
        "-pix_fmt", "yuv420p", "-crf", "12", "-preset", "medium", "-bf", "3",
        "-g", "60", "-x264-params", "b-adapt=0:scenecut=0", "-movflags", "+faststart",
        str(OUTPUT),
    ], check=True)
    decoded = subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "info", "-i", str(OUTPUT),
        "-vf", "showinfo", "-fps_mode", "passthrough", "-pix_fmt", "rgb24",
        "-f", "rawvideo", "pipe:1",
    ], check=True, capture_output=True)
    frame_bytes = WIDTH * HEIGHT * 3
    assert len(decoded.stdout) == FRAME_COUNT * frame_bytes, "Incorrect frame count or native dimensions"
    for expected in range(FRAME_COUNT):
        pixels = decoded.stdout[expected * frame_bytes:(expected + 1) * frame_bytes]
        number = 0
        for bit in range(6):
            offset = (16 * WIDTH + 48 + bit * 64) * 3
            if sum(pixels[offset:offset + 3]) / 3 > 128:
                number |= 1 << bit
        assert number == expected, f"Frame {expected} contains identifier {number}"
    log = decoded.stderr.decode("utf-8", errors="replace")
    timings = re.findall(r"\bn:\s*(\d+)\s+pts:.*?pts_time:([\d.eE+-]+).*?duration_time:([\d.eE+-]+)", log)
    assert len(timings) == FRAME_COUNT, "Cannot inspect every frame timestamp and duration"
    for expected, (number, timestamp, duration) in enumerate(timings):
        assert int(number) == expected
        assert abs(float(timestamp) - expected / FPS) < 1e-6, "Wrong presentation timestamp"
        assert abs(float(duration) - 1 / FPS) < 1e-6, "Wrong source frame duration"
    print(f"Verified {WIDTH}x{HEIGHT}, {FPS} fps, frames 0..29, source duration 0.25 seconds")
    print(f"Size {OUTPUT.stat().st_size} bytes")
    print(f"SHA-256 {hashlib.sha256(OUTPUT.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
