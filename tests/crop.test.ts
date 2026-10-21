import { describe, expect, it } from 'vitest';
import { hitTestCrop, moveCrop, normalizeCrop, resizeCrop, type CropCorner } from '../src/core/crop';

const crop = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };
const edges = (rect: typeof crop) => ({ left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height });

describe('corner resizing', () => {
  it.each<CropCorner>(['nw', 'ne', 'sw', 'se'])('moves %s while its opposite corner stays fixed', corner => {
    const before = edges(crop), after = edges(resizeCrop(crop, corner, { x: 0.07, y: -0.08 }));
    if (corner.endsWith('w')) { expect(after.left).toBeCloseTo(before.left + 0.07); expect(after.right).toBeCloseTo(before.right); }
    else { expect(after.right).toBeCloseTo(before.right + 0.07); expect(after.left).toBeCloseTo(before.left); }
    if (corner.startsWith('n')) { expect(after.top).toBeCloseTo(before.top - 0.08); expect(after.bottom).toBeCloseTo(before.bottom); }
    else { expect(after.bottom).toBeCloseTo(before.bottom - 0.08); expect(after.top).toBeCloseTo(before.top); }
  });
  it.each<CropCorner>(['nw', 'ne', 'sw', 'se'])('clamps %s at the image boundary without moving its anchor', corner => {
    const before = edges(crop), after = edges(resizeCrop(crop, corner, { x: corner.endsWith('w') ? -10 : 10, y: corner.startsWith('n') ? -10 : 10 }));
    if (corner.endsWith('w')) { expect(after.left).toBe(0); expect(after.right).toBeCloseTo(before.right); }
    else { expect(after.right).toBe(1); expect(after.left).toBeCloseTo(before.left); }
    if (corner.startsWith('n')) { expect(after.top).toBe(0); expect(after.bottom).toBeCloseTo(before.bottom); }
    else { expect(after.bottom).toBe(1); expect(after.top).toBeCloseTo(before.top); }
  });
  it.each<CropCorner>(['nw', 'ne', 'sw', 'se'])('prevents %s from crossing its opposite corner', corner => {
    const resized = resizeCrop(crop, corner, { x: corner.endsWith('w') ? 10 : -10, y: corner.startsWith('n') ? 10 : -10 }, { width: 0.06, height: 0.04 });
    expect(resized.width).toBeCloseTo(0.06); expect(resized.height).toBeCloseTo(0.04);
    const before = edges(crop), after = edges(resized);
    expect(corner.endsWith('w') ? after.right : after.left).toBeCloseTo(corner.endsWith('w') ? before.right : before.left);
    expect(corner.startsWith('n') ? after.bottom : after.top).toBeCloseTo(corner.startsWith('n') ? before.bottom : before.top);
  });
});

describe('moving and normalized geometry', () => {
  it('translates both axes and preserves dimensions', () => {
    expect(moveCrop(crop, { x: 0.1, y: -0.1 })).toEqual({ x: expect.closeTo(0.3), y: expect.closeTo(0.2), width: 0.4, height: 0.5 });
    expect(crop).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.5 });
  });
  it('stops at each edge instead of squeezing the crop', () => {
    expect(moveCrop(crop, { x: -5, y: -5 })).toEqual({ x: 0, y: 0, width: 0.4, height: 0.5 });
    expect(moveCrop(crop, { x: 5, y: 5 })).toEqual({ x: 0.6, y: 0.5, width: 0.4, height: 0.5 });
  });
  it('remains stable for a full-image crop and invalid numeric input', () => {
    expect(moveCrop({ x: 0, y: 0, width: 1, height: 1 }, { x: 0.2, y: -0.4 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(normalizeCrop({ x: NaN, y: -2, width: Infinity, height: 8 })).toEqual({ x: 0, y: 0, width: 0.01, height: 1 });
    expect(moveCrop(crop, { x: NaN, y: Infinity })).toEqual(crop);
  });
});

describe('touch and mouse hit testing', () => {
  it('uses display-scaled touch radii and selects all four corners', () => {
    const radius = { x: 22 / 225, y: 22 / 400 };
    expect(hitTestCrop(crop, { x: 0.2, y: 0.3 }, radius)).toBe('nw');
    expect(hitTestCrop(crop, { x: 0.6, y: 0.3 }, radius)).toBe('ne');
    expect(hitTestCrop(crop, { x: 0.2, y: 0.8 }, radius)).toBe('sw');
    expect(hitTestCrop(crop, { x: 0.6, y: 0.8 }, radius)).toBe('se');
    expect(hitTestCrop(crop, { x: 0.2 - 20 / 225, y: 0.3 }, radius)).toBe('nw');
  });
  it('moves only inside the crop and ignores blank image areas', () => {
    const radius = { x: 0.03, y: 0.03 };
    expect(hitTestCrop(crop, { x: 0.4, y: 0.5 }, radius)).toBe('move');
    expect(hitTestCrop(crop, { x: 0.05, y: 0.1 }, radius)).toBeNull();
    expect(hitTestCrop(crop, { x: 0.9, y: 0.9 }, radius)).toBeNull();
  });
  it('chooses the nearest corner when large touch targets overlap', () => {
    const small = { x: 0.4, y: 0.4, width: 0.05, height: 0.05 }, radius = { x: 0.1, y: 0.1 };
    expect(hitTestCrop(small, { x: 0.449, y: 0.449 }, radius)).toBe('se');
    expect(hitTestCrop(small, { x: 0.401, y: 0.401 }, radius)).toBe('nw');
  });
});
