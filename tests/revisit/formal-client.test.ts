import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearRevisitDatabase,
  createRevisitDemoSession,
  getLessonProgress,
  recordLessonCompleted,
  revisitDb,
} from '@/lib/revisit/db';
import { importLegacyRevisitAttemptSnapshot } from '@/lib/revisit/attempt-store';

describe('formal Revisit client transport', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearRevisitDatabase();
  });

  it('reads and writes formal progress through its owner-scoped server route', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('window', {
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(init.body as string) });
        return Response.json({
          result: {
            stageId: 'stage-1',
            completedAt: 10,
            updatedAt: 10,
          },
        });
      },
    });

    expect(await recordLessonCompleted('stage-1', 10)).toEqual({
      stageId: 'stage-1',
      completedAt: 10,
      updatedAt: 10,
    });
    expect(await getLessonProgress('stage-1')).toEqual({
      stageId: 'stage-1',
      completedAt: 10,
      updatedAt: 10,
    });
    expect(requests).toEqual([
      {
        url: '/api/spiral/revisit',
        body: { op: 'recordLessonCompleted', args: { stageId: 'stage-1', completedAt: 10 } },
      },
      {
        url: '/api/spiral/revisit',
        body: { op: 'getLessonProgress', args: { stageId: 'stage-1' } },
      },
    ]);
  });

  it('starts Demo from a server snapshot while writing only its local Demo database', async () => {
    const requests: string[] = [];
    vi.stubGlobal('window', {
      fetch: async (_url: string, init: RequestInit) => {
        const { op } = JSON.parse(init.body as string);
        requests.push(op);
        return Response.json({
          result: {
            lessonProgress: [{ stageId: 'stage-1', completedAt: 10, updatedAt: 10 }],
          },
        });
      },
    });

    await createRevisitDemoSession({ id: 'demo-1', stageId: 'stage-1', createdAt: 20 });
    expect(await getLessonProgress('stage-1', { kind: 'demo', sessionId: 'demo-1' })).toEqual({
      stageId: 'stage-1',
      completedAt: 10,
      updatedAt: 10,
    });
    expect(requests).toEqual(['snapshotStage']);
    expect(await revisitDb.lessonProgress.get('stage-1')).toBeUndefined();
  });

  it('imports an old tab-scoped attempt into formal server storage before clearing it', async () => {
    const values = new Map([
      [
        'revisitAttempt:attempt-1',
        JSON.stringify({
          attemptId: 'attempt-1',
          stageId: 'stage-1',
          blueprint: { id: 'bp-1' },
          scenes: [],
          createdAt: 10,
          updatedAt: 20,
          runtime: { pageIndex: 1 },
        }),
      ],
    ]);
    const requests: unknown[] = [];
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
      },
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        requests.push(body);
        return Response.json({ result: body.args.attempt });
      },
    });

    const imported = await importLegacyRevisitAttemptSnapshot('attempt-1');
    expect(imported).toMatchObject({ attemptId: 'attempt-1', stageId: 'stage-1' });
    expect(imported).not.toHaveProperty('runtime');
    expect(values.size).toBe(0);
    expect(requests).toMatchObject([{ op: 'importLegacyAttemptSnapshot' }]);
  });
});
