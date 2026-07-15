import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  statelessGenerate: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/orchestration/stateless-generate', () => ({
  statelessGenerate: mocks.statelessGenerate,
}));
vi.mock('@/lib/ai/providers', () => ({ isProviderKeyRequired: () => false }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/route';

function requestBody(session?: unknown) {
  return {
    ...(session === undefined ? {} : { session }),
    messages: [],
    storeState: {
      stage: null,
      scenes: [],
      currentSceneId: null,
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: { agentIds: ['agent-1'] },
    model: 'openai-codex:gpt-5.4',
    apiKey: '',
  };
}

async function post(body: unknown): Promise<Response> {
  const response = await POST(
    new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  await response.text();
  return response;
}

describe('/api/chat Codex logical sessions', () => {
  beforeEach(() => {
    mocks.resolveModel.mockReset().mockResolvedValue({
      model: { modelId: 'gpt-5.4' },
      apiKey: '',
      providerId: 'openai-codex',
      thinkingConfig: undefined,
    });
    mocks.statelessGenerate.mockReset().mockImplementation(async function* () {});
  });

  it('passes a valid external chat context into model resolution', async () => {
    const response = await post(requestBody({ kind: 'chat', id: 'persisted-chat-1' }));

    expect(response.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalSession: { kind: 'chat', id: 'persisted-chat-1' },
      }),
    );
  });

  it('replaces invalid external context with one ephemeral resolution identity', async () => {
    const response = await post(requestBody({ kind: 'agent-edit', id: 'must-not-cross-boundary' }));

    expect(response.status).toBe(200);
    const options = mocks.resolveModel.mock.calls[0]?.[0];
    expect(options.logicalSession).toMatchObject({ kind: 'chat' });
    expect(options.logicalSession.id).not.toBe('must-not-cross-boundary');
  });
});
