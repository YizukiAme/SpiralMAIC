import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transport: vi.fn(),
  createTransport: vi.fn(),
  getValidCredentials: vi.fn(),
  getCodexAuthRuntime: vi.fn(),
  getAvailability: vi.fn(),
  genericGenerate: vi.fn(),
  genericConnectivity: vi.fn(),
  resolveKey: vi.fn(),
  resolveBaseUrl: vi.fn(),
  isServerConfigured: vi.fn(),
  validateUrl: vi.fn(),
  recordUsage: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/server/codex/image-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/codex/image-transport')>();
  return {
    ...actual,
    createCodexImageTransport: mocks.createTransport,
  };
});

vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime: mocks.getCodexAuthRuntime,
}));

vi.mock('@/lib/server/codex/availability', () => ({
  getCodexOAuthAvailability: mocks.getAvailability,
}));

vi.mock('@/lib/media/image-providers', () => ({
  IMAGE_PROVIDERS: {
    seedream: { id: 'seedream', requiresApiKey: true },
    'codex-image': {
      id: 'codex-image',
      requiresApiKey: false,
      credentialMode: 'oauth',
      models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
    },
  },
  generateImage: mocks.genericGenerate,
  testImageConnectivity: mocks.genericConnectivity,
  aspectRatioToDimensions: vi.fn(() => ({ width: 1024, height: 576 })),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfigured,
  resolveImageApiKey: mocks.resolveKey,
  resolveImageBaseUrl: mocks.resolveBaseUrl,
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: mocks.validateUrl,
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordUsage,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.log,
}));

import { POST as generateImage } from '@/app/api/generate/image/route';
import { POST as verifyImageProvider } from '@/app/api/verify-image-provider/route';
import {
  CODEX_IMAGE_GENERATIONS_ENDPOINT,
  CodexImageTransportError,
  type CodexImageGenerationRequest,
  type CreateCodexImageTransportOptions,
} from '@/lib/server/codex/image-transport';
import { CODEX_OAUTH_ERROR_CODES, CodexOAuthError } from '@/lib/server/codex/token-provider';

function request(
  path: string,
  headers: Record<string, string> = {},
  body: Record<string, unknown> = { prompt: 'private course prompt', aspectRatio: '16:9' },
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('/api/generate/image Codex branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTransport.mockReturnValue(mocks.transport);
    mocks.getValidCredentials.mockResolvedValue({
      accessToken: 'access-secret',
      accountId: 'account-secret',
    });
    mocks.getCodexAuthRuntime.mockReturnValue({
      tokenProvider: { getValidCredentials: mocks.getValidCredentials },
    });
    mocks.getAvailability.mockResolvedValue({ available: true });
    mocks.transport.mockResolvedValue({ base64: 'image-data', width: 1536, height: 864 });
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it('uses only the server OAuth transport and records fixed-model usage', async () => {
    const observation = {
      requestedSize: '1536x864',
      responseSize: '1536x864',
      responseSizeStatus: 'valid',
      actualWidth: 1536,
      actualHeight: 864,
      quality: 'auto',
      requestSizeDrift: false,
      responseSizeDrift: false,
      aspectRatioDrift: false,
    } as const;
    mocks.transport.mockResolvedValueOnce({
      base64: 'private-response-body-image-data',
      width: 1536,
      height: 864,
    });
    mocks.createTransport.mockImplementationOnce((options: CreateCodexImageTransportOptions) => {
      return async (endpoint: string, transportRequest: CodexImageGenerationRequest) => {
        void options.onObservation?.(observation);
        return mocks.transport(endpoint, transportRequest);
      };
    });
    const req = request('/api/generate/image', {
      'x-image-provider': 'codex-image',
      'x-image-model': 'gpt-image-2',
      'x-api-key': 'client-secret',
      'x-base-url': 'https://attacker.invalid/v1',
      'x-request-id': 'private-request-id',
      cookie: 'private-cookie',
    });

    const response = await generateImage(req);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      result: { base64: 'private-response-body-image-data', width: 1536, height: 864 },
    });
    expect(Object.keys(body).sort()).toEqual(['result', 'success']);
    expect(Object.keys(body.result).sort()).toEqual(['base64', 'height', 'width']);
    expect(mocks.createTransport).toHaveBeenCalledWith({
      tokenProvider: mocks.getCodexAuthRuntime.mock.results[0]?.value.tokenProvider,
      onObservation: expect.any(Function),
    });
    expect(mocks.transport).toHaveBeenCalledWith(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private course prompt',
      aspectRatio: '16:9',
      signal: req.signal,
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      kind: 'image',
      unit: 'image',
      providerId: 'codex-image',
      modelId: 'gpt-image-2',
      quantity: 1,
    });
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.resolveKey).not.toHaveBeenCalled();
    expect(mocks.resolveBaseUrl).not.toHaveBeenCalled();
    expect(mocks.validateUrl).not.toHaveBeenCalled();
    expect(mocks.genericGenerate).not.toHaveBeenCalled();
    expect(mocks.log.info).toHaveBeenCalledOnce();
    expect(mocks.log.info).toHaveBeenCalledWith('Codex image success observation', observation);
    expect(Object.keys(mocks.log.info.mock.calls[0]?.[1]).sort()).toEqual([
      'actualHeight',
      'actualWidth',
      'aspectRatioDrift',
      'quality',
      'requestSizeDrift',
      'requestedSize',
      'responseSize',
      'responseSizeDrift',
      'responseSizeStatus',
    ]);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toMatch(
      /private course prompt|private-response-body-image-data|access-secret|account-secret|client-secret|private-request-id|private-cookie/,
    );
  });

  it('rejects a client model override before reading OAuth credentials', async () => {
    const response = await generateImage(
      request('/api/generate/image', {
        'x-image-provider': 'codex-image',
        'x-image-model': 'attacker-model',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.getCodexAuthRuntime).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it.each([
    ['AUTH_REQUIRED', undefined, 401, 'INVALID_CREDENTIALS', null, null],
    ['STALE_CREDENTIALS', undefined, 401, 'INVALID_CREDENTIALS', null, null],
    ['IMAGE_ENTITLEMENT_UNAVAILABLE', 403, 403, 'PROVIDER_DISABLED', 'upstream-http', '403'],
    ['FORBIDDEN', 403, 403, 'UPSTREAM_ERROR', 'upstream-http', '403'],
    ['RATE_LIMITED', 429, 429, 'RATE_LIMITED', 'upstream-http', '429'],
    ['MODERATION_BLOCKED', 400, 400, 'CONTENT_SENSITIVE', 'upstream-http', '400'],
    ['REQUEST_REJECTED', 400, 400, 'INVALID_REQUEST', 'upstream-http', '400'],
    ['ROUTE_UNAVAILABLE', 405, 405, 'UPSTREAM_ERROR', 'upstream-http', '405'],
    ['UPSTREAM_UNAVAILABLE', 503, 502, 'UPSTREAM_ERROR', 'upstream-http', '503'],
    ['NETWORK_ERROR', undefined, 502, 'UPSTREAM_ERROR', 'network', null],
    ['INVALID_RESPONSE', undefined, 502, 'UPSTREAM_ERROR', 'invalid-response', null],
    ['LOCAL_UNAVAILABLE', undefined, 503, 'PROVIDER_DISABLED', null, null],
    ['TIMEOUT', undefined, 504, 'UPSTREAM_ERROR', 'timeout', null],
  ] as const)(
    'maps %s to safe API status/category',
    async (transportCode, upstreamStatus, status, errorCode, source, safeUpstreamStatus) => {
      mocks.transport.mockRejectedValueOnce(
        new CodexImageTransportError(transportCode, upstreamStatus),
      );

      const response = await generateImage(
        request('/api/generate/image', { 'x-image-provider': 'codex-image' }),
      );
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(status);
      expect(JSON.parse(serialized)).toMatchObject({ success: false, errorCode });
      expect(Object.keys(JSON.parse(serialized)).sort()).toEqual(['error', 'errorCode', 'success']);
      expect(response.headers.get('x-openmaic-codex-image-error-source')).toBe(source);
      expect(response.headers.get('x-openmaic-codex-image-upstream-status')).toBe(
        safeUpstreamStatus,
      );
      expect(serialized).not.toMatch(/private course prompt|access-secret|account-secret/);
      expect(JSON.stringify(mocks.log.error.mock.calls)).not.toMatch(
        /private course prompt|access-secret|account-secret/,
      );
      expect(mocks.transport).toHaveBeenCalledTimes(1);
      expect(mocks.recordUsage).not.toHaveBeenCalled();
    },
  );

  it('uses a generic local 500 without leaking an unexpected error', async () => {
    mocks.transport.mockRejectedValueOnce(
      new Error('unexpected upstream-body secret private course prompt'),
    );

    const response = await generateImage(
      request('/api/generate/image', { 'x-image-provider': 'codex-image' }),
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(JSON.parse(serialized)).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
    });
    expect(serialized).not.toMatch(/upstream-body|private course prompt/);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toMatch(
      /upstream-body|private course prompt/,
    );
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('preserves the existing generic route for non-Codex providers', async () => {
    mocks.resolveKey.mockReturnValueOnce('server-key');
    mocks.resolveBaseUrl.mockReturnValueOnce('https://image.example/v1');
    mocks.genericGenerate.mockResolvedValueOnce({ url: 'https://image.example/result.png' });

    const response = await generateImage(
      request('/api/generate/image', { 'x-image-provider': 'seedream' }),
    );

    expect(response.status).toBe(200);
    expect(mocks.genericGenerate).toHaveBeenCalledTimes(1);
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
});

describe('/api/verify-image-provider Codex branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTransport.mockReturnValue(mocks.transport);
    mocks.getValidCredentials.mockResolvedValue({
      accessToken: 'access-secret',
      accountId: 'account-secret',
    });
    mocks.getCodexAuthRuntime.mockReturnValue({
      tokenProvider: { getValidCredentials: mocks.getValidCredentials },
    });
    mocks.getAvailability.mockResolvedValue({ available: true });
  });

  it('checks OAuth credentials without creating an image transport', async () => {
    const response = await verifyImageProvider(
      request('/api/verify-image-provider', {
        'x-image-provider': 'codex-image',
        'x-api-key': 'client-secret',
        'x-base-url': 'https://attacker.invalid/v1',
        'x-image-model': 'attacker-model',
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Codex OAuth connection is ready',
    });
    expect(mocks.getValidCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.resolveKey).not.toHaveBeenCalled();
    expect(mocks.resolveBaseUrl).not.toHaveBeenCalled();
    expect(mocks.genericConnectivity).not.toHaveBeenCalled();
  });

  it('returns safe unavailable and reauthentication responses', async () => {
    mocks.getAvailability.mockResolvedValueOnce({
      available: false,
      reason: 'secret deployment detail',
    });
    const unavailable = await verifyImageProvider(
      request('/api/verify-image-provider', { 'x-image-provider': 'codex-image' }),
    );
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toContain('secret deployment detail');

    mocks.getValidCredentials.mockRejectedValueOnce(
      new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false),
    );
    const disconnected = await verifyImageProvider(
      request('/api/verify-image-provider', { 'x-image-provider': 'codex-image' }),
    );
    expect(disconnected.status).toBe(401);
    const serialized = JSON.stringify(await disconnected.json());
    expect(serialized).not.toContain('credentials are unavailable');
  });

  it.each([
    new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true),
    new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR, true, 503),
    new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false),
    new Error('runtime secret detail'),
  ])(
    'reports transient credential checks as unavailable without requesting login',
    async (error) => {
      mocks.getValidCredentials.mockRejectedValueOnce(error);

      const response = await verifyImageProvider(
        request('/api/verify-image-provider', { 'x-image-provider': 'codex-image' }),
      );
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(503);
      expect(serialized).toContain('PROVIDER_DISABLED');
      expect(serialized).not.toMatch(/runtime secret|authorization server|securely/);
    },
  );
});
