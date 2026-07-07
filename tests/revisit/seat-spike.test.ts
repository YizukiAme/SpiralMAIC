import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

import {
  REVISIT_SPIKE_STUDENT_AGENT_ID,
  parseRevisitSeatSpikeSse,
  summarizeRevisitSeatSpikeEvents,
  createRevisitSeatSpikeRequest,
} from '@/lib/revisit/seat-spike';
import { statelessGenerate } from '@/lib/orchestration/stateless-generate';
import type { StatelessEvent } from '@/lib/types/chat';

type DoStreamConfig = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']
>;
type StreamResult = Extract<DoStreamConfig, { stream: unknown }>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function textModel(text: string): MockLanguageModelV3 {
  const parts: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'p1' },
    { type: 'text-delta', id: 'p1', delta: text },
    { type: 'text-end', id: 'p1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
  ];

  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
  });
}

async function collect(events: AsyncGenerator<StatelessEvent>): Promise<StatelessEvent[]> {
  const collected: StatelessEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('revisit seat spike request', () => {
  it('routes a user teacher utterance to exactly one whiteboard student agent', () => {
    const request = createRevisitSeatSpikeRequest({
      teacherUtterance: 'Today I will explain the straw man fallacy.',
      model: 'openai:gpt-4o-mini',
      apiKey: 'test-key',
    });

    expect(request.config.agentIds).toEqual([REVISIT_SPIKE_STUDENT_AGENT_ID]);
    expect(request.config.agentConfigs).toHaveLength(1);
    expect(request.config.agentConfigs?.[0]).toMatchObject({
      id: REVISIT_SPIKE_STUDENT_AGENT_ID,
      role: 'student',
      allowedActions: [],
    });

    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({
      role: 'user',
      metadata: {
        originalRole: 'teacher',
        senderName: 'Teacher (User)',
      },
    });
    expect(request.messages[0].parts).toEqual([
      {
        type: 'text',
        text: 'Today I will explain the straw man fallacy.',
      },
    ]);

    expect(request.storeState).toMatchObject({
      stage: null,
      scenes: [],
      currentSceneId: null,
      mode: 'playback',
      whiteboardOpen: false,
    });
  });

  it('summarizes the streamed student turn as a successful seat wiring spike', () => {
    const result = summarizeRevisitSeatSpikeEvents([
      {
        type: 'thinking',
        data: { stage: 'agent_loading', agentId: REVISIT_SPIKE_STUDENT_AGENT_ID },
      },
      {
        type: 'agent_start',
        data: {
          messageId: 'assistant-1',
          agentId: REVISIT_SPIKE_STUDENT_AGENT_ID,
          agentName: 'AI Student',
        },
      },
      { type: 'text_delta', data: { messageId: 'assistant-1', content: 'Teacher, ' } },
      { type: 'text_delta', data: { messageId: 'assistant-1', content: 'I have a question.' } },
      {
        type: 'agent_end',
        data: { messageId: 'assistant-1', agentId: REVISIT_SPIKE_STUDENT_AGENT_ID },
      },
      {
        type: 'done',
        data: {
          totalActions: 0,
          totalAgents: 1,
          agentHadContent: true,
          directorState: {
            turnCount: 1,
            agentResponses: [],
            whiteboardLedger: [],
          },
        },
      },
    ]);

    expect(result).toEqual({
      dispatchedStudent: true,
      studentResponded: true,
      responseText: 'Teacher, I have a question.',
      cueUserReceived: false,
      errorMessage: null,
    });
  });

  it('parses stateless chat SSE data blocks while preserving incomplete input', () => {
    const parsed = parseRevisitSeatSpikeSse(
      [
        ':heartbeat',
        '',
        `data: ${JSON.stringify({
          type: 'text_delta',
          data: { messageId: 'assistant-1', content: 'hello' },
        })}`,
        '',
        'data: {"type":"done","data":{"totalActions":0,"totalAgents":1}}',
        '',
        'data: {"type":"text_delta"',
      ].join('\n'),
    );

    expect(parsed.events).toEqual([
      { type: 'text_delta', data: { messageId: 'assistant-1', content: 'hello' } },
      { type: 'done', data: { totalActions: 0, totalAgents: 1 } },
    ]);
    expect(parsed.remaining).toBe('data: {"type":"text_delta"');
  });

  it('runs the one-student director path with a mocked student response', async () => {
    const request = createRevisitSeatSpikeRequest({
      teacherUtterance: 'Today I will explain the straw man fallacy.',
      model: 'mock:model',
      apiKey: '',
    });

    const events = await collect(
      statelessGenerate(
        request,
        new AbortController().signal,
        textModel(
          '[{"type":"text","content":"Teacher, why is that not just disagreement?"}]',
        ) as never,
        { mode: 'disabled', enabled: false },
      ),
    );

    expect(events.map((event) => event.type)).toContain('agent_start');
    expect(events.map((event) => event.type)).toContain('text_delta');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      data: {
        totalAgents: 1,
        agentHadContent: true,
        directorState: {
          turnCount: 1,
        },
      },
    });

    expect(summarizeRevisitSeatSpikeEvents(events)).toMatchObject({
      dispatchedStudent: true,
      studentResponded: true,
      responseText: 'Teacher, why is that not just disagreement?',
      errorMessage: null,
    });
  });
});
