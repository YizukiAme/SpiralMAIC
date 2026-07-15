import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import { REVISIT_DATABASE_NAME, revisitDb } from '@/lib/revisit/db';

describe('SpiralMAIC revisit Dexie schema', () => {
  it('uses an independent database with the required PRD tables', () => {
    expect(REVISIT_DATABASE_NAME).toBe('SpiralMAIC-Revisit');
    expect(revisitDb.tables.map((table) => table.name).sort()).toEqual([
      'conceptEvidence',
      'examBlueprints',
      'lessonConcepts',
      'lessonProgress',
      'revisitAttempts',
      'revisitDemoSessions',
      'revisitReports',
      'skeletonDecks',
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

      expect(revisitDb.verno).toBe(7);
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
