import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessToken } from '@/lib/server/access-token';

const service = vi.hoisted(() => ({ previewTarget: vi.fn(), openPreviewConnection: vi.fn() }));
vi.mock('@/lib/server/sandbox/service', () => ({ SandboxService: service }));
import { POST as resolvePreview } from '@/app/api/sandbox/preview/resolve/route';
import { POST as tunnelPreview } from '@/app/api/sandbox/preview/tunnel/route';

const key = 'preview-gateway-test-key-32-characters';
const descriptor = JSON.stringify({ ticket: 'fixture-ticket', host: 'fixture.localhost' });
function signature(at = Date.now()) {
  return `${at}.${createHmac('sha256', key).update(`${at}.${descriptor}`).digest('hex')}`;
}
function request(route: string, signed?: string, cookie?: string) {
  return new Request(`http://localhost/api/sandbox/preview/${route}`, {
    method: 'POST',
    headers: {
      ...(signed ? { 'x-openmaic-preview-gateway': signed } : {}),
      ...(route === 'tunnel' ? { 'x-openmaic-preview-request': descriptor } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: route === 'tunnel' ? 'preview bytes' : descriptor,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ACCESS_CODE', 'access-code-test-secret');
  vi.stubEnv('OPENMAIC_PREVIEW_GATEWAY_KEY', key);
  service.previewTarget.mockResolvedValue({ transport: 'document', expiresAt: 1 });
  service.openPreviewConnection.mockResolvedValue({
    output: new ReadableStream({ start: (controller) => controller.close() }),
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => vi.unstubAllEnvs());

describe.each([
  ['resolve', resolvePreview],
  ['tunnel', tunnelPreview],
] as const)('machine preview %s with access-code protection', (route, handle) => {
  it.each(['missing', 'invalid', 'expired'] as const)(
    'rejects a %s gateway signature even with a valid browser cookie',
    async (kind) => {
      const signed =
        kind === 'missing'
          ? undefined
          : kind === 'expired'
            ? signature(Date.now() - 31_000)
            : 'bad';
      const cookie = `openmaic_access=${createAccessToken('access-code-test-secret')}`;
      const response = await handle(request(route, signed, cookie));
      expect(response.status).toBe(403);
      expect(service.previewTarget).not.toHaveBeenCalled();
      expect(service.openPreviewConnection).not.toHaveBeenCalled();
    },
  );

  it('accepts the real gateway signature without a browser cookie', async () => {
    const response = await handle(request(route, signature()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await response.arrayBuffer();
    expect(
      route === 'resolve' ? service.previewTarget : service.openPreviewConnection,
    ).toHaveBeenCalledOnce();
  });
});
