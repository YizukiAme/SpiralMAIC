import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  runPiDirectorLoop: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/chat/pi/director-loop', () => ({
  runPiDirectorLoop: mocks.runPiDirectorLoop,
}));
vi.mock('@/lib/server/model-config/runtime', () => ({ requestWorkspaceId: async () => null }));
vi.mock('@/lib/server/web-search-config', () => ({
  resolveClassroomWebSearchConfig: async () => undefined,
}));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: () => false,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/pi/route';

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
    config: {
      agentIds: ['agent-1'],
      agentConfigs: [
        {
          id: 'agent-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'Teach.',
          avatar: '',
          color: '#2563eb',
          allowedActions: [],
          priority: 1,
        },
      ],
    },
    model: 'openai-codex:gpt-5.4',
    apiKey: '',
  };
}

async function post(body: unknown): Promise<Response> {
  const response = await POST(
    new NextRequest('http://localhost/api/chat/pi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  await response.text();
  return response;
}

describe('/api/chat/pi Codex logical sessions', () => {
  beforeEach(() => {
    mocks.resolveModel.mockReset().mockResolvedValue({
      model: { modelId: 'gpt-5.4' },
      apiKey: '',
      providerId: 'openai-codex',
      thinkingConfig: undefined,
    });
    mocks.runPiDirectorLoop.mockReset().mockImplementation(async ({ send }) => {
      await send({ type: 'done', data: { totalAgents: 0, totalActions: 0 } });
    });
  });

  it.each(['chat', 'revisit-attempt'])(
    'passes a valid external %s context into model resolution',
    async (kind) => {
      const response = await post(requestBody({ kind, id: 'persisted-chat-1' }));

      expect(response.status).toBe(200);
      expect(mocks.resolveModel).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalSession: { kind, id: 'persisted-chat-1' },
        }),
      );
    },
  );

  it('replaces invalid external context with one ephemeral resolution identity', async () => {
    const response = await post(requestBody({ kind: 'agent-edit', id: 'must-not-cross-boundary' }));

    expect(response.status).toBe(200);
    const options = mocks.resolveModel.mock.calls[0]?.[0];
    expect(options.logicalSession).toMatchObject({ kind: 'chat' });
    expect(options.logicalSession.id).not.toBe('must-not-cross-boundary');
  });
});
