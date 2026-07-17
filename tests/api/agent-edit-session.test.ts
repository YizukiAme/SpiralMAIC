import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aiCall: undefined as
    | ((stage: string, system: string, prompt: string, signal?: AbortSignal) => Promise<string>)
    | undefined,
  buildAgent: vi.fn(),
  buildToolset: vi.fn(),
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({ isMaicEditorEnabled: () => true }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({ createCallLlmStreamFn: () => vi.fn() }));
vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildSystemPrompt: () => 'system prompt',
  buildAgent: mocks.buildAgent,
}));
vi.mock('@/lib/agent/tools/registry', () => ({ buildToolset: mocks.buildToolset }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));

import { POST } from '@/app/api/agent/edit/route';

describe('/api/agent/edit Codex logical session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aiCall = undefined;
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: { modelId: 'gpt-5.4' },
      modelInfo: {},
      thinkingConfig: undefined,
      modelString: 'openai-codex:gpt-5.4',
    });
    mocks.callLLM.mockResolvedValue({ text: 'generated' });
    mocks.buildToolset.mockImplementation((options) => {
      mocks.aiCall = options.aiCall;
      return {};
    });
    mocks.buildAgent.mockImplementation(() => ({
      subscribe: () => () => undefined,
      prompt: async () => {
        await mocks.aiCall?.('scene-content:slide', 'tool system', 'tool prompt');
      },
      waitForIdle: async () => undefined,
      abort: () => undefined,
    }));
  });

  it('uses one persisted editor session for the main model and stage tool models', async () => {
    const request = new Request('http://localhost/api/agent/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'editor-session-1',
        message: 'Regenerate this slide',
        scene: { id: 'scene-1', title: 'Intro' },
        history: [],
        sceneContextMap: {},
      }),
    });

    const response = await POST(request as NextRequest);
    await response.text();

    const logicalSession = { kind: 'agent-edit', id: 'editor-session-1' };
    expect(mocks.resolveModelFromRequest).toHaveBeenNthCalledWith(
      1,
      request,
      expect.any(Object),
      'maic-agent',
      logicalSession,
    );
    expect(mocks.resolveModelFromRequest).toHaveBeenNthCalledWith(
      2,
      request,
      expect.any(Object),
      'scene-content:slide',
      logicalSession,
    );
  });
});
