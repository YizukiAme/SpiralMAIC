import { NextRequest } from 'next/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createAccessToken } from '@/lib/server/access-token';
import { proxy } from '@/proxy';

describe('access-code proxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test('allows local deployments and public endpoints', () => {
    vi.stubEnv('ACCESS_CODE', '');
    expect(proxy(new NextRequest('http://localhost/api/chat')).status).toBe(200);

    vi.stubEnv('ACCESS_CODE', 'secret');
    expect(proxy(new NextRequest('http://localhost/api/health')).status).toBe(200);
    expect(proxy(new NextRequest('http://localhost/api/access-code/status')).status).toBe(200);
  });

  test('rejects protected APIs without a valid cookie but lets pages render the sign-in modal', () => {
    vi.stubEnv('ACCESS_CODE', 'secret');

    expect(proxy(new NextRequest('http://localhost/api/chat')).status).toBe(401);
    expect(proxy(new NextRequest('http://localhost/')).status).toBe(200);
  });

  test('accepts a current signed cookie and rejects it after expiry', () => {
    const now = Date.parse('2026-06-25T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv('ACCESS_CODE', 'secret');
    const token = createAccessToken('secret', now);
    const request = () =>
      new NextRequest('http://localhost/api/chat', {
        headers: { cookie: `openmaic_access=${token}` },
      });

    expect(proxy(request()).status).toBe(200);
    vi.setSystemTime(now + 7 * 24 * 60 * 60 * 1000 + 1);
    expect(proxy(request()).status).toBe(401);
  });
});
