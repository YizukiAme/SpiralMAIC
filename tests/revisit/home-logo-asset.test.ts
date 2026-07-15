import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const SPIRAL_LOGO_PATH = 'public/spiralmaic-logo-horizontal.png';
const OPENMAIC_LOGO_PATH = 'public/logo-horizontal.png';

async function opaqueChannelQuantiles(path: string) {
  const { data } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = [[], [], []] as number[][];

  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] <= 200) continue;
    channels[0].push(data[offset]);
    channels[1].push(data[offset + 1]);
    channels[2].push(data[offset + 2]);
  }

  return channels.map((channel) => {
    channel.sort((a, b) => a - b);
    return [0.1, 0.5, 0.9].map((quantile) => channel[Math.floor((channel.length - 1) * quantile)]);
  });
}

describe('Spiral home logo asset', () => {
  it('uses the OpenMAIC logo canvas and fills it without visible size shrinkage', async () => {
    const { data, info } = await sharp(SPIRAL_LOGO_PATH)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alpha = data[(y * info.width + x) * 4 + 3];
        if (alpha <= 8) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    expect([info.width, info.height, info.channels]).toEqual([1232, 269, 4]);
    expect((maxX - minX + 1) / info.width).toBeGreaterThanOrEqual(0.99);
    expect((maxY - minY + 1) / info.height).toBeGreaterThanOrEqual(0.98);
  });

  it('matches the OpenMAIC logo dark, midtone, and highlight color levels', async () => {
    const [spiralQuantiles, openMaicQuantiles] = await Promise.all([
      opaqueChannelQuantiles(SPIRAL_LOGO_PATH),
      opaqueChannelQuantiles(OPENMAIC_LOGO_PATH),
    ]);

    for (let channel = 0; channel < 3; channel += 1) {
      for (let quantile = 0; quantile < 3; quantile += 1) {
        expect(
          Math.abs(spiralQuantiles[channel][quantile] - openMaicQuantiles[channel][quantile]),
        ).toBeLessThanOrEqual(2);
      }
    }
  });
});
