declare module 'omggif' {
  export interface FrameInfo { x: number; y: number; width: number; height: number; delay: number; disposal: number; transparent_index: number | null; has_local_palette: boolean }
  export class GifReader {
    constructor(bytes: Uint8Array);
    width: number; height: number;
    numFrames(): number;
    loopCount(): number | null;
    frameInfo(index: number): FrameInfo;
    decodeAndBlitFrameRGBA(index: number, pixels: Uint8Array): void;
  }
  export class GifWriter {
    constructor(buffer: Uint8Array, width: number, height: number, options?: { loop?: number; palette?: number[] });
    addFrame(x: number, y: number, width: number, height: number, pixels: Uint8Array, options: { palette?: number[]; delay: number; disposal: number; transparent?: number }): number;
    getOutputBufferPosition(): number;
    setOutputBufferPosition(position: number): void;
    end(): number;
  }
}
