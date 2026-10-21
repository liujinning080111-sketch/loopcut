import type { Rect } from '../types';

export interface Point { x: number; y: number }
export interface CropMinimum { width: number; height: number }
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';
export type CropHandle = CropCorner | 'move';
export const MIN_CROP_SIZE: CropMinimum = { width: 0.01, height: 0.01 };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
function minimumSize(minimum: CropMinimum) {
  return { width: clamp(finite(minimum.width, 0.01), 0.001, 1), height: clamp(finite(minimum.height, 0.01), 0.001, 1) };
}

/** A valid crop is always contained by the normalized image rectangle. */
export function normalizeCrop(rect: Rect, minimum: CropMinimum = MIN_CROP_SIZE): Rect {
  const min = minimumSize(minimum);
  const x = clamp(finite(rect.x, 0), 0, 1 - min.width), y = clamp(finite(rect.y, 0), 0, 1 - min.height);
  return { x, y, width: clamp(finite(rect.width, min.width), min.width, 1 - x), height: clamp(finite(rect.height, min.height), min.height, 1 - y) };
}

/** Translate the original rectangle, preserving both dimensions at image edges. */
export function moveCrop(rect: Rect, delta: Point): Rect {
  const original = normalizeCrop(rect);
  return { ...original, x: clamp(original.x + finite(delta.x, 0), 0, 1 - original.width), y: clamp(original.y + finite(delta.y, 0), 0, 1 - original.height) };
}

/** Drag one corner while its opposite corner stays fixed; crossing cannot flip the crop. */
export function resizeCrop(rect: Rect, corner: CropCorner, delta: Point, minimum: CropMinimum = MIN_CROP_SIZE): Rect {
  const original = normalizeCrop(rect, minimum), min = minimumSize(minimum);
  let left = original.x, top = original.y, right = original.x + original.width, bottom = original.y + original.height;
  const dx = finite(delta.x, 0), dy = finite(delta.y, 0);
  if (corner.endsWith('w')) left = clamp(left + dx, 0, right - min.width);
  else right = clamp(right + dx, left + min.width, 1);
  if (corner.startsWith('n')) top = clamp(top + dy, 0, bottom - min.height);
  else bottom = clamp(bottom + dy, top + min.height, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Corner targets use screen-adjusted radii; the closest corner wins overlaps. */
export function hitTestCrop(rect: Rect, point: Point, radius: Point): CropHandle | null {
  const corners: [CropCorner, number, number][] = [
    ['nw', rect.x, rect.y], ['ne', rect.x + rect.width, rect.y],
    ['sw', rect.x, rect.y + rect.height], ['se', rect.x + rect.width, rect.y + rect.height],
  ];
  const rx = Math.max(0.000001, finite(radius.x, 0)), ry = Math.max(0.000001, finite(radius.y, 0));
  let closest: CropCorner | null = null, bestDistance = Infinity;
  for (const [corner, x, y] of corners) {
    const dx = Math.abs(point.x - x) / rx, dy = Math.abs(point.y - y) / ry;
    if (dx <= 1 && dy <= 1 && dx * dx + dy * dy < bestDistance) { closest = corner; bestDistance = dx * dx + dy * dy; }
  }
  if (closest) return closest;
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height ? 'move' : null;
}
