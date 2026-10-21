export interface Frame { width: number; height: number; data: Uint8ClampedArray; time: number }
/** Normalized coordinates in [0, 1], relative to the decoded video. */
export interface Rect { x: number; y: number; width: number; height: number }
export interface Region { rect: Rect; score: number; label: string }
export interface LoopResult { start: number; end: number; confidence: number; reason: string; detected: boolean }
export interface Background { color: [number, number, number]; confidence: number; recommendation: 'transparent' | 'rectangle'; reason: string }
export type BackgroundMode = 'auto' | 'transparent' | 'rectangle';
export interface GifFrame { width: number; height: number; data: Uint8ClampedArray; delayMs: number }
