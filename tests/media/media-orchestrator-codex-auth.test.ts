import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mediaStore = {
    getTask: vi.fn(() => undefined),
    enqueueTasks: vi.fn(),
    markGenerating: vi.fn(),
    markFailed: vi.fn(),
    markDone: vi.fn(),
    markPendingForRetry: vi.fn(),
  };
  const settingsState = {
    imageProviderId: 'codex-image',
    imageModelId: 'gpt-image-2',
    imageGenerationEnabled: true,
    videoGenerationEnabled: false,
    imageProvidersConfig: {
      'codex-image': { apiKey: '', baseUrl: '', enabled: true, isServerConfigured: true },
    },
    videoProvidersConfig: {},
    fetchServerProviders: vi.fn(
      async (_options?: { reconcileOAuthImageSelectionImmediately?: boolean }): Promise<void> => {},
    ),
  };
  return {
    mediaStore,
    settingsState,
    mediaFilesPut: vi.fn(async (_record: unknown) => undefined),
    mediaFilesDelete: vi.fn(async () => undefined),
    logError: vi.fn(),
  };
});

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => mocks.settingsState },
}));

vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: { getState: () => mocks.mediaStore },
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    mediaFiles: {
      put: mocks.mediaFilesPut,
      delete: mocks.mediaFilesDelete,
    },
  },
  mediaFileKey: (stageId: string, elementId: string) => `${stageId}:${elementId}`,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
    debug: vi.fn(),
  }),
}));

import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import type { SceneOutline } from '@/lib/types/generation';

function imageOutline(...elementIds: string[]): SceneOutline[] {
  return [
    {
      mediaGenerations: elementIds.map((elementId) => ({
        type: 'image' as const,
        elementId,
        prompt: `illustration ${elementId}`,
        aspectRatio: '16:9' as const,
      })),
    } as SceneOutline,
  ];
}

describe('media orchestrator Codex auth invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsState.imageProviderId = 'codex-image';
    mocks.settingsState.imageModelId = 'gpt-image-2';
    mocks.settingsState.imageGenerationEnabled = true;
    mocks.settingsState.fetchServerProviders.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('persists a mocked Codex API image as a page-ready Blob without a network or quota call', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const base64 = Buffer.from(imageBytes).toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/generate/image') {
        return Response.json({
          success: true,
          result: { base64, width: 1254, height: 1254 },
        });
      }
      if (String(input) === dataUrl) {
        return new Response(new Blob([imageBytes], { type: 'image/png' }));
      }
      throw new Error(`unexpected mocked media request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:codex-image-page-ready');

    await generateMediaForOutlines(imageOutline('image-1'), 'stage-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/generate/image',
      dataUrl,
    ]);
    expect(mocks.mediaFilesPut).toHaveBeenCalledOnce();
    const record = mocks.mediaFilesPut.mock.calls[0]?.[0] as {
      id: string;
      type: string;
      blob: Blob;
      mimeType: string;
      size: number;
    };
    expect(record).toMatchObject({
      id: 'stage-1:image-1',
      type: 'image',
      mimeType: 'image/png',
      size: imageBytes.byteLength,
    });
    expect(record.blob).toBeInstanceOf(Blob);
    expect(record.blob.size).toBeGreaterThan(0);
    expect(createObjectURL).toHaveBeenCalledWith(record.blob);
    expect(mocks.mediaStore.markDone).toHaveBeenCalledWith(
      'image-1',
      'blob:codex-image-page-ready',
      undefined,
    );
    expect(mocks.mediaStore.markFailed).not.toHaveBeenCalled();
  });

  it('triggers a fail-closed provider sync for a selected Codex 401', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'Reconnect Codex', errorCode: 'INVALID_CREDENTIALS' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateMediaForOutlines(imageOutline('image-1'), 'stage-1');

    expect(mocks.settingsState.fetchServerProviders).toHaveBeenCalledWith({
      reconcileOAuthImageSelectionImmediately: true,
    });
  });

  it.each([
    [503, 'PROVIDER_DISABLED', 'Codex credentials are temporarily unavailable'],
    [502, 'UPSTREAM_ERROR', 'Codex image generation returned an invalid response'],
  ] as const)(
    'does not resync Codex credentials for a safe %s %s failure',
    async (status, errorCode, error) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error, errorCode }), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );

      await generateMediaForOutlines(imageOutline('image-1'), 'stage-1');

      expect(mocks.settingsState.fetchServerProviders).not.toHaveBeenCalled();
      expect(mocks.mediaStore.markFailed).toHaveBeenCalledWith('image-1', error, errorCode);
    },
  );

  it('does not post later queued images after Codex invalidation leaves no provider', async () => {
    let releaseSync!: () => void;
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    mocks.settingsState.fetchServerProviders.mockImplementationOnce(() => {
      mocks.settingsState.imageProviderId = '';
      mocks.settingsState.imageModelId = '';
      mocks.settingsState.imageGenerationEnabled = false;
      return pendingSync;
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'Reconnect Codex', errorCode: 'INVALID_CREDENTIALS' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateMediaForOutlines(imageOutline('image-1', 'image-2'), 'stage-1');

    expect(mocks.settingsState).toMatchObject({
      imageProviderId: '',
      imageModelId: '',
      imageGenerationEnabled: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseSync();
  });

  it('logs validated Codex failure diagnostics without changing or persisting the safe error', async () => {
    const userMessage = 'Codex image generation is temporarily unavailable';
    const responseBodyMarker = 'private-response-body-detail';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: userMessage,
            errorCode: 'UPSTREAM_ERROR',
            details: responseBodyMarker,
          }),
          {
            status: 502,
            headers: {
              'content-type': 'application/json',
              'x-openmaic-codex-image-error-source': 'upstream-http',
              'x-openmaic-codex-image-upstream-status': '503',
            },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateMediaForOutlines(imageOutline('image-1'), 'stage-1');

    expect(mocks.logError).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith('Failed image-1:', userMessage, {
      diagnosticSource: 'upstream-http',
      upstreamStatus: 503,
    });
    expect(mocks.mediaStore.markFailed).toHaveBeenCalledWith(
      'image-1',
      userMessage,
      'UPSTREAM_ERROR',
    );
    expect(mocks.mediaFilesPut).toHaveBeenCalledOnce();
    expect(mocks.mediaFilesPut.mock.calls[0]?.[0]).toMatchObject({
      error: userMessage,
      errorCode: 'UPSTREAM_ERROR',
    });
    expect(mocks.mediaFilesPut.mock.calls[0]?.[0]).not.toHaveProperty('diagnosticSource');
    expect(mocks.mediaFilesPut.mock.calls[0]?.[0]).not.toHaveProperty('upstreamStatus');
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toMatch(
      new RegExp(`illustration image-1|${responseBodyMarker}`),
    );
  });

  it.each([
    ['upstream-http', '099', { diagnosticSource: 'upstream-http' }],
    ['upstream-http', '600', { diagnosticSource: 'upstream-http' }],
    ['upstream-http', '50x-private-status', { diagnosticSource: 'upstream-http' }],
    ['upstream-http', '0503', { diagnosticSource: 'upstream-http' }],
    ['network', '503', { diagnosticSource: 'network' }],
    ['private-spoofed-source', '503', undefined],
  ] as const)(
    'ignores unsafe Codex diagnostic headers source=%s status=%s',
    async (source, upstreamStatus, expectedDiagnostics) => {
      const userMessage = 'Codex image generation failed safely';
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: userMessage, errorCode: 'UPSTREAM_ERROR' }), {
              status: 502,
              headers: {
                'content-type': 'application/json',
                'x-openmaic-codex-image-error-source': source,
                'x-openmaic-codex-image-upstream-status': upstreamStatus,
              },
            }),
        ),
      );

      await generateMediaForOutlines(imageOutline('image-1'), 'stage-1');

      if (expectedDiagnostics) {
        expect(mocks.logError).toHaveBeenCalledWith(
          'Failed image-1:',
          userMessage,
          expectedDiagnostics,
        );
      } else {
        expect(mocks.logError).toHaveBeenCalledWith('Failed image-1:', userMessage);
      }
      const serializedLogs = JSON.stringify(mocks.logError.mock.calls);
      if (source === 'private-spoofed-source') {
        expect(serializedLogs).not.toContain(source);
      }
      expect(serializedLogs).not.toContain(upstreamStatus);
    },
  );
});
