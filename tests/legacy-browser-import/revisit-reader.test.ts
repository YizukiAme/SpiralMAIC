import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { REVISIT_DATABASE_NAME, RevisitDatabase } from '@/lib/revisit/db';
import { hasLegacyBrowserStorage } from '@/lib/legacy-browser-storage';
import {
  readLegacyRevisitRows,
  readLegacyRevisitStageIds,
} from '@/lib/legacy-browser-storage/revisit';

afterEach(async () => {
  await Dexie.delete(REVISIT_DATABASE_NAME);
});

describe('legacy formal Revisit reader', () => {
  it('reads only the requested course and never uploads Demo sessions', async () => {
    const old = new RevisitDatabase();
    await old.open();
    await old.lessonProgress.bulkPut([
      { stageId: 'course-1', completedAt: 100, updatedAt: 100 },
      { stageId: 'course-2', completedAt: 200, updatedAt: 200 },
    ] as never);
    await old.revisitDemoSessions.put({
      id: 'demo-1',
      stageId: 'course-1',
      databaseName: 'demo-local',
      status: 'active',
      createdAt: 100,
      updatedAt: 100,
      offsetHours: 0,
    });
    old.close();

    expect(await hasLegacyBrowserStorage()).toBe(true);
    expect(await readLegacyRevisitStageIds()).toEqual(['course-1', 'course-2']);
    expect(await readLegacyRevisitRows('course-1')).toEqual([
      {
        kind: 'lessonProgress',
        recordId: 'course-1',
        body: { stageId: 'course-1', completedAt: 100, updatedAt: 100 },
      },
    ]);
  });

  it('does not create a database during an empty probe', async () => {
    expect(await readLegacyRevisitRows('course-1')).toEqual([]);
    expect(await readLegacyRevisitStageIds()).toEqual([]);
    expect(await Dexie.exists(REVISIT_DATABASE_NAME)).toBe(false);
  });
});
