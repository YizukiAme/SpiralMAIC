import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  transport: vi.fn(),
  createTransport: vi.fn(),
  generic: vi.fn(),
  usage: vi.fn(),
}));
vi.mock('@/lib/server/codex/availability', () => ({ getCodexOAuthAvailability: mocks.available }));
vi.mock('@/lib/server/codex/runtime', () => ({
  getCodexAuthRuntime: () => ({ tokenProvider: 'native-token-provider' }),
}));
vi.mock('@/lib/server/codex/image-transport', async (original) => ({
  ...(await original<typeof import('@/lib/server/codex/image-transport')>()),
  createCodexImageTransport: mocks.createTransport,
}));
vi.mock('@/lib/media/image-providers', () => ({
  generateImage: mocks.generic,
  IMAGE_PROVIDERS: {},
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: mocks.usage }));

import { generateImageStep } from '@/lib/server/generation/steps/image';
import {
  CODEX_IMAGE_GENERATIONS_ENDPOINT,
  CODEX_IMAGE_MODEL,
} from '@/lib/server/codex/image-transport';
import type { MediaConnection } from '@/lib/server/model-config/media';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const connection: MediaConnection = {
  providerId: 'codex-image',
  modelId: CODEX_IMAGE_MODEL,
  managed: false,
  origin: 'configuration',
  userEndpoint: false,
};

describe('shared Codex image generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.available.mockResolvedValue({ available: true });
    mocks.createTransport.mockReturnValue(mocks.transport);
    mocks.transport.mockResolvedValue({ success: true, imageUrl: 'data:image/png;base64,AA==' });
  });

  it('uses native OAuth transport in background steps, ignoring legacy caller credentials', async () => {
    const signal = new AbortController().signal;
    const result = await generateImageStep(
      {
        connection: { ...connection, apiKey: 'untrusted', baseUrl: 'https://untrusted.test' },
        options: { prompt: 'A diagram', aspectRatio: '16:9' },
      },
      { log, signal },
    );
    expect(result).toEqual({ success: true, imageUrl: 'data:image/png;base64,AA==' });
    expect(mocks.transport).toHaveBeenCalledWith(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: 'A diagram',
      aspectRatio: '16:9',
      signal,
    });
    expect(mocks.generic).not.toHaveBeenCalled();
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith({
      kind: 'image',
      unit: 'image',
      providerId: 'codex-image',
      modelId: 'gpt-image-2',
      quantity: 1,
    });
  });

  it('refuses a custom model before contacting the native backend', async () => {
    await expect(
      generateImageStep(
        {
          connection: { ...connection, modelId: 'injected-model' },
          options: { prompt: 'x' },
        },
        { log },
      ),
    ).rejects.toMatchObject({ reason: 'missing-model' });
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('reports disconnected OAuth as a safe local availability failure', async () => {
    mocks.available.mockResolvedValue({ available: false });
    await expect(
      generateImageStep({ connection, options: { prompt: 'x' } }, { log }),
    ).rejects.toMatchObject({ code: 'LOCAL_UNAVAILABLE' });
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('does not carry unexpected transport response details into a background run failure', async () => {
    mocks.transport.mockRejectedValue(new Error('private upstream body and course prompt'));
    let failure: unknown;
    try {
      await generateImageStep({ connection, options: { prompt: 'x' } }, { log });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/private|upstream body|course prompt/);
    expect(mocks.usage).not.toHaveBeenCalled();
  });
});
