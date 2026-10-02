import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { LegacyBrowserDatabase } from '@/lib/legacy-browser-storage/schema';
import { RevisitDatabase } from '@/lib/revisit/db';

import {
  FakeServer,
  MemoryStorage,
  NOW,
  configureSeams,
  course,
  freshBrowser,
  seedDocumentsStore,
} from './harness';

let storage: MemoryStorage;
let server: FakeServer;
let teardown: () => Promise<void>;

beforeEach(async () => {
  await freshBrowser();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
  server = new FakeServer();
  teardown = await configureSeams(server);
});

afterEach(async () => {
  await teardown();
  vi.unstubAllGlobals();
});

describe('Spiral records on the legacy course import', () => {
  it('reports learning records without a matching local or owned server course', async () => {
    const revisit = new RevisitDatabase();
    await revisit.lessonProgress.put({
      stageId: 'missing-course',
      completedAt: NOW,
      updatedAt: NOW,
    });
    revisit.close();

    const result = await runLegacyBrowserImport(server.options(storage));

    expect(result.ledger?.courses['missing-course']).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('retained in browser'),
    });
  });

  it('copies overtime before Revisit, remaps the course, and resumes without reimporting overtime', async () => {
    await seedDocumentsStore([course('old-course', [{ id: 'scene-1', order: 0 }])]);
    const legacy = new LegacyBrowserDatabase();
    await legacy.overtimeExtensions.put({
      id: 'extension-1',
      stageId: 'old-course',
      sequence: 1,
      reservedOrder: 2,
      status: 'interrupted',
      phase: 'content',
      userPrompt: 'more',
      decision: { disposition: 'append_page', topic: 'more', teachingMove: 'extend' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    legacy.close();
    const revisit = new RevisitDatabase();
    await revisit.lessonProgress.put({ stageId: 'old-course', completedAt: NOW, updatedAt: NOW });
    revisit.close();

    // Another owner already has the old id, so the server creates a mapped id.
    await server.seedDocument(course('old-course', [{ id: 'other-scene', order: 0 }]), 'owner-b');
    const calls: string[] = [];
    let offline = true;
    const connect = (browserId: string) => ({
      ...server.clients(browserId),
      importOvertime: async (stageId: string, rows: { id: string }[]) => {
        calls.push(`overtime:${stageId}:${rows[0]?.id}`);
        return { insertedIds: rows.map((row) => row.id), conflictingIds: [] };
      },
      importRevisit: async (sourceStageId: string, stageId: string, rows: { kind: string }[]) => {
        calls.push(`revisit:${sourceStageId}:${stageId}:${rows[0]?.kind}`);
        if (offline) throw Object.assign(new Error('offline'), { status: 503 });
        return { insertedIds: ['old-course'], conflictingIds: [] };
      },
    });

    const first = await runLegacyBrowserImport(server.options(storage, { connect }));
    expect(first.status).toBe('pending');
    expect(first.ledger?.courses['old-course']?.steps.overtime).toBe('done');
    expect(first.ledger?.courses['old-course']?.steps.revisit).toBeUndefined();

    offline = false;
    const second = await runLegacyBrowserImport(
      server.options(storage, { connect, now: () => NOW + 60_000 }),
    );
    expect(second.status).toBe('complete');
    expect(calls.filter((call) => call.startsWith('overtime:'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('revisit:'))).toHaveLength(2);
    expect(calls[0]).toMatch(/^overtime:old-course-i[0-9a-f]{16}:extension-1$/);
    expect(calls[1]).toMatch(/^revisit:old-course:old-course-i[0-9a-f]{16}:lessonProgress$/);
  });
});
