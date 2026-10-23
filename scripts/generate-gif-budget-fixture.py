#!/usr/bin/env python3
"""Generate a small, synthetic H.264 clip whose faithful GIF exceeds 500 kB.

Generation-only dependencies: Pillow==13.0.0, imageio-ffmpeg==0.6.0.
Run from any directory: python scripts/generate-gif-budget-fixture.py
The frames are deterministic generated noise, with no personal/source media.
"""
from __future__ import annotations

import hashlib
import io
from pathlib import Path
import re
import subprocess

import imageio_ffmpeg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests" / "fixtures" / "gif-budget.mp4"
WIDTH, HEIGHT, FPS, FRAME_COUNT = 256, 256, 30, 15
SEED = 0x4C4F4F50
BUDGET_BYTES = 500_000


def gray_frames():
    """A specified xorshift32 sequence keeps source pixels reproducible."""
    state = SEED
    for _ in range(FRAME_COUNT):
        pixels = bytearray(WIDTH * HEIGHT)
        for index in range(len(pixels)):
            state ^= (state << 13) & 0xFFFFFFFF
            state ^= state >> 17
            state ^= (state << 5) & 0xFFFFFFFF
            state &= 0xFFFFFFFF
            pixels[index] = state >> 24
        yield pixels


def verify(ffmpeg: str) -> None:
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "info", "-i", str(OUTPUT),
         "-vf", "showinfo", "-fps_mode", "passthrough", "-pix_fmt", "rgb24",
         "-f", "rawvideo", "pipe:1"],
        check=True, capture_output=True,
    )
    frame_bytes = WIDTH * HEIGHT * 3
    assert len(result.stdout) == FRAME_COUNT * frame_bytes, "Wrong frame count or dimensions"
    log = result.stderr.decode("utf-8", errors="replace")
    timings = re.findall(r"\bn:\s*(\d+)\s+pts:.*?pts_time:([\d.eE+-]+)", log)
    assert len(timings) == FRAME_COUNT, "Could not inspect presentation timestamps"
    for expected, (number, timestamp) in enumerate(timings):
        assert int(number) == expected
        assert abs(float(timestamp) - expected / FPS) < 1e-6, "Unexpected PTS"
    frames = []
    hashes = set()
    for index in range(FRAME_COUNT):
        rgb = result.stdout[index * frame_bytes:(index + 1) * frame_bytes]
        hashes.add(hashlib.sha256(rgb).digest())
        frames.append(Image.frombytes("RGB", (WIDTH, HEIGHT), rgb).quantize(
            colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE,
        ))
    assert len(hashes) == FRAME_COUNT, "Expected every frame to differ"
    # Quantize the DECODED video, not pristine generation pixels. This is only
    # a fixture size sanity check, not the application's losslessness oracle.
    # 30/40/30 ms preserves all 15 frames and the 500 ms total GIF duration.
    delays = [30, 40, 30] * (FRAME_COUNT // 3)
    output = io.BytesIO()
    frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:],
                   duration=delays, loop=0, disposal=2, optimize=True)
    gif_bytes = len(output.getbuffer())
    assert gif_bytes > BUDGET_BYTES, "Fixture no longer exercises the GIF budget"
    output.seek(0)
    with Image.open(output) as gif:
        assert gif.size == (WIDTH, HEIGHT) and gif.n_frames == FRAME_COUNT
        total_ms = 0
        for index in range(gif.n_frames):
            gif.seek(index)
            total_ms += gif.info["duration"]
        assert total_ms == 500
    video = OUTPUT.read_bytes()
    print(f"Verified {WIDTH}x{HEIGHT}, {FPS} fps, {FRAME_COUNT} unique frames, 0.5 seconds")
    print(f"Video: {len(video)} bytes; decoded-video Pillow GIF: {gif_bytes} bytes (> {BUDGET_BYTES})")
    print(f"Seed: 0x{SEED:08X}; SHA-256 {hashlib.sha256(video).hexdigest()}")


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{WIDTH}x{HEIGHT}",
               "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264",
               "-profile:v", "high", "-level:v", "3.0", "-pix_fmt", "yuv420p",
               "-crf", "18", "-preset", "medium", "-bf", "2", "-g", "30",
               "-x264-params", "b-adapt=0:scenecut=0", "-movflags", "+faststart", str(OUTPUT)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame in gray_frames():
            process.stdin.write(frame)
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("FFmpeg fixture encoding failed")
    verify(ffmpeg)


if __name__ == "__main__":
    main()
