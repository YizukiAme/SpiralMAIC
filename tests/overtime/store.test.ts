import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkpointOvertimeExtension,
  commitOvertimeExtension,
  createOrGetOvertimeExtension,
  getOvertimeExtension,
  listOvertimeExtensions,
  markActiveOvertimeExtensionsInterrupted,
} from '@/lib/overtime/store';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import {
  db,
  deleteStageWithRelatedData,
  exportDatabase,
  importDatabase,
} from '@/lib/utils/database';

const decision = {
  disposition: 'append_page' as const,
  topic: 'approach',
  teachingMove: 'extend' as const,
};

const outline = {
  id: 'overtime-scene-1',
  order: 3,
  type: 'slide',
  title: 'Approach',
  description: 'Move closer.',
  keyPoints: ['meaning'],
} satisfies SceneOutline;

const scene = {
  id: outline.id,
  stageId: 'stage-1',
  type: 'slide',
  title: outline.title,
  order: outline.order,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-overtime',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
      elements: [],
    },
  },
  overtime: {
    extensionId: 'extension-1',
    sequence: 1,
    teachingMove: 'extend',
    conceptIds: ['approach'],
    sourceSceneIds: ['scene-1'],
  },
} satisfies Scene;

async function clearCoreTables() {
  await db.open();
  await db.transaction(
    'rw',
    [db.stages, db.scenes, db.stageOutlines, db.overtimeExtensions],
    async () => {
      await Promise.all([
        db.stages.clear(),
        db.scenes.clear(),
        db.stageOutlines.clear(),
        db.overtimeExtensions.clear(),
      ]);
    },
  );
}

describe('overtime extension persistence', () => {
  beforeEach(async () => {
    await clearCoreTables();
    await db.stages.put({
      id: 'stage-1',
      name: 'Motion verbs',
      createdAt: 1,
      updatedAt: 2,
    });
    await db.scenes.put({
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Go',
      order: 2,
      content: scene.content,
      createdAt: 1,
      updatedAt: 2,
    });
  });

  afterEach(clearCoreTables);

  it('uses Core Dexie v13 and creates only one unfinished task per course', async () => {
    expect(db.verno).toBe(13);
    expect(db.tables.map((table) => table.name)).toContain('overtimeExtensions');

    const first = await createOrGetOvertimeExtension({
      id: 'extension-1',
      stageId: 'stage-1',
      userPrompt: 'Teach me approach.',
      decision,
      now: 10,
    });
    const duplicate = await createOrGetOvertimeExtension({
      id: 'extension-2',
      stageId: 'stage-1',
      userPrompt: 'Another question.',
      decision: { ...decision, topic: 'arrive' },
      now: 20,
    });

    expect(first).toMatchObject({ sequence: 1, reservedOrder: 3, phase: 'outline' });
    expect(duplicate.id).toBe(first.id);
    expect(await listOvertimeExtensions('stage-1')).toHaveLength(1);
  });

  it('persists generation checkpoints and marks active work interrupted', async () => {
    await createOrGetOvertimeExtension({
      id: 'extension-1',
      stageId: 'stage-1',
      userPrompt: 'Teach me approach.',
      decision,
      now: 10,
    });
    await checkpointOvertimeExtension('extension-1', {
      phase: 'content',
      status: 'generating',
      outline,
      updatedAt: 11,
    });

    await markActiveOvertimeExtensionsInterrupted('stage-1', 12);

    expect(await getOvertimeExtension('extension-1')).toMatchObject({
      status: 'interrupted',
      phase: 'content',
      outline: { id: outline.id },
      updatedAt: 12,
    });
  });

  it('atomically commits the scene, outline, course timestamp, and ready task', async () => {
    await createOrGetOvertimeExtension({
      id: 'extension-1',
      stageId: 'stage-1',
      userPrompt: 'Teach me approach.',
      decision,
      now: 10,
    });

    const committed = await commitOvertimeExtension({
      extensionId: 'extension-1',
      outline,
      scene,
      now: 20,
    });

    expect(committed).toMatchObject({ status: 'ready', phase: 'commit', completedAt: 20 });
    expect(await db.scenes.get(scene.id)).toMatchObject({ overtime: scene.overtime });
    expect(await db.stageOutlines.get('stage-1')).toMatchObject({
      outlines: [expect.objectContaining({ id: scene.id })],
      generationComplete: true,
    });
    expect(await db.stages.get('stage-1')).toMatchObject({ updatedAt: 20 });

    await commitOvertimeExtension({ extensionId: 'extension-1', outline, scene, now: 30 });
    expect(
      (await db.scenes.where('stageId').equals('stage-1').toArray()).filter(
        (item) => item.id === scene.id,
      ),
    ).toHaveLength(1);
    expect((await db.stageOutlines.get('stage-1'))?.outlines).toHaveLength(1);
  });

  it('includes overtime tasks in backup restore and course deletion', async () => {
    await createOrGetOvertimeExtension({
      id: 'extension-1',
      stageId: 'stage-1',
      userPrompt: 'Teach me approach.',
      decision,
      now: 10,
    });
    const backup = await exportDatabase();

    expect(backup.overtimeExtensions).toEqual([
      expect.objectContaining({ id: 'extension-1', stageId: 'stage-1' }),
    ]);

    await deleteStageWithRelatedData('stage-1');
    expect(await db.overtimeExtensions.count()).toBe(0);

    await importDatabase(backup);
    expect(await db.overtimeExtensions.get('extension-1')).toMatchObject({
      stageId: 'stage-1',
      userPrompt: 'Teach me approach.',
    });
  });
});
