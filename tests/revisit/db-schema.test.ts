import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import { REVISIT_DATABASE_NAME, RevisitDatabase, revisitDb } from '@/lib/revisit/db';

describe('SpiralMAIC revisit Dexie schema', () => {
  it('uses an independent database with the required PRD tables', () => {
    expect(REVISIT_DATABASE_NAME).toBe('SpiralMAIC-Revisit');
    expect(revisitDb.verno).toBe(8);
    expect(revisitDb.tables.map((table) => table.name).sort()).toEqual([
      'conceptEvidence',
      'examBlueprints',
      'lessonConcepts',
      'lessonProgress',
      'revisitAttempts',
      'revisitDemoSessions',
      'revisitReports',
      'studyArtifacts',
      'studyMaterials',
      'studyPractice',
      'userConceptState',
    ]);
  });

  it('upgrades a v4 database without deleting legacy material records', async () => {
    revisitDb.close();
    await Dexie.delete(REVISIT_DATABASE_NAME);
    const legacy = new Dexie(REVISIT_DATABASE_NAME);
    legacy.version(4).stores({
      studyMaterials: 'id, stageId, generatedAt, sourceHash, [stageId+generatedAt]',
      lessonProgress: 'stageId, completedAt, updatedAt',
    });
    await legacy.open();
    await legacy.table('studyMaterials').put({
      id: 'legacy-materials',
      stageId: 'stage-1',
      generatedAt: 10,
      sourceHash: 'legacy-source',
      studyGuide: '# Legacy data remains readable',
    });
    legacy.close();

    try {
      await revisitDb.open();

      expect(revisitDb.verno).toBe(8);
      expect(await revisitDb.table('studyMaterials').get('legacy-materials')).toMatchObject({
        stageId: 'stage-1',
        sourceHash: 'legacy-source',
      });
      expect(revisitDb.tables.map((table) => table.name)).toContain('studyArtifacts');
      expect(revisitDb.tables.map((table) => table.name)).toContain('studyPractice');
      expect(revisitDb.tables.map((table) => table.name)).toContain('revisitAttempts');
      expect(revisitDb.tables.map((table) => table.name)).toContain('lessonConcepts');
    } finally {
      revisitDb.close();
      await Dexie.delete(REVISIT_DATABASE_NAME);
      await revisitDb.open();
    }
  });

  it('upgrades v7 by dropping only the obsolete skeleton deck cache', async () => {
    const databaseName = `${REVISIT_DATABASE_NAME}-v7-upgrade-test`;
    await Dexie.delete(databaseName);
    const legacy = new Dexie(databaseName);
    legacy.version(7).stores({
      userConceptState:
        '[stageId+conceptId], stageId, conceptId, lastRetrievalAt, stableAt, updatedAt',
      conceptEvidence:
        'id, stageId, conceptId, attemptId, timestamp, [stageId+timestamp], [stageId+conceptId]',
      examBlueprints: 'id, stageId, generatedAt, sourceHash',
      skeletonDecks: 'id, stageId, blueprintId, generatedAt, sourceHash',
      revisitReports: 'attemptId, stageId, completedAt',
      lessonProgress: 'stageId, completedAt, updatedAt',
      studyMaterials: 'id, stageId, generatedAt, sourceHash, [stageId+generatedAt]',
      studyArtifacts:
        'id, stageId, kind, version, updatedAt, [stageId+kind], [stageId+kind+version], [stageId+updatedAt]',
      studyPractice: 'artifactId, stageId, kind, updatedAt, [stageId+kind], [stageId+updatedAt]',
      revisitAttempts:
        'attemptId, stageId, sequence, status, createdAt, completedAt, [stageId+sequence], [stageId+status]',
      revisitDemoSessions: 'id, status, createdAt, updatedAt',
      lessonConcepts:
        '[stageId+conceptId], stageId, conceptId, origin, learnedAt, updatedAt, [stageId+origin]',
    });
    await legacy.open();
    await legacy
      .table('lessonProgress')
      .put({ stageId: 'stage-1', completedAt: 100, updatedAt: 100 });
    await legacy.table('revisitAttempts').put({
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      sequence: 1,
      status: 'ready',
      sourceScenes: [],
      scenes: [],
      createdAt: 100,
      updatedAt: 100,
    });
    await legacy.table('skeletonDecks').put({
      id: 'obsolete-deck',
      stageId: 'stage-1',
      blueprintId: 'blueprint-1',
      generatedAt: 100,
      sourceHash: 'source-1',
      scenes: [],
    });
    legacy.close();

    const upgraded = new RevisitDatabase(databaseName);
    try {
      await upgraded.open();

      expect(upgraded.verno).toBe(8);
      expect(upgraded.tables.map((table) => table.name)).not.toContain('skeletonDecks');
      expect(Array.from(upgraded.backendDB().objectStoreNames)).not.toContain('skeletonDecks');
      expect(await upgraded.table('lessonProgress').get('stage-1')).toMatchObject({
        completedAt: 100,
      });
      expect(await upgraded.table('revisitAttempts').get('attempt-1')).toMatchObject({
        status: 'ready',
      });
    } finally {
      upgraded.close();
      await Dexie.delete(databaseName);
    }
  });

  it('migrates old reports into stable report-only Reverse history records', async () => {
    revisitDb.close();
    await Dexie.delete(REVISIT_DATABASE_NAME);
    const legacy = new Dexie(REVISIT_DATABASE_NAME);
    legacy.version(5).stores({
      revisitReports: 'attemptId, stageId, completedAt',
    });
    await legacy.open();
    await legacy.table('revisitReports').bulkPut([
      { attemptId: 'later', stageId: 'stage-1', completedAt: 20 },
      { attemptId: 'earlier', stageId: 'stage-1', completedAt: 10 },
    ]);
    legacy.close();

    try {
      await revisitDb.open();
      const attempts = await revisitDb.table('revisitAttempts').toArray();
      expect(attempts).toEqual([
        expect.objectContaining({ attemptId: 'earlier', sequence: 1, reportOnly: true }),
        expect.objectContaining({ attemptId: 'later', sequence: 2, reportOnly: true }),
      ]);
    } finally {
      revisitDb.close();
      await Dexie.delete(REVISIT_DATABASE_NAME);
      await revisitDb.open();
    }
  });
});
