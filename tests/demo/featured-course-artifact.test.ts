import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

function collectAudioRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectAudioRefs(item, refs);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'audioRef' && typeof item === 'string') refs.push(item);
      else collectAudioRefs(item, refs);
    }
  }
  return refs;
}

describe('featured demo course artifact', () => {
  it('contains a complete optimized classroom package', async () => {
    const artifactPath = resolve(process.cwd(), 'public/demo/firmicutes-obesity.maic.zip');
    const coverPath = resolve(process.cwd(), 'public/demo/firmicutes-obesity-cover.png');

    expect(statSync(artifactPath).size).toBeLessThan(20 * 1024 * 1024);
    expect(statSync(coverPath).size).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(readFileSync(artifactPath));
    const manifestFile = zip.file('manifest.json');
    expect(manifestFile).not.toBeNull();
    const manifest = JSON.parse(await manifestFile!.async('text')) as ClassroomManifest;

    expect(manifest.stage.name).toBe('厚壁菌门与肥胖');
    expect(manifest.scenes).toHaveLength(12);

    const audioEntries = Object.entries(manifest.mediaIndex).filter(
      ([, item]) => item.type === 'audio',
    );
    expect(audioEntries).toHaveLength(66);

    for (const [path, item] of Object.entries(manifest.mediaIndex)) {
      expect(zip.file(path), path).not.toBeNull();
      if (item.type === 'audio') {
        expect(path.endsWith('.mp3'), path).toBe(true);
        expect(item.format).toBe('mp3');
        expect(item.mimeType).toBe('audio/mpeg');
      }
    }

    for (const audioRef of collectAudioRefs(manifest.scenes)) {
      expect(manifest.mediaIndex, audioRef).toHaveProperty(audioRef);
      expect(zip.file(audioRef), audioRef).not.toBeNull();
    }
  });
});
