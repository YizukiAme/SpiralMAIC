import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureRevisitSchema,
  importLegacyRevisitRecords,
  listRevisitRecords,
  putRevisitRecord,
  upsertRevisitLessonConceptsForStage,
} from '@/lib/revisit/server-store';
import type { LessonConcept } from '@/lib/revisit/types';

describe('formal Revisit persistence', () => {
  let db: PGlite;
  const concept: LessonConcept = {
    stageId: 'stage-1',
    conceptId: 'concept-1',
    label: 'Original',
    summary: 'Original summary',
    origin: 'lesson',
    sourceSceneIds: ['scene-1'],
    introducedAt: 10,
    learnedAt: 20,
    createdAt: 10,
    updatedAt: 20,
  };

  beforeEach(async () => {
    db = new PGlite();
    await db.query('CREATE TABLE document_stages (id TEXT PRIMARY KEY)');
    await db.query(
      'CREATE TABLE stage_meta (stage_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, deleted_at TIMESTAMPTZ)',
    );
    await db.query("INSERT INTO document_stages (id) VALUES ('stage-1')");
    await db.query("INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-1', 'owner-1')");
    await ensureRevisitSchema(db);
  });

  afterEach(async () => db.close());

  it('merges repeated concept writes for its owner and rejects a foreign owner', async () => {
    await upsertRevisitLessonConceptsForStage(db, 'owner-1', 'stage-1', [concept]);
    await upsertRevisitLessonConceptsForStage(db, 'owner-1', 'stage-1', [
      {
        ...concept,
        label: 'Refined',
        sourceSceneIds: ['scene-2'],
        introducedAt: 8,
        updatedAt: 30,
      },
    ]);

    expect(
      await listRevisitRecords<LessonConcept>(db, 'owner-1', 'stage-1', 'lessonConcepts'),
    ).toEqual([
      {
        ...concept,
        label: 'Refined',
        sourceSceneIds: ['scene-1', 'scene-2'],
        introducedAt: 8,
        updatedAt: 30,
      },
    ]);
    await expect(listRevisitRecords(db, 'owner-2', 'stage-1', 'lessonConcepts')).rejects.toThrow();
    await expect(
      upsertRevisitLessonConceptsForStage(db, 'owner-2', 'stage-1', [concept]),
    ).rejects.toThrow();
  });

  it('imports only missing legacy rows, remaps the top-level course, and reports equal retries', async () => {
    await putRevisitRecord(db, 'owner-1', 'stage-1', 'lessonProgress', 'stage-1', {
      stageId: 'stage-1',
      completedAt: 99,
      updatedAt: 99,
    });
    const rows = [
      {
        kind: 'lessonProgress' as const,
        recordId: 'stage-1',
        body: {
          stageId: 'old-stage',
          completedAt: 10,
          updatedAt: 10,
        },
      },
      {
        kind: 'lessonConcepts' as const,
        recordId: 'concept-1',
        body: {
          ...concept,
          stageId: 'old-stage',
          sourceSceneIds: ['old-stage-scene'],
        },
      },
    ];
    const first = await importLegacyRevisitRecords(db, 'owner-1', 'old-stage', 'stage-1', rows);
    const retry = await importLegacyRevisitRecords(db, 'owner-1', 'old-stage', 'stage-1', rows);

    expect(first).toEqual({
      insertedIds: ['lessonConcepts:concept-1'],
      conflictingIds: ['lessonProgress:stage-1'],
    });
    expect(retry).toEqual({ insertedIds: [], conflictingIds: ['lessonProgress:stage-1'] });
    expect(
      await listRevisitRecords<LessonConcept>(db, 'owner-1', 'stage-1', 'lessonConcepts'),
    ).toEqual([{ ...concept, sourceSceneIds: ['old-stage-scene'] }]);
  });

  it('remaps exact course references inside an attempt without changing scene IDs', async () => {
    await importLegacyRevisitRecords(db, 'owner-1', 'old-stage', 'stage-1', [
      {
        kind: 'revisitAttempts',
        recordId: 'attempt-1',
        body: {
          attemptId: 'attempt-1',
          stageId: 'old-stage',
          sourceStage: { id: 'old-stage', name: 'Lesson' },
          sourceScenes: [{ id: 'scene-1', stageId: 'old-stage' }],
        },
      },
    ]);
    expect(await listRevisitRecords(db, 'owner-1', 'stage-1', 'revisitAttempts')).toEqual([
      {
        attemptId: 'attempt-1',
        stageId: 'stage-1',
        sourceStage: { id: 'stage-1', name: 'Lesson' },
        sourceScenes: [{ id: 'scene-1', stageId: 'stage-1' }],
      },
    ]);
  });

  it('rejects an unknown legacy table name', async () => {
    await expect(
      importLegacyRevisitRecords(db, 'owner-1', 'old-stage', 'stage-1', [
        {
          kind: 'other' as never,
          recordId: 'x',
          body: { stageId: 'old-stage' },
        },
      ]),
    ).rejects.toThrow('Unknown legacy Revisit table');
  });
});
