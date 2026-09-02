import { afterEach, describe, expect, test, vi } from 'vitest';

import { createAccessToken } from '@/lib/server/access-token';
import { withAccessCode } from '@/lib/server/with-access-code';

describe('withAccessCode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('passes through when access-code protection is disabled', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    const handler = withAccessCode(async (_request: Request) => Response.json({ ok: true }));

    expect((await handler(new Request('http://localhost/api/test'))).status).toBe(200);
  });

  test('rejects missing and invalid cookies', async () => {
    vi.stubEnv('ACCESS_CODE', 'secret');
    const handler = withAccessCode(async (_request: Request) => Response.json({ ok: true }));

    const missing = await handler(new Request('http://localhost/api/test'));
    const invalid = await handler(
      new Request('http://localhost/api/test', { headers: { cookie: 'openmaic_access=bad' } }),
    );

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  test('accepts a current signed cookie', async () => {
    vi.stubEnv('ACCESS_CODE', 'secret');
    const handler = withAccessCode(async (_request: Request) => Response.json({ ok: true }));
    const token = createAccessToken('secret');
    const response = await handler(
      new Request('http://localhost/api/test', {
        headers: { cookie: `other=value; openmaic_access=${token}` },
      }),
    );

    expect(response.status).toBe(200);
  });
});
