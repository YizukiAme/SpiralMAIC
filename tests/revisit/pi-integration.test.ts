import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { RevisitGateDecision } from '@/lib/revisit/types';

const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.stream }));
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
function stream(parts: Record<string, unknown>[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: Promise.resolve(usage),
  };
}
const agents: AgentConfig[] = (['student', 'assistant', 'teacher'] as const).map((role, index) => ({
  id: `${role}-1`,
  role,
  name: role,
  persona: 'Respond naturally.',
  avatar: '',
  color: '#2563eb',
  allowedActions: [],
  priority: index + 1,
  isDefault: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}));
const body: StatelessChatRequest = {
  apiKey: '',
  session: { kind: 'revisit-attempt', id: 'attempt-1' },
  messages: [
    {
      id: 'teacher-message',
      role: 'user',
      parts: [{ type: 'text', text: 'A predicate describes the subject.' }],
    },
  ],
  storeState: {
    stage: { id: 'course-1', name: 'Grammar', createdAt: 1, updatedAt: 1 },
    scenes: [],
    currentSceneId: null,
    mode: 'playback',
    whiteboardOpen: false,
  },
  config: {
    agentIds: agents.map((a) => a.id),
    revisitProbeContext: 'page-specific-fact: predicates describe subjects',
    revisitGateContext:
      'page_index: 0\nactive_student_ids: student-1\nlatest_teacher_turn: A predicate describes the subject.',
  },
};
function gate(status: RevisitGateDecision['status']): RevisitGateDecision {
  return {
    status,
    pageIndex: 0,
    reason: 'Current-page assessment',
    studentStates: { 'student-1': status === 'pass' ? 'satisfied' : 'questioning' },
  };
}
function makeTool(request = body, childRuntimeMode: 'legacy' | 'native' = 'legacy') {
  const events: StatelessEvent[] = [];
  const summaries: unknown[] = [];
  const tool = buildCallAgentTool({
    body: request,
    agentConfigs: agents,
    send: async (event) => {
      events.push(event);
    },
    languageModel: {} as never,
    onAgentDone: (summary) => {
      summaries.push(summary);
    },
    onActionDone: () => {},
    thinkingConfig: { mode: 'disabled', enabled: false },
    abortSignal: new AbortController().signal,
    maxAgentTurns: 1,
    getAgentTurnCount: () => summaries.length,
    getAgentResponses: () => [],
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: 0,
    enableWhiteboardTools: false,
    childRuntimeMode,
  });
  return { tool, events };
}

describe('Revisit on the shared Pi runtime', () => {
  beforeEach(() => {
    mocks.stream.mockReset();
    mocks.stream.mockImplementation((_request, source) =>
      stream([
        {
          type: 'text-delta',
          text:
            source === 'pi-chat-native-child'
              ? 'I understand this page.'
              : '[{"type":"text","content":"I understand this page."}]',
        },
        { type: 'finish', finishReason: 'stop', totalUsage: usage },
      ]),
    );
  });

  it.each(['legacy', 'native'] as const)(
    '%s child preserves each gate and the listener-side actor',
    async (runtime) => {
      for (const status of ['pass', 'probe', 'fail', 'rescue'] as const) {
        const { tool, events } = makeTool(body, runtime);
        await tool.execute('teach-back', {
          agentId: 'teacher-1',
          instruction: 'React to the current page.',
          revisitGate: gate(status),
        });
        expect(events.find((e) => e.type === 'agent_start')).toMatchObject({
          data: { agentId: status === 'rescue' ? 'assistant-1' : 'student-1' },
        });
        expect(events.filter((e) => e.type === 'revisit_gate')).toEqual([
          { type: 'revisit_gate', data: gate(status) },
        ]);
        expect(
          events.some((e) => e.type === 'text_delta' && e.data.content.includes('understand')),
        ).toBe(true);
        const childRequest = mocks.stream.mock.calls.at(-1)?.[0];
        expect(childRequest.system).toContain('page-specific-fact');
        expect(childRequest.system).toContain(
          status === 'pass' ? 'ACKNOWLEDGE' : status === 'rescue' ? 'RESCUE' : 'PROBE',
        );
        await tool.execute('duplicate-child', {
          agentId: 'student-1',
          instruction: 'Again',
          revisitGate: gate(status),
        });
        expect(events.filter((e) => e.type === 'agent_start')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'revisit_gate')).toHaveLength(1);
      }
    },
  );

  it('uses assistant rescue when the gate is omitted and the probe cap is exhausted', async () => {
    const { tool, events } = makeTool({
      ...body,
      config: { ...body.config, revisitFallbackDirective: 'rescue' },
    });
    await tool.execute('missing-gate', {
      agentId: 'student-1',
      instruction: 'Help the human teacher.',
    });
    expect(events.find((e) => e.type === 'agent_start')).toMatchObject({
      data: { agentId: 'assistant-1' },
    });
    expect(events.some((e) => e.type === 'revisit_gate')).toBe(false);
    expect(mocks.stream.mock.calls.at(-1)?.[0].system).toContain('RESCUE');
  });

  it.each(['legacy', 'native'] as const)(
    '%s child never commits a gate after provider failure or an empty reply',
    async (runtime) => {
      for (const failure of ['error', 'empty', 'partial-error'] as const) {
        mocks.stream.mockImplementation(() =>
          stream([
            ...(failure === 'partial-error' ? [{ type: 'text-delta', text: 'I understand' }] : []),
            ...(failure === 'empty'
              ? [{ type: 'finish', finishReason: 'stop', totalUsage: usage }]
              : [{ type: 'error', error: new Error('Listener provider unavailable') }]),
          ]),
        );
        const { tool, events } = makeTool(body, runtime);
        const result = await tool.execute('failed-listener', {
          agentId: 'student-1',
          instruction: 'Acknowledge the current page.',
          revisitGate: gate('pass'),
        });
        expect(
          events.filter((event) => event.type === 'revisit_gate'),
          failure,
        ).toEqual([]);
        expect(
          events.some((event) => event.type === 'error'),
          failure,
        ).toBe(true);
        expect(result, failure).toMatchObject({ isError: true });
      }
    },
  );

  it('does not apply Revisit routing or gates to ordinary classroom chat', async () => {
    const { tool, events } = makeTool({ ...body, config: { agentIds: agents.map((a) => a.id) } });
    await tool.execute('ordinary-chat', {
      agentId: 'teacher-1',
      instruction: 'Explain the concept.',
      revisitGate: gate('pass'),
    });
    expect(events.find((e) => e.type === 'agent_start')).toMatchObject({
      data: { agentId: 'teacher-1' },
    });
    expect(events.some((e) => e.type === 'revisit_gate')).toBe(false);
  });

  it.each(['legacy', 'native'] as const)(
    '%s failed listener stops the director without another inference or a successful done',
    async (runtime) => {
      let directorCalls = 0;
      mocks.stream.mockImplementation((_request, source) => {
        if (source !== 'pi-chat-director')
          return stream([{ type: 'error', error: new Error('Listener provider unavailable') }]);
        directorCalls += 1;
        return directorCalls === 1
          ? stream([
              {
                type: 'tool-call',
                toolCallId: 'failed-delegation',
                toolName: 'call_agent',
                input: { agentId: 'student-1', instruction: 'Respond.', revisitGate: gate('pass') },
              },
              { type: 'finish', finishReason: 'tool-calls', totalUsage: usage },
            ])
          : stream([{ type: 'finish', finishReason: 'stop', totalUsage: usage }]);
      });
      const events: StatelessEvent[] = [];
      const controller = new AbortController();
      await runPiDirectorLoop({
        body,
        agentConfigs: agents,
        send: async (event) => {
          events.push(event);
        },
        languageModel: {} as never,
        thinkingConfig: { mode: 'disabled', enabled: false },
        abortSignal: controller.signal,
        signal: controller.signal,
        maxAgentTurns: 6,
        maxActionsPerAgent: 0,
        enableWhiteboardTools: false,
        childRuntimeMode: runtime,
      });
      expect(directorCalls).toBe(1);
      expect(events.some((event) => event.type === 'error')).toBe(true);
      expect(
        events.filter((event) => ['revisit_gate', 'cue_user', 'done'].includes(event.type)),
      ).toEqual([]);
    },
  );

  it('rejects a Revisit turn when the director stops without a listener', async () => {
    mocks.stream.mockImplementation(() =>
      stream([{ type: 'finish', finishReason: 'stop', totalUsage: usage }]),
    );
    const controller = new AbortController();
    const events: StatelessEvent[] = [];
    await expect(
      runPiDirectorLoop({
        body,
        agentConfigs: agents,
        send: async (event) => {
          events.push(event);
        },
        languageModel: {} as never,
        thinkingConfig: { mode: 'disabled', enabled: false },
        abortSignal: controller.signal,
        signal: controller.signal,
        maxAgentTurns: 6,
        maxActionsPerAgent: 0,
        enableWhiteboardTools: false,
      }),
    ).rejects.toThrow(/listener.*retry/i);
    expect(
      events.filter((event) => ['revisit_gate', 'cue_user', 'done'].includes(event.type)),
    ).toEqual([]);
  });

  it('hands the turn back after one listener response even if the director keeps delegating', async () => {
    let directorCalls = 0;
    mocks.stream.mockImplementation((_request, source) => {
      if (source !== 'pi-chat-director')
        return stream([
          { type: 'text-delta', text: '[{"type":"text","content":"I understand this page."}]' },
          { type: 'finish', finishReason: 'stop', totalUsage: usage },
        ]);
      directorCalls += 1;
      return directorCalls <= 2
        ? stream([
            {
              type: 'tool-call',
              toolCallId: `delegate-${directorCalls}`,
              toolName: 'call_agent',
              input: {
                agentId: 'student-1',
                instruction: 'Respond briefly.',
                revisitGate: gate('pass'),
              },
            },
            { type: 'finish', finishReason: 'tool-calls', totalUsage: usage },
          ])
        : stream([{ type: 'finish', finishReason: 'stop', totalUsage: usage }]);
    });
    const events: StatelessEvent[] = [];
    const controller = new AbortController();
    await runPiDirectorLoop({
      body,
      agentConfigs: agents,
      send: async (e) => {
        events.push(e);
      },
      languageModel: {} as never,
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: controller.signal,
      signal: controller.signal,
      maxAgentTurns: 6,
      maxActionsPerAgent: 0,
      enableWhiteboardTools: false,
    });
    expect(events.filter((e) => e.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'cue_user')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      data: { totalAgents: 1, cueUserReceived: true },
    });
    expect(directorCalls).toBe(1);
  });
});
