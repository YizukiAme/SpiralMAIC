import { describe, expect, it, vi } from 'vitest';

import {
  runAgentLoop,
  type AgentLoopCallbacks,
  type AgentLoopIterationResult,
} from '@/lib/chat/agent-loop';

function emptySse(): Response {
  return new Response('');
}

describe('runAgentLoop logical sessions', () => {
  it('sends the same logical session on every iteration of one chat loop', async () => {
    const fetchChat = vi.fn<AgentLoopCallbacks['fetchChat']>(async () => emptySse());
    const iterations: AgentLoopIterationResult[] = [
      {
        totalAgents: 1,
        agentHadContent: true,
        cueUserReceived: false,
        directorState: { turnCount: 1, agentResponses: [], whiteboardLedger: [] },
      },
      {
        totalAgents: 0,
        agentHadContent: false,
        cueUserReceived: false,
        directorState: { turnCount: 2, agentResponses: [], whiteboardLedger: [] },
      },
    ];

    await runAgentLoop(
      {
        config: { agentIds: ['agent-1'] },
        apiKey: 'key',
        session: { kind: 'chat', id: 'persisted-chat-session-1' },
      },
      {
        getStoreState: () => ({
          stage: null,
          scenes: [],
          currentSceneId: null,
          mode: 'playback',
          whiteboardOpen: false,
        }),
        getMessages: () => [],
        fetchChat,
        onEvent: () => undefined,
        onIterationEnd: async () => iterations.shift() ?? null,
      },
      new AbortController().signal,
    );

    expect(fetchChat).toHaveBeenCalledTimes(2);
    expect(fetchChat.mock.calls.map(([body]) => body.session)).toEqual([
      { kind: 'chat', id: 'persisted-chat-session-1' },
      { kind: 'chat', id: 'persisted-chat-session-1' },
    ]);
  });
});
