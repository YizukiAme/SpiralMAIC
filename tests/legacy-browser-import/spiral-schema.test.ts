import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_DATABASE_NAME, LegacyBrowserDatabase } from '@/lib/legacy-browser-storage/schema';
import {
  readLegacyOvertimeExtensions,
  readLegacyOvertimeStageIds,
} from '@/lib/legacy-browser-storage';

afterEach(async () => {
  await Dexie.delete(LEGACY_DATABASE_NAME);
});

describe('Spiral legacy database', () => {
  it('reads an existing overtime task without dropping its table', async () => {
    const old = new Dexie(LEGACY_DATABASE_NAME);
    old.version(17).stores({ overtimeExtensions: 'id, stageId, sequence' });
    await old.open();
    await old.table('overtimeExtensions').put({
      id: 'extension-1',
      stageId: 'course-1',
      sequence: 2,
      status: 'interrupted',
    });
    old.close();

    const reader = new LegacyBrowserDatabase();
    try {
      await reader.open();
      expect(await reader.table('overtimeExtensions').get('extension-1')).toMatchObject({
        stageId: 'course-1',
        sequence: 2,
      });
    } finally {
      reader.close();
    }
  });

  it('lists only the requested course tasks for import', async () => {
    const old = new LegacyBrowserDatabase();
    await old.overtimeExtensions.bulkPut([
      { id: 'one', stageId: 'course-1', sequence: 1, status: 'interrupted' },
      { id: 'two', stageId: 'course-2', sequence: 1, status: 'ready' },
    ] as never);
    old.close();

    expect((await readLegacyOvertimeExtensions('course-1')).map((row) => row.id)).toEqual(['one']);
    expect(await readLegacyOvertimeStageIds()).toEqual(['course-1', 'course-2']);
  });
});
