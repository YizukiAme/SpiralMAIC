import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAuthMethod } from '@/lib/server/identity/types';

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

const headerMethod: OwnerAuthMethod = {
  name: 'revisit-test-header',
  authenticate: async (request) => {
    const id = request.headers.get('x-test-user');
    if (!id) return { status: 'not-applicable' };
    return {
      status: 'authenticated',
      principal: { ownerId: `user:${id}`, kind: 'user', roles: new Set(), assurance: 'verified' },
    };
  },
};

describe('formal Revisit route', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', `postgres://revisit-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    pool = new PGlitePool(new PGlite());
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [headerMethod], anonymousFallback: false });
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const created = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/documents/stage-1', {
        method: 'PUT',
        headers: { 'x-test-user': 'alice', 'content-type': 'application/json' },
        body: JSON.stringify({
          stage: { id: 'stage-1', name: 'Lesson', createdAt: 1, updatedAt: 1 },
          scenes: [],
          outline: {
            outlines: [],
            requirement: 'Lesson',
            generationComplete: false,
            createdAt: 1,
            updatedAt: 1,
          },
        }),
      }),
      { poolFactory: () => pool as never },
    );
    expect(created.status).toBeLessThan(300);
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('keeps formal progress server-side and hides it from another owner', async () => {
    const { POST } = await import('@/app/api/spiral/revisit/route');
    const request = (owner: string, op: string, args: unknown) =>
      new Request('http://localhost/api/spiral/revisit', {
        method: 'POST',
        headers: { 'x-test-user': owner, 'content-type': 'application/json' },
        body: JSON.stringify({ op, args }),
      });
    const saved = await POST(
      request('alice', 'recordLessonCompleted', { stageId: 'stage-1', completedAt: 10 }),
    );
    expect(saved.status).toBe(200);
    const found = await POST(request('alice', 'getLessonProgress', { stageId: 'stage-1' }));
    expect(await found.json()).toEqual({
      result: { stageId: 'stage-1', completedAt: 10, updatedAt: 10 },
    });
    const foreign = await POST(request('bob', 'getLessonProgress', { stageId: 'stage-1' }));
    expect(foreign.status).toBe(404);
  });

  it('refuses a request without the configured access token before reading owner data', async () => {
    vi.stubEnv('ACCESS_CODE', 'long-revisit-test-access-code');
    const { POST } = await import('@/app/api/spiral/revisit/route');
    const response = await POST(
      new Request('http://localhost/api/spiral/revisit', {
        method: 'POST',
        headers: { 'x-test-user': 'alice', 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'getLessonProgress', args: { stageId: 'stage-1' } }),
      }),
    );
    expect(response.status).toBe(401);
  });
});
