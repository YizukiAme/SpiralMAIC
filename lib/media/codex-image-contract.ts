export const CODEX_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const CODEX_IMAGE_MAX_EDGE = 8192;
export const CODEX_IMAGE_MAX_PIXELS = 16_777_216;

export function areCodexImageDimensionsSafe(width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return false;
  }
  if (width > CODEX_IMAGE_MAX_EDGE || height > CODEX_IMAGE_MAX_EDGE) return false;
  return width * height <= CODEX_IMAGE_MAX_PIXELS;
}
