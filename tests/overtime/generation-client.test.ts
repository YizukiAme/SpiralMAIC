import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
  capabilities: vi.fn(),
  modelConfig: vi.fn(),
  selection: vi.fn(),
}));
vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.modelConfig,
  buildModelRequestHeaders: (config: { serviceTier?: string }) =>
    config.serviceTier ? { 'x-service-tier': config.serviceTier } : {},
}));
vi.mock('@/lib/audio/narration-tts', () => ({ generateAndStoreTTS: mocks.synthesize }));
vi.mock('@/lib/model-settings/capabilities', () => ({
  loadModelCapabilities: mocks.capabilities,
}));
vi.mock('@/lib/audio/tts-selection', () => ({
  ttsSelection: mocks.selection,
}));

import {
  fetchSceneActions,
  fetchSceneContent,
  generateTTSForScene,
} from '@/lib/overtime/generation-client';

const outline = { id: 'page-1', type: 'slide', title: 'More', order: 1 } as SceneOutline;
const retry = { maxRetries: 1, sleep: async () => undefined, random: () => 0 };

describe('overtime generation client', () => {
  beforeEach(() => {
    mocks.synthesize.mockReset();
    mocks.capabilities.mockResolvedValue({});
    mocks.modelConfig.mockReturnValue({});
    mocks.selection.mockReturnValue({ providerId: 'openai-tts' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retries transient content failures through the owner-scoped adapter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'rate limited' }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ success: true, content: { elements: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSceneContent(
      { outline, allOutlines: [outline], stageId: 'stage-1', stageInfo: { name: 'Course' } },
      undefined,
      retry,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/overtime/scene-content',
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('preserves a permission refusal without retrying or losing its status', async () => {
    const fetchMock = vi.fn(async () => new Response('Not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchSceneActions(
      { outline, allOutlines: [outline], stageId: 'foreign', content: { elements: [] } },
      undefined,
      retry,
    );
    expect(result).toMatchObject({ success: false, statusCode: 404 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('forwards only the non-secret Codex tier preference with the request', async () => {
    mocks.modelConfig.mockReturnValue({ serviceTier: 'priority', apiKey: 'must-stay-local' });
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, content: { elements: [] } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchSceneContent({
      outline,
      allOutlines: [outline],
      stageId: 'stage-1',
      stageInfo: { name: 'Course' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/overtime/scene-content',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', 'x-service-tier': 'priority' },
      }),
    );
  });

  it('propagates cancellation instead of turning it into a retryable result', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchSceneContent(
        { outline, allOutlines: [outline], stageId: 'stage-1', stageInfo: { name: 'Course' } },
        controller.signal,
        retry,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses the new narration client and does not regenerate a checkpointed clip', async () => {
    mocks.synthesize.mockResolvedValue('asset-new');
    const scene = {
      id: 'page-1',
      stageId: 'stage-1',
      order: 1,
      actions: [
        { id: 'speech-1', type: 'speech', text: 'First', audioId: 'asset-existing' },
        { id: 'speech-2', type: 'speech', text: 'Second' },
      ],
    } as Scene;
    await expect(generateTTSForScene(scene, 'English')).resolves.toEqual({
      success: true,
      failedCount: 0,
    });
    expect(mocks.synthesize).toHaveBeenCalledOnce();
    expect(mocks.synthesize).toHaveBeenCalledWith(
      'tts_s1_speech-2',
      'Second',
      'English',
      undefined,
      undefined,
      'stage-1',
    );
    expect(scene.actions?.[1]).toMatchObject({ audioId: 'asset-new' });
  });

  it('preserves paid narration even when the selected provider would now split its text', async () => {
    mocks.selection.mockReturnValue({ providerId: 'glm-tts' });
    const scene = {
      id: 'page-1',
      stageId: 'stage-1',
      order: 1,
      actions: [{ id: 'paid-long', type: 'speech', text: 'A'.repeat(2050), audioId: 'asset-paid' }],
    } as Scene;
    await expect(generateTTSForScene(scene)).resolves.toMatchObject({ success: true });
    expect(scene.actions).toHaveLength(1);
    expect(scene.actions?.[0]).toMatchObject({ id: 'paid-long', audioId: 'asset-paid' });
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
