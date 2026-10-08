import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const routes = [
  ['agents/route', 'GET'],
  ['agents/route', 'POST'],
  ['agents/[id]/route', 'PUT'],
  ['agents/[id]/route', 'DELETE'],
  ['agents/import/route', 'POST'],
  ['generate-classroom/capabilities/route', 'GET'],
  ['generation-runs/route', 'GET'],
  ['generation-runs/route', 'POST'],
  ['generation-runs/[id]/route', 'GET'],
  ['generation-runs/[id]/route', 'DELETE'],
  ['generation-runs/events/route', 'GET'],
  ['generation-runs/[id]/events/route', 'GET'],
  ['generation-runs/[id]/confirm-outline/route', 'POST'],
  ['generation-runs/[id]/hold-outline/route', 'POST'],
  ['generation-runs/[id]/retry/route', 'POST'],
  ['materials/[id]/extraction/route', 'POST'],
] as const;
const modules = import.meta.glob('../../app/api/**/route.ts');

afterEach(() => vi.unstubAllEnvs());
describe('new server APIs keep the deployment access gate', () => {
  it.each(routes)('%s %s refuses before owner resolution or paid work', async (path, method) => {
    vi.stubEnv('ACCESS_CODE', 'test-deployment-gate');
    vi.stubEnv('DATABASE_URL', '');
    const handlers = (await modules[`../../app/api/${path}.ts`]()) as Record<
      string,
      (...args: unknown[]) => Promise<Response>
    >;
    const req = new NextRequest('http://localhost/api/test?active=1', { method });
    const response = await handlers[method](req, { params: Promise.resolve({ id: 'not-owned' }) });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toMatchObject({ success: false, error: 'Access code required' });
  });
});
