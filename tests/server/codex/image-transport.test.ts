import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_IMAGE_GENERATIONS_ENDPOINT,
  CodexImageTransportError,
  createCodexImageTransport,
  mapCodexImageSize,
} from '@/lib/server/codex/image-transport';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  type CodexTokenProvider,
} from '@/lib/server/codex/token-provider';

function pngBase64(width: number, height: number): string {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = 6;
  return png.toString('base64');
}

function imageResponse(
  width = 1024,
  height = 1024,
  metadata: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ ...metadata, data: [{ b64_json: pngBase64(width, height) }] }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function tokenProvider(initial = { accessToken: 'access-secret', accountId: 'account-secret' }) {
  let current = initial;
  return {
    get current() {
      return current;
    },
    getValidCredentials: vi.fn(async () => ({ ...current })),
    refreshIfCurrent: vi.fn(async () => {
      current = { accessToken: 'rotated-secret', accountId: initial.accountId };
      return { ...current };
    }),
  } satisfies CodexTokenProvider & {
    readonly current: { accessToken: string; accountId: string };
    refreshIfCurrent(expected: {
      accessToken: string;
      accountId: string;
    }): Promise<{ accessToken: string; accountId: string }>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Codex image request contract', () => {
  it.each([
    ['16:9', '1536x864'],
    ['4:3', '1024x768'],
    ['1:1', '1024x1024'],
    ['9:16', '864x1536'],
    [undefined, '1024x1024'],
  ] as const)('maps %s to %s', (ratio, expected) => {
    expect(mapCodexImageSize(ratio)).toBe(expected);
  });

  it.each([
    'http://chatgpt.com/backend-api/codex/images/generations',
    'https://chatgpt.com/backend-api/codex/images/generations/',
    'https://chatgpt.com/backend-api/codex/images/generations?x=1',
    'https://CHATGPT.com/backend-api/codex/images/generations',
    'https://chatgpt.com/backend-api/codex/responses',
  ])('rejects non-literal endpoint %s before reading credentials', async (endpoint) => {
    const credentials = tokenProvider();
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    await expect(transport(endpoint, { prompt: 'secret prompt' })).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
    });
    expect(credentials.getValidCredentials).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('forces OAuth identity, official request fields, and redirect rejection', async () => {
    const credentials = tokenProvider();
    const upstreamFetch = vi.fn<typeof fetch>(async () => imageResponse(1536, 864));
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
        prompt: 'course illustration',
        aspectRatio: '16:9',
      }),
    ).resolves.toEqual({ base64: pngBase64(1536, 864), width: 1536, height: 864 });

    const [url, init] = upstreamFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CODEX_IMAGE_GENERATIONS_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'course illustration',
      background: 'auto',
      model: 'gpt-image-2',
      quality: 'auto',
      size: '1536x864',
    });
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer access-secret');
    expect(headers.get('chatgpt-account-id')).toBe('account-secret');
    expect(headers.get('originator')).toBe('openmaic');
    expect(headers.get('user-agent')).toMatch(/^OpenMAIC\/0\.3\.0/);
    expect(headers.get('version')).toBe('0.3.0');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('rejects an unsupported runtime aspect ratio before reading credentials', async () => {
    const credentials = tokenProvider();
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
        prompt: 'image',
        aspectRatio: '2:1' as '1:1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(credentials.getValidCredentials).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe('Codex image response safety', () => {
  it('accepts a square PNG whose actual and response dimensions drift from the request', async () => {
    const onObservation = vi.fn();
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        imageResponse(1254, 1254, { size: '1254x1254', quality: 'high' }),
      ),
      onObservation,
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image', aspectRatio: '1:1' }),
    ).resolves.toEqual({ base64: pngBase64(1254, 1254), width: 1254, height: 1254 });
    expect(onObservation).toHaveBeenCalledOnce();
    expect(onObservation.mock.calls[0]?.[0]).toEqual({
      requestedSize: '1024x1024',
      responseSize: '1254x1254',
      responseSizeStatus: 'valid',
      actualWidth: 1254,
      actualHeight: 1254,
      quality: 'high',
      requestSizeDrift: true,
      responseSizeDrift: false,
      aspectRatioDrift: false,
    });
  });

  it('accepts a safe 3:2 PNG for a 16:9 request and reports aspect-ratio drift', async () => {
    const onObservation = vi.fn();
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        imageResponse(1500, 1000, { size: '1500x1000', quality: 'medium' }),
      ),
      onObservation,
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image', aspectRatio: '16:9' }),
    ).resolves.toEqual({ base64: pngBase64(1500, 1000), width: 1500, height: 1000 });
    expect(onObservation.mock.calls[0]?.[0]).toEqual({
      requestedSize: '1536x864',
      responseSize: '1500x1000',
      responseSizeStatus: 'valid',
      actualWidth: 1500,
      actualHeight: 1000,
      quality: 'medium',
      requestSizeDrift: true,
      responseSizeDrift: false,
      aspectRatioDrift: true,
    });
  });

  it.each([
    { width: 1020, height: 1000, expectedDrift: false },
    { width: 1021, height: 1000, expectedDrift: true },
  ])(
    'uses a 2% relative-ratio tolerance for $width x $height',
    async ({ width, height, expectedDrift }) => {
      const onObservation = vi.fn();
      const transport = createCodexImageTransport({
        tokenProvider: tokenProvider(),
        upstreamFetch: vi.fn<typeof fetch>(async () =>
          imageResponse(width, height, { size: `${width}x${height}` }),
        ),
        onObservation,
      });

      await expect(
        transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image', aspectRatio: '1:1' }),
      ).resolves.toMatchObject({ width, height });
      expect(onObservation.mock.calls[0]?.[0]).toMatchObject({
        aspectRatioDrift: expectedDrift,
      });
    },
  );

  it.each([
    {
      label: 'absent',
      metadata: {},
      expected: {
        requestedSize: '1024x1024',
        responseSizeStatus: 'absent',
        actualWidth: 1254,
        actualHeight: 1254,
        requestSizeDrift: true,
        aspectRatioDrift: false,
      },
    },
    {
      label: 'malformed',
      metadata: { size: 'private-malformed-response-size' },
      expected: {
        requestedSize: '1024x1024',
        responseSizeStatus: 'invalid',
        actualWidth: 1254,
        actualHeight: 1254,
        requestSizeDrift: true,
        aspectRatioDrift: false,
      },
    },
    {
      label: 'IHDR-mismatched',
      metadata: { size: '1024x1024' },
      expected: {
        requestedSize: '1024x1024',
        responseSize: '1024x1024',
        responseSizeStatus: 'valid',
        actualWidth: 1254,
        actualHeight: 1254,
        requestSizeDrift: true,
        responseSizeDrift: true,
        aspectRatioDrift: false,
      },
    },
  ])(
    'treats $label response size metadata as a soft observation',
    async ({ metadata, expected }) => {
      const onObservation = vi.fn();
      const transport = createCodexImageTransport({
        tokenProvider: tokenProvider(),
        upstreamFetch: vi.fn<typeof fetch>(async () => imageResponse(1254, 1254, metadata)),
        onObservation,
      });

      await expect(
        transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image', aspectRatio: '1:1' }),
      ).resolves.toMatchObject({ width: 1254, height: 1254 });
      expect(onObservation.mock.calls[0]?.[0]).toEqual(expected);
      expect(JSON.stringify(onObservation.mock.calls[0]?.[0])).not.toContain(
        'private-malformed-response-size',
      );
    },
  );

  it('omits unknown response quality instead of retaining it', async () => {
    const onObservation = vi.fn();
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        imageResponse(1024, 1024, { size: '1024x1024', quality: 'private-ultra-quality' }),
      ),
      onObservation,
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).resolves.toMatchObject({ width: 1024, height: 1024 });
    expect(onObservation).toHaveBeenCalledOnce();
    const observation = onObservation.mock.calls[0]?.[0];
    expect(observation).not.toHaveProperty('quality');
    expect(JSON.stringify(observation)).not.toContain('private-ultra-quality');
  });

  it('exposes only the observation whitelist to the callback', async () => {
    const onObservation = vi.fn();
    const base64 = pngBase64(1024, 1024);
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        imageResponse(1024, 1024, { size: '1024x1024', quality: 'auto' }),
      ),
      onObservation,
    });

    await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private-prompt-that-must-not-leak',
    });

    expect(onObservation).toHaveBeenCalledOnce();
    const observation = onObservation.mock.calls[0]?.[0];
    expect(Object.keys(observation).sort()).toEqual(
      [
        'actualHeight',
        'actualWidth',
        'aspectRatioDrift',
        'quality',
        'requestSizeDrift',
        'requestedSize',
        'responseSize',
        'responseSizeDrift',
        'responseSizeStatus',
      ].sort(),
    );
    expect(JSON.stringify(observation)).not.toMatch(
      /private-prompt-that-must-not-leak|access-secret|account-secret/,
    );
    expect(JSON.stringify(observation)).not.toContain(base64);
  });

  it('swallows an observation callback exception after parsing a valid image', async () => {
    const onObservation = vi.fn(() => {
      throw new Error('private callback failure');
    });
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () => imageResponse()),
      onObservation,
    });

    await expect(transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' })).resolves.toEqual(
      { base64: pngBase64(1024, 1024), width: 1024, height: 1024 },
    );
    expect(onObservation).toHaveBeenCalledOnce();
  });

  it('sinks an asynchronous observation rejection without delaying the valid image', async () => {
    let rejectObservation!: (reason?: unknown) => void;
    const callbackResult = new Promise<void>((_resolve, reject) => {
      rejectObservation = reject;
    });
    const thenSpy = vi.spyOn(callbackResult, 'then');
    const catchSpy = vi.spyOn(callbackResult, 'catch');
    let observationCalls = 0;
    const onObservation = () => {
      observationCalls += 1;
      return callbackResult;
    };
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () => imageResponse()),
      onObservation,
    });

    await expect(transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' })).resolves.toEqual(
      { base64: pngBase64(1024, 1024), width: 1024, height: 1024 },
    );
    expect(observationCalls).toBe(1);

    const hasRejectionSink =
      catchSpy.mock.calls.some(([onRejected]) => typeof onRejected === 'function') ||
      thenSpy.mock.calls.some(([, onRejected]) => typeof onRejected === 'function');
    if (!hasRejectionSink) void callbackResult.catch(() => undefined);

    rejectObservation(new Error('private asynchronous callback failure'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(hasRejectionSink).toBe(true);
  });

  it('refreshes on one 401 and replays the identical serialized body once', async () => {
    const credentials = tokenProvider();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('secret body', { status: 401 }))
      .mockResolvedValueOnce(imageResponse());
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'one image', aspectRatio: '1:1' }),
    ).resolves.toMatchObject({ width: 1024, height: 1024 });

    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(credentials.refreshIfCurrent).toHaveBeenCalledTimes(1);
    expect(upstreamFetch.mock.calls[1]?.[1]?.body).toBe(upstreamFetch.mock.calls[0]?.[1]?.body);
    expect(new Headers(upstreamFetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer rotated-secret',
    );
  });

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
    [404, 'ROUTE_UNAVAILABLE'],
    [405, 'ROUTE_UNAVAILABLE'],
    [500, 'UPSTREAM_UNAVAILABLE'],
  ] as const)('maps status %s to safe %s without retrying', async (status, code) => {
    const credentials = tokenProvider();
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('upstream-secret account-secret', { status })),
    );
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    const error = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private prompt',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodexImageTransportError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('upstream-secret');
    expect(String(error)).not.toContain('account-secret');
    expect(String(error)).not.toContain('private prompt');
    expect(upstreamFetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
  });

  it.each([
    [CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false, undefined, 'AUTH_REQUIRED'],
    [CODEX_OAUTH_ERROR_CODES.SIGNED_OUT, false, undefined, 'AUTH_REQUIRED'],
    [CODEX_OAUTH_ERROR_CODES.INVALID_GRANT, false, undefined, 'AUTH_REQUIRED'],
    [CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED, false, 401, 'AUTH_REQUIRED'],
    [CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true, undefined, 'NETWORK_ERROR'],
    [CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR, true, 503, 'UPSTREAM_UNAVAILABLE'],
    [CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false, undefined, 'INVALID_RESPONSE'],
    [CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false, undefined, 'LOCAL_UNAVAILABLE'],
  ] as const)(
    'maps credential error %s to its safe image category',
    async (oauthCode, retryable, upstreamStatus, expectedCode) => {
      const credentials: CodexTokenProvider = {
        getValidCredentials: vi.fn(async () => {
          throw new CodexOAuthError(oauthCode, retryable, upstreamStatus);
        }),
      };
      const upstreamFetch = vi.fn<typeof fetch>();
      const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

      const caught = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
        prompt: 'private prompt',
      }).catch((error: unknown) => error);

      expect(caught).toMatchObject({ code: expectedCode });
      expect(String(caught)).not.toMatch(/authorization server|stored securely|private prompt/);
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it('maps only an explicit allowlisted 403 code to image entitlement unavailable', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: 'image_generation_not_available',
              message: 'private entitlement detail',
            },
          },
          { status: 403 },
        ),
      ),
    );
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch,
    });

    const caught = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private prompt',
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: 'IMAGE_ENTITLEMENT_UNAVAILABLE',
      source: 'upstream-http',
      upstreamStatus: 403,
    });
    expect(String(caught)).not.toMatch(/private entitlement detail|private prompt/);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-allowlisted structured 403 truthful as forbidden', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        Response.json(
          { error: { code: 'cloud_edge_forbidden', message: 'private edge detail' } },
          { status: 403 },
        ),
      ),
    );
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch,
    });

    const caught = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private prompt',
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: 'FORBIDDEN',
      source: 'upstream-http',
      upstreamStatus: 403,
    });
    expect(String(caught)).not.toMatch(/private edge detail|private prompt/);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['UPSTREAM_UNAVAILABLE', 503, 'upstream-http'],
    ['NETWORK_ERROR', undefined, 'network'],
    ['INVALID_RESPONSE', undefined, 'invalid-response'],
    ['TIMEOUT', undefined, 'timeout'],
  ] as const)('exposes only safe diagnostics for %s', (code, upstreamStatus, source) => {
    const caught = new CodexImageTransportError(code, upstreamStatus);

    expect(caught).toMatchObject({ code, source });
    expect(caught.upstreamStatus).toBe(upstreamStatus);
    expect(Object.keys(caught)).not.toContain('body');
  });

  it('classifies only the safe moderation code from a bounded 400 body', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 'moderation_blocked', message: 'secret unsafe detail' },
          }),
          { status: 400 },
        ),
      ),
    );
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch,
    });

    const error = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private prompt',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'MODERATION_BLOCKED' });
    expect(String(error)).not.toContain('secret unsafe detail');
  });

  it('maps other 400 responses to a safe request rejection', async () => {
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response('{"error":{"message":"private detail"}}', { status: 400 })),
      ),
    });

    const error = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private prompt',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'REQUEST_REJECTED', upstreamStatus: 400 });
    expect(String(error)).not.toContain('private detail');
  });

  it.each([
    { label: 'non-canonical base64', body: 'AAAA\n' },
    { label: 'non-png bytes', body: Buffer.from('not png').toString('base64') },
  ])('rejects $label as an invalid response', async ({ body }) => {
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ b64_json: body }] }), { status: 200 }),
        ),
      ),
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image', aspectRatio: '1:1' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    { label: 'zero-width', width: 0, height: 1024 },
    { label: 'edge above 8192', width: 8193, height: 1 },
    { label: 'more than 16,777,216 pixels', width: 4097, height: 4097 },
  ])('rejects a PNG with $label IHDR dimensions', async ({ width, height }) => {
    const onObservation = vi.fn();
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () => imageResponse(width, height)),
      onObservation,
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(onObservation).not.toHaveBeenCalled();
  });

  it.each([
    { data: [] },
    { data: [{ b64_json: pngBase64(1024, 1024) }, { b64_json: pngBase64(1024, 1024) }] },
  ])('requires exactly one image result', async ({ data }) => {
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 })),
      ),
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a declared success body above the 32 MiB budget', async () => {
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'content-length': String(32 * 1024 * 1024 + 1) },
          }),
        ),
      ),
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a streamed success body above the 32 MiB budget', async () => {
    const oversized = new Uint8Array(32 * 1024 * 1024 + 1);
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversized);
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects base64 that would decode above the 20 MiB image budget', async () => {
    const oversizedBase64 = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ b64_json: oversizedBase64 }] }), { status: 200 }),
        ),
      ),
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('bounds an error body without changing its safe HTTP classification', async () => {
    const oversized = new Uint8Array(16 * 1024 + 1);
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversized);
                controller.close();
              },
            }),
            { status: 403 },
          ),
        ),
      ),
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cancels and classifies a stalled non-400 error body without waiting for it', async () => {
    const cancel = vi.fn();
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Keep the body open: status alone is sufficient for a 403.
              },
              cancel,
            }),
            { status: 403 },
          ),
        ),
      ),
      timeoutMs: 25,
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('classifies a response-body connection reset as a network error without retrying', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              throw new Error('network-reset secret-body-detail');
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch,
    });

    const caught = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'private prompt',
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(caught)).not.toContain('network-reset');
    expect(String(caught)).not.toContain('private prompt');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('times out a fetch that never settles without retrying', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch,
      timeoutMs: 5,
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('times out and cancels a success body that never settles', async () => {
    const cancel = vi.fn();
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Keep the body open until the deadline cancels it.
            },
            cancel,
          }),
          { status: 200 },
        ),
      ),
    );
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch,
      timeoutMs: 5,
    });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('does not refresh or replay when a late 401 arrives after timeout', async () => {
    const pending = deferred<Response>();
    const credentials = tokenProvider();
    const upstreamFetch = vi.fn<typeof fetch>(() => pending.promise);
    const transport = createCodexImageTransport({
      tokenProvider: credentials,
      upstreamFetch,
      timeoutMs: 5,
    });

    const request = transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' });
    await expect(request).rejects.toMatchObject({ code: 'TIMEOUT' });
    pending.resolve(new Response('late 401', { status: 401 }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(credentials.refreshIfCurrent).not.toHaveBeenCalled();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('does not send after credential acquisition settles later than the deadline', async () => {
    const pendingCredentials = deferred<{ accessToken: string; accountId: string }>();
    const credentials = {
      getValidCredentials: vi
        .fn<CodexTokenProvider['getValidCredentials']>()
        .mockImplementationOnce(() => pendingCredentials.promise)
        .mockResolvedValue({ accessToken: 'late-token', accountId: 'late-account' }),
      refreshIfCurrent: vi.fn(async () => ({
        accessToken: 'late-token',
        accountId: 'late-account',
      })),
    };
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexImageTransport({
      tokenProvider: credentials,
      upstreamFetch,
      timeoutMs: 5,
    });

    const request = transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' });
    await expect(request).rejects.toMatchObject({ code: 'TIMEOUT' });
    pendingCredentials.resolve({ accessToken: 'late-token', accountId: 'late-account' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(credentials.refreshIfCurrent).not.toHaveBeenCalled();
  });

  it('does not send when credentials change between lease acquisition and send', async () => {
    const credentials = {
      getValidCredentials: vi
        .fn<CodexTokenProvider['getValidCredentials']>()
        .mockResolvedValueOnce({ accessToken: 'account-a-token', accountId: 'account-a' })
        .mockResolvedValue({ accessToken: 'account-b-token', accountId: 'account-b' }),
      refreshIfCurrent: vi.fn(async () => ({
        accessToken: 'account-a-token',
        accountId: 'account-a',
      })),
    };
    const upstreamFetch = vi.fn<typeof fetch>();
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'STALE_CREDENTIALS' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('does not replay a 401 when refresh resolves to a replacement account', async () => {
    const original = { accessToken: 'account-a-token', accountId: 'account-a' };
    const credentials = {
      getValidCredentials: vi.fn(async () => ({ ...original })),
      refreshIfCurrent: vi.fn(async () => ({
        accessToken: 'account-b-token',
        accountId: 'account-b',
      })),
    };
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('expired', { status: 401 })),
    );
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    await expect(
      transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' }),
    ).rejects.toMatchObject({ code: 'STALE_CREDENTIALS' });
    expect(credentials.refreshIfCurrent).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('does not replay when a credential refresh settles after parent abort', async () => {
    let current = { accessToken: 'old-token', accountId: 'account-id' };
    const pendingRefresh = deferred<{ accessToken: string; accountId: string }>();
    const credentials = {
      getValidCredentials: vi.fn(async () => ({ ...current })),
      refreshIfCurrent: vi.fn(async () => {
        const refreshed = await pendingRefresh.promise;
        current = refreshed;
        return { ...refreshed };
      }),
    };
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('expired', { status: 401 })),
    );
    const controller = new AbortController();
    const transport = createCodexImageTransport({
      tokenProvider: credentials,
      upstreamFetch,
      timeoutMs: 10_000,
    });

    const request = transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'image',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(credentials.refreshIfCurrent).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    pendingRefresh.resolve({ accessToken: 'new-token', accountId: 'account-id' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('honors a parent abort while the response body is stalled', async () => {
    const controller = new AbortController();
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Deliberately leave the body open until the request is aborted.
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const transport = createCodexImageTransport({
      tokenProvider: tokenProvider(),
      upstreamFetch,
      timeoutMs: 10_000,
    });

    const request = transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'image',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('discards a valid late image after the login credentials change', async () => {
    let current = { accessToken: 'account-a-token', accountId: 'account-a' };
    const credentials = {
      getValidCredentials: vi.fn(async () => ({ ...current })),
      refreshIfCurrent: vi.fn(async () => ({ ...current })),
    } satisfies CodexTokenProvider & {
      refreshIfCurrent(expected: {
        accessToken: string;
        accountId: string;
      }): Promise<{ accessToken: string; accountId: string }>;
    };
    const pending = deferred<Response>();
    const upstreamFetch = vi.fn<typeof fetch>(() => pending.promise);
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    const request = transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'image' });
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1));
    current = { accessToken: 'account-b-token', accountId: 'account-b' };
    pending.resolve(imageResponse());

    await expect(request).rejects.toMatchObject({ code: 'STALE_CREDENTIALS' });
  });

  it('discards a direct non-401 error after its body is classified under stale credentials', async () => {
    let current = { accessToken: 'account-a-token', accountId: 'account-a' };
    const credentials = {
      getValidCredentials: vi.fn(async () => ({ ...current })),
    } satisfies CodexTokenProvider;
    const bodyReadStarted = deferred<void>();
    const releaseBody = deferred<void>();
    const upstreamFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              bodyReadStarted.resolve(undefined);
              await releaseBody.promise;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    error: { code: 'cloud_edge_forbidden', message: 'private account detail' },
                  }),
                ),
              );
              controller.close();
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    const request = transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'private prompt' });
    await bodyReadStarted.promise;
    current = { accessToken: 'account-b-token', accountId: 'account-b' };
    releaseBody.resolve(undefined);

    const caught = await request.catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'STALE_CREDENTIALS' });
    expect(String(caught)).not.toMatch(/private account detail|private prompt/);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('discards the replayed non-401 error after its body is classified under stale credentials', async () => {
    let current = { accessToken: 'account-a-token', accountId: 'account-a' };
    const credentials = {
      getValidCredentials: vi.fn(async () => ({ ...current })),
      refreshIfCurrent: vi.fn(async () => {
        current = { accessToken: 'account-a-rotated-token', accountId: 'account-a' };
        return { ...current };
      }),
    } satisfies CodexTokenProvider & {
      refreshIfCurrent(expected: {
        accessToken: string;
        accountId: string;
      }): Promise<{ accessToken: string; accountId: string }>;
    };
    const bodyReadStarted = deferred<void>();
    const releaseBody = deferred<void>();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockImplementationOnce(async () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                bodyReadStarted.resolve(undefined);
                await releaseBody.promise;
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      error: {
                        code: 'moderation_blocked',
                        message: 'private old-account detail',
                      },
                    }),
                  ),
                );
                controller.close();
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    const transport = createCodexImageTransport({ tokenProvider: credentials, upstreamFetch });

    const request = transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, { prompt: 'private prompt' });
    await bodyReadStarted.promise;
    current = { accessToken: 'account-b-token', accountId: 'account-b' };
    releaseBody.resolve(undefined);

    const caught = await request.catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'STALE_CREDENTIALS' });
    expect(String(caught)).not.toMatch(/private old-account detail|private prompt/);
    expect(credentials.refreshIfCurrent).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });
});
