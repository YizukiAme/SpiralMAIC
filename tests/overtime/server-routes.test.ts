import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
  async end() {
    await this.db.close();
  }
}

const decision = { disposition: 'append_page', topic: 'Approach', teachingMove: 'extend' };

describe('server overtime routes', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', `postgres://overtime-route-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('ACCESS_CODE', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({
      anonymousFallback: false,
      methods: [
        {
          name: 'test-owner',
          authenticate: async (request) => {
            const identity = request.headers.get('x-test-owner');
            return identity
              ? {
                  status: 'authenticated',
                  principal: {
                    ownerId: `user:${identity}`,
                    kind: 'user',
                    roles: new Set<string>(),
                    assurance: 'verified',
                  },
                }
              : { status: 'not-applicable' };
          },
        },
      ],
    });
    await createOwnerBoundDocumentStore({
      pool,
      ownerId: 'user:alice',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).saveDocument({
      stage: { id: 'stage-1', name: 'Motion verbs', createdAt: 1, updatedAt: 2 },
      scenes: [],
      outline: { outlines: [], generationComplete: true, createdAt: 1, updatedAt: 2 },
    });
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  function request(path: string, owner: string | null, method = 'GET', body?: unknown) {
    return new NextRequest(`http://localhost${path}`, {
      method,
      headers: { ...(owner ? { 'x-test-owner': owner } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("creates and lists only the owner's durable overtime task", async () => {
    const { GET, POST } = await import('@/app/api/spiral/overtime/route');
    const created = await POST(
      request('/api/spiral/overtime', 'alice', 'POST', {
        id: 'task-1',
        stageId: 'stage-1',
        userPrompt: 'Teach approach',
        decision,
      }),
    );
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      extension: { id: 'task-1' },
      version: 1,
    });
    const listed = await GET(request('/api/spiral/overtime?stageId=stage-1', 'alice'));
    await expect(listed.json()).resolves.toMatchObject({
      extensions: [{ extension: { id: 'task-1' } }],
    });
    expect((await GET(request('/api/spiral/overtime?stageId=stage-1', 'bob'))).status).toBe(404);
  });

  it('refuses unauthenticated and stale writes', async () => {
    const { POST } = await import('@/app/api/spiral/overtime/route');
    const { PATCH } = await import('@/app/api/spiral/overtime/[id]/route');
    const { POST: claim } = await import('@/app/api/spiral/overtime/[id]/claim/route');
    expect(
      (
        await POST(
          request('/api/spiral/overtime', null, 'POST', {
            id: 'task-1',
            stageId: 'stage-1',
            userPrompt: 'Teach approach',
            decision,
          }),
        )
      ).status,
    ).toBe(401);
    expect((await POST(request('/api/spiral/overtime', null, 'POST', {}))).status).toBe(401);
    await POST(
      request('/api/spiral/overtime', 'alice', 'POST', {
        id: 'task-1',
        stageId: 'stage-1',
        userPrompt: 'Teach approach',
        decision,
      }),
    );
    const context = { params: Promise.resolve({ id: 'task-1' }) };
    const claimed = await claim(
      request('/api/spiral/overtime/task-1/claim', 'alice', 'POST', { version: 1 }),
      context,
    );
    expect(claimed.status).toBe(200);
    const lease = await claimed.json();
    expect(
      (
        await claim(
          request('/api/spiral/overtime/task-1/claim', 'alice', 'POST', { version: lease.version }),
          context,
        )
      ).status,
    ).toBe(409);
    const patch = {
      version: lease.version,
      leaseToken: lease.leaseToken,
      patch: { status: 'generating', phase: 'content', updatedAt: Date.now() },
    };
    expect(
      (await PATCH(request('/api/spiral/overtime/task-1', 'alice', 'PATCH', patch), context))
        .status,
    ).toBe(200);
    expect(
      (await PATCH(request('/api/spiral/overtime/task-1', 'alice', 'PATCH', patch), context))
        .status,
    ).toBe(409);
    expect(
      (await PATCH(request('/api/spiral/overtime/task-1', 'bob', 'PATCH', patch), context)).status,
    ).toBe(404);
  });

  it('reports legacy import collisions and refuses a deleted course', async () => {
    const { POST } = await import('@/app/api/spiral/overtime/import/route');
    const unbound = await POST(
      new NextRequest('http://localhost/api/spiral/overtime/import', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-owner': 'alice',
          'x-openmaic-legacy-import': '0123456789abcdef0123456789abcdef',
        },
        body: '{}',
      }),
    );
    expect(unbound.status).toBe(409);
    const record = {
      id: 'legacy-task',
      stageId: 'old-stage',
      sequence: 1,
      reservedOrder: 0,
      status: 'ready',
      phase: 'commit',
      userPrompt: 'First',
      decision,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    };
    const body = { stageId: 'stage-1', extensions: [record] };
    expect(
      (
        await POST(
          request('/api/spiral/overtime/import', 'alice', 'POST', {
            stageId: 'stage-1',
            extensions: [{ ...record, status: 'unknown' }],
          }),
        )
      ).status,
    ).toBe(400);
    const first = await POST(request('/api/spiral/overtime/import', 'alice', 'POST', body));
    await expect(first.json()).resolves.toEqual({
      insertedIds: ['legacy-task'],
      conflictingIds: [],
    });
    const repeat = await POST(request('/api/spiral/overtime/import', 'alice', 'POST', body));
    await expect(repeat.json()).resolves.toEqual({
      insertedIds: [],
      conflictingIds: ['legacy-task'],
    });
    await pool.query("UPDATE stage_meta SET deleted_at = now() WHERE stage_id = 'stage-1'");
    expect(
      (
        await POST(
          request('/api/spiral/overtime/import', 'alice', 'POST', {
            stageId: 'stage-1',
            extensions: [{ ...record, id: 'late-task' }],
          }),
        )
      ).status,
    ).toBe(404);
  });
});
