import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importClassroomBlob } from '@/lib/import/classroom-import';
import { accessDocument } from '@/lib/document-store';
import { db } from '@/lib/utils/database';
import type { Stage } from '@/lib/types/stage';

const storage = new Map<string, string>();
const homepageImporterSource = readFileSync(
  new URL('../../lib/import/use-import-classroom.ts', import.meta.url),
  'utf8',
);
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
vi.stubGlobal('localStorage', localStorageStub);

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

beforeEach(async () => {
  storage.clear();
  await clearImportTables();
});
afterEach(clearImportTables);

describe('importClassroomBlob', () => {
  it('returns the new stage id and persists an ordinary classroom', async () => {
    const phases: string[] = [];

    const stageId = await importClassroomBlob(await classroomBlob(), {
      onPhase: (phase) => phases.push(phase),
    });

    const imported = (await accessDocument(stageId)).document;
    expect(imported?.stage).toMatchObject({
      id: stageId,
      name: 'Demo',
    });
    expect(imported?.scenes).toHaveLength(1);
    expect(imported?.outline).toMatchObject({
      outlines: [],
      generationComplete: true,
    });
    expect(phases).toEqual(['parsing', 'validating', 'writingMedia', 'writingCourse', 'done']);
  });

  it('marks the homepage import path as a complete classroom snapshot too', () => {
    expect(homepageImporterSource).toContain('outline: completedClassroomImportOutline(now)');
  });

  it('imports Spiral agents into the stage without writing normal generated-agent records', async () => {
    const stageId = await importClassroomBlob(
      await classroomBlob({
        spiralAgents: [
          {
            name: 'Ari',
            role: 'assistant',
            persona: 'A supportive assistant.',
            avatar: '/avatars/assist.png',
            color: '#111111',
            priority: 7,
          },
          {
            name: 'Bo',
            role: 'student',
            persona: 'Questions definitions.',
            avatar: '/avatars/curious.png',
            color: '#222222',
            priority: 5,
          },
          {
            name: 'Cy',
            role: 'student',
            persona: 'Tests examples.',
            avatar: '/avatars/thinker.png',
            color: '#333333',
            priority: 4,
          },
        ],
      }),
    );

    const imported = (await accessDocument(stageId)).document;
    const spiralAgents = (
      imported?.stage as
        | (Stage & {
            spiralAgentConfigs?: Array<{ id: string }>;
          })
        | undefined
    )?.spiralAgentConfigs;
    expect(spiralAgents).toHaveLength(3);
    expect(spiralAgents?.every((agent) => agent.id.startsWith('spiral-'))).toBe(true);
    await expect(db.generatedAgents.where('stageId').equals(stageId).count()).resolves.toBe(0);
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
