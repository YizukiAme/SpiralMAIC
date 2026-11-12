import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAccessToken } from '@/lib/server/access-token';

import { GITHUB_STARS_FAILURE_TTL_MS, GITHUB_STARS_TTL_MS } from '@/lib/server/github-stars';

/** Re-import the route so each test starts with an empty cache. */
async function loadGet(): Promise<(request: Request) => Promise<Response>> {
  vi.resetModules();
  const { GET } = await import('@/app/api/github-stars/route');
  return GET;
}

async function starsFrom(get: (request: Request) => Promise<Response>): Promise<unknown> {
  const response = await get(new Request('http://localhost/api/github-stars'));
  expect(response.status).toBe(200);
  return ((await response.json()) as { stars: unknown }).stars;
}

const fetchMock = vi.fn();
let now = 1_000_000;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('ACCESS_CODE', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/github-stars', () => {
  it('requires the deployment access cookie before contacting GitHub', async () => {
    vi.stubEnv('ACCESS_CODE', 'test-stars-access');
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 42 }));
    const GET = await loadGet();
    const denied = await GET(new Request('http://localhost/api/github-stars'));
    expect(denied.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    const allowed = await GET(
      new Request('http://localhost/api/github-stars', {
        headers: { cookie: `openmaic_access=${createAccessToken('test-stars-access')}` },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ stars: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the stargazer count and caches it for an hour', async () => {
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 12400 }));
    const GET = await loadGet();

    expect(await starsFrom(GET)).toBe(12400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/THU-MAIC/OpenMAIC');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();

    now += GITHUB_STARS_TTL_MS - 1;
    expect(await starsFrom(GET)).toBe(12400);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 2;
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 12500 }));
    expect(await starsFrom(GET)).toBe(12500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 7 }));
    const GET = await loadGet();

    const [a, b] = await Promise.all([starsFrom(GET), starsFrom(GET)]);
    expect([a, b]).toEqual([7, 7]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends GITHUB_TOKEN as a bearer token when set', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 1 }));
    const GET = await loadGet();

    await starsFrom(GET);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('offline'))],
    ['a non-OK status', () => Promise.resolve(new Response('rate limited', { status: 403 }))],
    ['a malformed body', () => Promise.resolve(Response.json({ stargazers_count: 'many' }))],
    ['invalid JSON', () => Promise.resolve(new Response('not json', { status: 200 }))],
  ])('returns null on %s and caches the failure briefly', async (_label, respond) => {
    fetchMock.mockImplementation(respond);
    const GET = await loadGet();

    expect(await starsFrom(GET)).toBeNull();
    now += GITHUB_STARS_FAILURE_TTL_MS - 1;
    expect(await starsFrom(GET)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 2;
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 42 }));
    expect(await starsFrom(GET)).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
