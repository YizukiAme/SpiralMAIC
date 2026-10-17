import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRevisitAgentLoop } from '@/lib/revisit/chat-loop';
import type { StatelessChatRequest } from '@/lib/types/chat';

const request: StatelessChatRequest = {
  session: { kind: 'revisit-attempt', id: 'attempt-1' },
  apiKey: 'browser-test-key',
  model: 'openai:test-model',
  baseUrl: 'https://example.test/v1',
  serviceTier: 'priority',
  messages: [],
  storeState: {
    stage: { id: 'course-1', name: 'Teach back', createdAt: 1, updatedAt: 1 },
    scenes: [],
    currentSceneId: null,
    mode: 'playback',
    whiteboardOpen: false,
  },
  config: { agentIds: ['student-1'], revisitGateContext: 'page_index: 0' },
};
const agentIds = {
  studentAgentId: 'student-1',
  studentAgentIds: ['student-1'],
  assistantAgentId: 'assistant-1',
};
function finishedResponse() {
  return new Response(
    'data: {"type":"done","data":{"totalActions":0,"totalAgents":0,"agentHadContent":false}}\n\n',
  );
}

describe('Revisit Pi transport migration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends teach-back to the surviving Pi endpoint, not the retired chat route', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      finishedResponse(),
    );
    vi.stubGlobal('fetch', fetch);
    await runRevisitAgentLoop({ request, agentIds, callbacks: {} });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/chat/pi');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves model credentials, Fast mode and the attempt while refreshing the snapshot', async () => {
    const bodies: Record<string, unknown>[] = [];
    await runRevisitAgentLoop({
      request,
      agentIds,
      getStoreState: () => ({ ...request.storeState, currentSceneId: 'fresh-page' }),
      fetchChat: async (body) => {
        bodies.push(body);
        return finishedResponse();
      },
      callbacks: {},
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      apiKey: 'browser-test-key',
      model: 'openai:test-model',
      baseUrl: 'https://example.test/v1',
      serviceTier: 'priority',
      session: { kind: 'revisit-attempt', id: 'attempt-1' },
      storeState: { currentSceneId: 'fresh-page' },
    });
  });

  it('does not upload a turn already cancelled before reading the current snapshot', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchChat = vi.fn(async () => finishedResponse());
    const result = await runRevisitAgentLoop({
      request,
      agentIds,
      fetchChat,
      signal: controller.signal,
      callbacks: {},
    });
    expect(fetchChat).not.toHaveBeenCalled();
    expect(result.outcome.reason).toBe('aborted');
  });

  it('does not apply a pending gate when the listener stream reports failure', async () => {
    const onGate = vi.fn();
    await expect(
      runRevisitAgentLoop({
        request,
        agentIds,
        fetchChat: async () =>
          new Response(
            [
              {
                type: 'revisit_gate',
                data: { status: 'pass', pageIndex: 0, reason: 'Assessment' },
              },
              { type: 'error', data: { message: 'Listener failed. Please retry.' } },
              { type: 'done', data: { totalActions: 0, totalAgents: 1, agentHadContent: false } },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
          ),
        callbacks: { onGate },
      }),
    ).rejects.toThrow('Listener failed');
    expect(onGate).not.toHaveBeenCalled();
  });
});
