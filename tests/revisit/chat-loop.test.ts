import { describe, expect, test, vi } from 'vitest';

import { runRevisitAgentLoop } from '@/lib/revisit/chat-loop';
import type { RevisitAgentIds } from '@/lib/revisit/session';
import type { StatelessChatRequest } from '@/lib/types/chat';

const agentIds: RevisitAgentIds = {
  studentAgentId: 'student-1',
  studentAgentIds: ['student-1'],
  assistantAgentId: 'assistant-1',
};

const request: StatelessChatRequest = {
  messages: [],
  storeState: {
    stage: { id: 'stage-1', name: 'Demo', createdAt: 1, updatedAt: 1 },
    scenes: [
      {
        id: 'skeleton-1',
        stageId: 'stage-1',
        type: 'slide',
        title: 'Skeleton',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'c1',
            viewportSize: 1000,
            viewportRatio: 16 / 9,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#2563eb'],
              fontColor: '#111827',
              fontName: 'Inter',
            },
            elements: [],
          },
        },
      },
    ],
    currentSceneId: 'skeleton-1',
    mode: 'playback',
    whiteboardOpen: false,
  },
  config: {
    agentIds: ['student-1', 'assistant-1'],
    sessionType: 'discussion',
    revisitProbeContext: 'probe',
    revisitGateContext: 'gate',
  },
  apiKey: 'key',
  model: 'model',
};

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

describe('runRevisitAgentLoop', () => {
  test('applies gate after the student response drains and then cues the teacher', async () => {
    const fetchChat = vi.fn().mockResolvedValueOnce(
      sse([
        {
          type: 'revisit_gate',
          data: { status: 'pass', pageIndex: 0, reason: 'covered' },
        },
        {
          type: 'agent_start',
          data: { messageId: 'm1', agentId: 'student-1', agentName: 'Student' },
        },
        { type: 'text_delta', data: { messageId: 'm1', content: '懂了。' } },
        { type: 'agent_end', data: { messageId: 'm1', agentId: 'student-1' } },
        {
          type: 'done',
          data: {
            totalActions: 0,
            totalAgents: 1,
            agentHadContent: true,
            directorState: { turnCount: 1, agentResponses: [], whiteboardLedger: [] },
          },
        },
      ]),
    );

    const applied: string[] = [];
    const textByMessageId = new Map<string, string>();

    const result = await runRevisitAgentLoop({
      request,
      agentIds,
      fetchChat,
      bufferOptions: { tickMs: 1, charsPerTick: 100, postTextDelayMs: 0 },
      callbacks: {
        onAgentMessageStart: (message) => {
          applied.push(`start:${message.id}:${message.role}`);
          textByMessageId.set(message.id, '');
        },
        onAgentMessageText: (messageId, text) => {
          applied.push(`text:${text}`);
          textByMessageId.set(messageId, text);
        },
        onGate: (gate) => applied.push(`gate:${gate.status}`),
      },
    });

    expect(fetchChat).toHaveBeenCalledTimes(1);
    expect(textByMessageId.get('m1')).toBe('懂了。');
    expect(applied).toEqual(['start:m1:student', 'text:懂了。', 'gate:pass']);
    expect(result.outcome.reason).toBe('cue_user');
    expect(result.gate?.status).toBe('pass');
  });

  test('surfaces stream errors instead of completing silently', async () => {
    const fetchChat = vi.fn().mockResolvedValueOnce(
      sse([
        { type: 'error', data: { message: 'insufficient balance' } },
        {
          type: 'done',
          data: { totalActions: 0, totalAgents: 0, agentHadContent: false },
        },
      ]),
    );

    await expect(
      runRevisitAgentLoop({
        request,
        agentIds,
        fetchChat,
        bufferOptions: { tickMs: 1, charsPerTick: 100, postTextDelayMs: 0 },
        callbacks: {},
      }),
    ).rejects.toThrow(/insufficient balance/);
  });

  test('forwards the selected service tier in every shared chat-loop request body', async () => {
    const fetchChat = vi.fn().mockResolvedValueOnce(
      sse([
        {
          type: 'done',
          data: { totalActions: 0, totalAgents: 0, agentHadContent: false },
        },
      ]),
    );

    await runRevisitAgentLoop({
      request: { ...request, serviceTier: 'priority' },
      agentIds,
      fetchChat,
      callbacks: {},
    });

    expect(fetchChat.mock.calls[0]?.[0]).toMatchObject({ serviceTier: 'priority' });
  });

  test('forces a cue back to the teacher after one agent turn in one revisit round', async () => {
    const fetchChat = vi.fn().mockResolvedValueOnce(
      sse([
        {
          type: 'agent_start',
          data: { messageId: 'm1', agentId: 'student-1', agentName: 'Student' },
        },
        { type: 'text_delta', data: { messageId: 'm1', content: '我理解这一页了。' } },
        { type: 'agent_end', data: { messageId: 'm1', agentId: 'student-1' } },
        {
          type: 'done',
          data: {
            totalActions: 0,
            totalAgents: 1,
            agentHadContent: true,
            directorState: { turnCount: 1, agentResponses: [], whiteboardLedger: [] },
          },
        },
      ]),
    );

    const cues: string[] = [];
    const roles: string[] = [];
    const result = await runRevisitAgentLoop({
      request,
      agentIds,
      fetchChat,
      bufferOptions: { tickMs: 1, charsPerTick: 100, postTextDelayMs: 0 },
      callbacks: {
        onAgentMessageStart: (message) => roles.push(message.role),
        onCueUser: () => cues.push('cue'),
      },
    });

    expect(fetchChat).toHaveBeenCalledTimes(1);
    expect(cues).toEqual(['cue']);
    expect(roles).toEqual(['student']);
    expect(result.outcome.reason).toBe('cue_user');
  });

  test('forwards the page director state on the first shared-loop request', async () => {
    const initialDirectorState = {
      turnCount: 4,
      agentResponses: [],
      whiteboardLedger: [],
    };
    const requestBodies: Record<string, unknown>[] = [];
    const fetchChat = vi.fn(async (body: Record<string, unknown>) => {
      requestBodies.push(body);
      return sse([
        {
          type: 'done',
          data: {
            totalActions: 0,
            totalAgents: 0,
            agentHadContent: false,
            directorState: initialDirectorState,
          },
        },
      ]);
    });

    await runRevisitAgentLoop({
      request: { ...request, directorState: initialDirectorState },
      agentIds,
      fetchChat,
      bufferOptions: { tickMs: 1, charsPerTick: 100, postTextDelayMs: 0 },
      callbacks: {},
    });

    expect(requestBodies[0]?.directorState).toEqual(initialDirectorState);
  });

  test('cues the teacher immediately after a student asks a question', async () => {
    const fetchChat = vi.fn().mockResolvedValueOnce(
      sse([
        {
          type: 'agent_start',
          data: { messageId: 'm1', agentId: 'student-1', agentName: 'Student' },
        },
        { type: 'text_delta', data: { messageId: 'm1', content: '老师，这里为什么不是主语？' } },
        { type: 'agent_end', data: { messageId: 'm1', agentId: 'student-1' } },
        {
          type: 'done',
          data: {
            totalActions: 0,
            totalAgents: 1,
            agentHadContent: true,
            directorState: { turnCount: 1, agentResponses: [], whiteboardLedger: [] },
          },
        },
      ]),
    );

    const cues: string[] = [];
    const result = await runRevisitAgentLoop({
      request,
      agentIds,
      fetchChat,
      bufferOptions: { tickMs: 1, charsPerTick: 100, postTextDelayMs: 0 },
      callbacks: {
        onCueUser: () => cues.push('cue'),
      },
    });

    expect(fetchChat).toHaveBeenCalledTimes(1);
    expect(cues).toEqual(['cue']);
    expect(result.outcome.reason).toBe('cue_user');
  });
});
