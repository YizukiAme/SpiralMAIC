import { describe, expect, it } from 'vitest';

import {
  areCodexImageDimensionsSafe,
  CODEX_IMAGE_MAX_BYTES,
  CODEX_IMAGE_MAX_EDGE,
  CODEX_IMAGE_MAX_PIXELS,
} from '@/lib/media/codex-image-contract';

describe('Codex image safety contract', () => {
  it('exports the shared byte and dimension limits', () => {
    expect(CODEX_IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(CODEX_IMAGE_MAX_EDGE).toBe(8192);
    expect(CODEX_IMAGE_MAX_PIXELS).toBe(16_777_216);
  });

  it.each([
    [1, 1],
    [4096, 4096],
    [8192, 2048],
  ])('accepts safe positive integer dimensions %sx%s', (width, height) => {
    expect(areCodexImageDimensionsSafe(width, height)).toBe(true);
  });

  it.each([
    [0, 1],
    [-1, 1],
    [1.5, 1],
    [Number.NaN, 1],
    [Number.MAX_SAFE_INTEGER, 1],
    [8193, 1],
    [1, 8193],
    [4097, 4097],
    [8192, 2049],
  ])('rejects unsafe dimensions %sx%s', (width, height) => {
    expect(areCodexImageDimensionsSafe(width, height)).toBe(false);
  });
});
