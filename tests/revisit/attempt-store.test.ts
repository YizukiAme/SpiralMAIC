import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOrGetRevisitAttempt,
  getRevisitAttempt,
  importLegacyRevisitAttemptSnapshot,
  listRevisitAttempts,
  markRevisitAttemptCompleted,
  saveRevisitAttemptBlueprint,
  upsertRevisitAttemptScene,
} from '@/lib/revisit/attempt-store';
import {
  clearRevisitDatabase,
  deleteRevisitStageData,
  getRevisitReport,
  recordLessonCompleted,
  saveEvidenceAndUpdateState,
} from '@/lib/revisit/db';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'Fallacies',
  createdAt: 1,
  updatedAt: 2,
  languageDirective: 'en-US',
};

const blueprint: RevisitExamBlueprint = {
  id: 'bp-1',
  stageId: 'stage-1',
  generatedAt: 1,
  language: 'en',
  sourceHash: 'hash',
  concepts: [],
  skeleton: {
    pages: [{ id: 'page-1', title: 'Page', summary: 'Summary', conceptIds: [], cues: [] }],
  },
};

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  type: 'slide',
  title: 'Page',
  order: 0,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
      elements: [],
    },
  },
} satisfies Scene;

describe('durable revisit attempt storage', () => {
  beforeEach(clearRevisitDatabase);
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearRevisitDatabase();
  });

  it('creates one unfinished attempt per course and assigns a stable sequence', async () => {
    const first = await createOrGetRevisitAttempt({
      attemptId: 'attempt-1',
      stage,
      sourceScenes: [scene],
      now: 10,
    });
    const duplicate = await createOrGetRevisitAttempt({
      attemptId: 'attempt-2',
      stage,
      sourceScenes: [scene],
      now: 20,
    });

    expect(first.sequence).toBe(1);
    expect(duplicate.attemptId).toBe(first.attemptId);
    expect(await listRevisitAttempts(stage.id)).toHaveLength(1);

    await markRevisitAttemptCompleted(first.attemptId, 30);
    const second = await createOrGetRevisitAttempt({
      attemptId: 'attempt-2',
      stage: { ...stage, updatedAt: 99 },
      sourceScenes: [{ ...scene, title: 'Updated lesson' }],
      now: 40,
    });

    expect(second.sequence).toBe(2);
    expect(second.sourceStage?.updatedAt).toBe(99);
    expect(second.sourceScenes[0]?.title).toBe('Updated lesson');
  });

  it('persists generated content incrementally without classroom runtime state', async () => {
    await createOrGetRevisitAttempt({
      attemptId: 'attempt-1',
      stage,
      sourceScenes: [scene],
      now: 10,
    });
    await saveRevisitAttemptBlueprint('attempt-1', blueprint, 11);
    await upsertRevisitAttemptScene({
      attemptId: 'attempt-1',
      scene,
      index: 0,
      now: 12,
    });

    const persisted = await getRevisitAttempt('attempt-1');
    expect(persisted).toMatchObject({
      attemptId: 'attempt-1',
      status: 'ready',
      blueprint: { id: 'bp-1' },
      scenes: [{ id: 'scene-1' }],
    });
    expect(persisted).not.toHaveProperty('runtime');
    expect(persisted).not.toHaveProperty('pageIndex');
    expect(persisted).not.toHaveProperty('messages');
  });

  it('keeps an old attempt self-contained after the source course changes', async () => {
    await createOrGetRevisitAttempt({
      attemptId: 'attempt-1',
      stage,
      sourceScenes: [scene],
      now: 10,
    });
    await saveRevisitAttemptBlueprint('attempt-1', blueprint, 11);

    const persisted = await getRevisitAttempt('attempt-1');
    expect(persisted?.sourceStage).toEqual(stage);
    expect(persisted?.sourceScenes).toEqual([scene]);
  });

  it('commits the first report and completed attempt state together', async () => {
    await recordLessonCompleted(stage.id, 5);
    await createOrGetRevisitAttempt({
      attemptId: 'attempt-1',
      stage,
      sourceScenes: [scene],
      now: 10,
    });
    await saveRevisitAttemptBlueprint('attempt-1', blueprint, 11);
    await upsertRevisitAttemptScene({ attemptId: 'attempt-1', scene, index: 0, now: 12 });

    await saveEvidenceAndUpdateState({
      attemptId: 'attempt-1',
      stageId: stage.id,
      completedAt: 20,
      summary: 'Complete',
      dimensions: { clarity: 1, doubtResolution: 1, transfer: 1, errorCorrection: 1 },
      qRaw: 0.98,
      q: 0.98,
      errors: [],
      evidence: [],
      pageReports: [],
    });

    expect(await getRevisitAttempt('attempt-1')).toMatchObject({
      status: 'completed',
      completedAt: 20,
    });
    expect(await getRevisitReport('attempt-1')).toMatchObject({ completedAt: 20 });
  });

  it('lazily imports legacy generated content but discards classroom runtime', async () => {
    const values = new Map<string, string>();
    values.set(
      'revisitAttempt:legacy-1',
      JSON.stringify({
        attemptId: 'legacy-1',
        stageId: stage.id,
        blueprint,
        scenes: [scene],
        createdAt: 10,
        updatedAt: 20,
        runtime: {
          pageIndex: 1,
          messages: [{ text: 'discard me' }],
          pageStates: [{ passed: true }],
        },
      }),
    );
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
      },
    });

    const imported = await importLegacyRevisitAttemptSnapshot('legacy-1');

    expect(imported).toMatchObject({ attemptId: 'legacy-1', scenes: [{ id: scene.id }] });
    expect(imported).not.toHaveProperty('runtime');
    expect(values.has('revisitAttempt:legacy-1')).toBe(false);
  });

  it('removes durable attempts when the original course is deleted', async () => {
    await createOrGetRevisitAttempt({
      attemptId: 'attempt-1',
      stage,
      sourceScenes: [scene],
      now: 10,
    });

    await deleteRevisitStageData(stage.id);

    expect(await getRevisitAttempt('attempt-1')).toBeUndefined();
  });
});
