import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_MAX_AGE_MS, createAccessToken } from '@/lib/server/access-token';

const ownerBoundary = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/identity/with-owner', () => ({ withRequestOwner: ownerBoundary }));

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const routes = {
  ...import.meta.glob([
    '../../app/api/sandbox/**/route.ts',
    '!../../app/api/sandbox/preview/**/route.ts',
    '../../app/api/pbl/v3/**/route.ts',
  ]),
  '../../app/api/stages/[id]/roster/route.ts': () => import('@/app/api/stages/[id]/roster/route'),
};

describe.each(Object.entries(routes))('access code at %s', (_path, load) => {
  let handlers: Array<[string, Handler]>;
  beforeAll(async () => {
    handlers = Object.entries((await load()) as Record<string, unknown>).filter(([name]) =>
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name),
    ) as Array<[string, Handler]>;
    expect(handlers.length).toBeGreaterThan(0);
  });
  beforeEach(() => {
    vi.stubEnv('ACCESS_CODE', 'access-code-test-secret');
    vi.stubEnv('DATABASE_URL', 'postgres://fixture');
    ownerBoundary.mockReset();
    // Stop at the owner boundary so no database or sandbox work can start.
    ownerBoundary.mockImplementation(() => Response.json({ boundary: 'owner' }, { status: 418 }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['missing', 'invalid', 'expired'] as const)(
    'rejects a %s access cookie before resolving the owner',
    async (kind) => {
      const token =
        kind === 'expired'
          ? createAccessToken(
              'access-code-test-secret',
              Date.now() - ACCESS_TOKEN_MAX_AGE_MS - 1000,
            )
          : 'invalid-token';
      for (const [method, handle] of handlers) {
        const request = new Request('http://localhost/api/test', {
          method,
          headers: kind === 'missing' ? {} : { cookie: `openmaic_access=${token}` },
        });
        const response = await handle(request, { params: Promise.resolve({ id: 'fixture' }) });
        expect(response.status, method).toBe(401);
        expect(response.headers.get('cache-control'), method).toBe('no-store');
        expect(ownerBoundary, method).not.toHaveBeenCalled();
      }
    },
  );

  it('allows a current signed access cookie to reach the owner boundary', async () => {
    const token = createAccessToken('access-code-test-secret');
    for (const [method, handle] of handlers) {
      const request = new Request('http://localhost/api/test', {
        method,
        headers: { cookie: `openmaic_access=${token}` },
      });
      const response = await handle(request, { params: Promise.resolve({ id: 'fixture' }) });
      expect(response.status, method).toBe(418);
    }
    expect(ownerBoundary).toHaveBeenCalledTimes(handlers.length);
  });
});
