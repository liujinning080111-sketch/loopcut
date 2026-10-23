import { decompressFrames, parseGIF } from 'gifuct-js';

export type Rgba = readonly [number, number, number, number];
export interface GifCompositeOptions {
  /** Decode two continuous repetitions by default, including the loop seam. */
  loops?: number;
  /** Web image background. Transparent by default; never use a palette RGB as alpha. */
  background?: Rgba;
}
export interface GifCompositeFrame {
  loop: number;
  frameIndex: number;
  delayMs: number;
  /** Full logical-screen RGBA after drawing this frame, before its disposal. */
  rgba: Uint8ClampedArray;
}
export interface GifComposite {
  width: number;
  height: number;
  frameCount: number;
  /** NETSCAPE repetitions: 0 means infinite; null means no loop extension. */
  loopCount: number | null;
  /** Raw GCE durations, without gifuct-js's implicit 100ms zero-delay fallback. */
  delaysMs: number[];
  durationMs: number;
  frames: GifCompositeFrame[];
}

/**
 * Independent test decoder: gifuct-js performs LZW/interlace/palette decoding;
 * this helper performs full-screen composition. Comparing decompressed patches
 * directly is invalid when an optimizer changes frame rectangles or disposal.
 *
 * Transparent pixels do not overwrite the existing canvas. Disposal 2 clears
 * ONLY the disposed image's rectangle to the web background; disposal 3 restores
 * the image's pre-draw state. The default transparent backing matches browser
 * RGBA rendering (rather than treating GIF's background palette entry as opaque).
 * https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/image-decoders/image_decoder.cc
 *
 * Each repetition starts with the previous repetition's final disposal, not an
 * artificial canvas reset, so a stale last-frame silhouette cannot be hidden.
 * Intended for bounded regression fixtures, not production image processing.
 */
export function compositeGif(bytes: Uint8Array | ArrayBuffer, options: GifCompositeOptions = {}): GifComposite {
  const loops = options.loops ?? 2;
  if (!Number.isInteger(loops) || loops < 1) throw new Error('Composite loop count must be a positive integer');
  const background = options.background ?? [0, 0, 0, 0];
  if (background.length !== 4 || background.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('Invalid RGBA background');
  // Respect a Uint8Array/Buffer's byteOffset; never parse unrelated buffer bytes.
  const owned = new Uint8Array(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  const parsed = parseGIF(owned.buffer);
  if (parsed.header.signature !== 'GIF') throw new Error('Not a GIF');
  const { width, height } = parsed.lsd;
  if (!width || !height) throw new Error('GIF logical screen is empty');
  const sourceFrames = parsed.frames.filter(frame => 'image' in frame);
  const decoded = decompressFrames(parsed, true);
  if (!decoded.length || decoded.length !== sourceFrames.length) throw new Error('GIF has no complete image frames');
  const delaysMs = sourceFrames.map(frame => (frame.gce?.delay ?? 0) * 10);
  let loopCount: number | null = null;
  for (const frame of parsed.frames) {
    if (!('application' in frame)) continue;
    const { id, blocks } = frame.application;
    if ((id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') && blocks.length >= 3 && blocks[0] === 1) {
      loopCount = blocks[1] | (blocks[2] << 8);
    }
  }
  const canvas = new Uint8ClampedArray(width * height * 4);
  const fillRect = (left: number, top: number, rectWidth: number, rectHeight: number) => {
    for (let y = Math.max(0, top); y < Math.min(height, top + rectHeight); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, left + rectWidth); x++) {
        const offset = (y * width + x) * 4;
        // Invisible RGB values have no rendered meaning; canonicalize to zero.
        for (let channel = 0; channel < 3; channel++) canvas[offset + channel] = background[3] ? background[channel] : 0;
        canvas[offset + 3] = background[3];
      }
    }
  };
  fillRect(0, 0, width, height);
  const frames: GifCompositeFrame[] = [];
  for (let loop = 0; loop < loops; loop++) for (let frameIndex = 0; frameIndex < decoded.length; frameIndex++) {
    const frame = decoded[frameIndex];
    const { left, top, width: rectWidth, height: rectHeight } = frame.dims;
    const disposal = sourceFrames[frameIndex].gce?.extras.disposal ?? 0;
    if (disposal > 3) throw new Error(`Unsupported GIF disposal ${disposal}`);
    if (!rectWidth || !rectHeight || frame.patch.length !== rectWidth * rectHeight * 4) throw new Error('Incomplete GIF image rectangle');
    const previous = disposal === 3 ? canvas.slice() : undefined;
    for (let y = Math.max(0, top); y < Math.min(height, top + rectHeight); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, left + rectWidth); x++) {
        const source = ((y - top) * rectWidth + x - left) * 4;
        if (!frame.patch[source + 3]) continue;
        const target = (y * width + x) * 4;
        canvas.set(frame.patch.subarray(source, source + 4), target);
      }
    }
    frames.push({ loop, frameIndex, delayMs: delaysMs[frameIndex], rgba: canvas.slice() });
    if (disposal === 2) fillRect(left, top, rectWidth, rectHeight);
    else if (disposal === 3) canvas.set(previous!);
  }
  return { width, height, frameCount: decoded.length, loopCount, delaysMs, durationMs: delaysMs.reduce((sum, delay) => sum + delay, 0), frames };
}
