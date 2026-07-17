import 'fake-indexeddb/auto';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importClassroomBlob } from '@/lib/import/classroom-import';
import { db } from '@/lib/utils/database';

async function clearImportTables() {
  await db.open();
  await Promise.all([
    db.stages.clear(),
    db.scenes.clear(),
    db.audioFiles.clear(),
    db.mediaFiles.clear(),
    db.generatedAgents.clear(),
  ]);
}

async function classroomBlob(overrides: Record<string, unknown> = {}) {
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: { name: 'Demo', createdAt: 1, updatedAt: 1 },
      agents: [],
      scenes: [
        {
          type: 'slide',
          title: 'One',
          order: 1,
          content: {
            type: 'slide',
            canvas: {
              id: 'canvas-1',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: {
                backgroundColor: '#ffffff',
                themeColors: [],
                fontColor: '#111111',
                fontName: 'Inter',
              },
              elements: [],
            },
          },
        },
      ],
      mediaIndex: {},
      ...overrides,
    }),
  );
  return zip.generateAsync({ type: 'blob' });
}

beforeEach(clearImportTables);
afterEach(clearImportTables);

describe('importClassroomBlob', () => {
  it('returns the new stage id and persists an ordinary classroom', async () => {
    const phases: string[] = [];

    const stageId = await importClassroomBlob(await classroomBlob(), {
      onPhase: (phase) => phases.push(phase),
    });

    await expect(db.stages.get(stageId)).resolves.toMatchObject({
      id: stageId,
      name: 'Demo',
    });
    await expect(db.scenes.where('stageId').equals(stageId).count()).resolves.toBe(1);
    expect(phases).toEqual(['parsing', 'validating', 'writingMedia', 'writingCourse', 'done']);
  });

  it('rejects a zip without manifest.json with a typed error', async () => {
    const zip = new JSZip();
    const blob = await zip.generateAsync({ type: 'blob' });

    await expect(importClassroomBlob(blob)).rejects.toMatchObject({
      code: 'invalid-manifest',
    });
  });

  it('rejects a manifest without course data', async () => {
    await expect(importClassroomBlob(await classroomBlob({ stage: null }))).rejects.toMatchObject({
      code: 'missing-data',
    });
  });
});
