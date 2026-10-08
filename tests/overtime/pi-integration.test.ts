import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({ nativeChild: vi.fn(), buildAgent: vi.fn() }));
vi.mock('@/lib/agent/runtime/run-native-child', () => ({ runNativeChild: mocks.nativeChild }));
vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({ createCallLlmStreamFn: () => vi.fn() }));

import { buildChildActionTools } from '@/lib/chat/pi/tools/classroom-actions';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import {
  buildChildPrompt,
  buildDirectorPrompt,
  buildNativeChildPrompt,
} from '@/lib/chat/pi/prompts';

const teacher = {
  id: 'teacher-1',
  role: 'teacher',
  name: 'Teacher',
  persona: 'Explain clearly',
  allowedActions: ['spotlight', 'wb_open', 'wb_draw_text'],
  priority: 10,
  avatar: '',
  color: '#3366ff',
  isDefault: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
} satisfies AgentConfig;
const decision = { disposition: 'append_page', topic: 'Approach', teachingMove: 'extend' };
function body(): StatelessChatRequest {
  return {
    apiKey: '',
    messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Explain approach' }] }],
    storeState: {
      stage: { id: 'stage-1', name: 'Motion verbs', createdAt: 1, updatedAt: 1 },
      currentSceneId: '__pending__',
      mode: 'playback',
      whiteboardOpen: false,
      scenes: [
        {
          id: 'source-1',
          stageId: 'stage-1',
          title: 'Go and come',
          order: 0,
          type: 'quiz',
          content: { type: 'quiz', questions: [] },
        },
      ],
    },
    config: {
      agentIds: [teacher.id],
      overtimeContext: { stageId: 'stage-1', entry: 'course_complete', formal: true },
    },
  };
}

describe('Pi post-class overtime integration', () => {
  beforeEach(() => {
    mocks.nativeChild.mockReset();
    mocks.buildAgent.mockReset();
  });

  it('uses the completed course digest and durable-extension policy in both child runtimes', () => {
    const request = body();
    const director = buildDirectorPrompt(request, [teacher], 6);
    const legacy = buildChildPrompt(request, teacher, [], [], ['request_learning_extension']);
    const native = buildNativeChildPrompt(request, teacher, [], ['request_learning_extension']);
    for (const prompt of [director, legacy, native]) {
      expect(prompt).toContain('post-class');
      expect(prompt).toContain('Go and come');
      expect(prompt).toContain('request_learning_extension');
      expect(prompt).toContain('does not mean the page is ready');
    }
    expect(legacy).not.toContain('# Virtual Whiteboard');
  });

  it('offers only the extension action to a teaching agent and emits a request once', async () => {
    const send = vi.fn();
    const tools = buildChildActionTools({
      body: body(),
      agent: teacher,
      messageId: 'message-1',
      send,
      onActionDone: vi.fn(),
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
    });
    expect(tools.map((tool) => tool.name)).toEqual(['request_learning_extension']);
    await tools[0]!.execute('call-1', decision);
    await tools[0]!.execute('call-2', decision);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'action',
        data: expect.objectContaining({
          actionName: 'request_learning_extension',
          params: decision,
        }),
      }),
    );
  });

  it('does not expose extension generation outside a valid formal teaching context', () => {
    const request = body();
    request.config.overtimeContext = { ...request.config.overtimeContext!, stageId: 'foreign' };
    const options = {
      body: request,
      agent: teacher,
      messageId: 'message-1',
      send: vi.fn(),
      onActionDone: vi.fn(),
      maxActionsPerAgent: 8,
      enableWhiteboardTools: false,
    };
    expect(buildChildActionTools(options).map((tool) => tool.name)).not.toContain(
      'request_learning_extension',
    );
    options.body = body();
    options.agent = { ...teacher, role: 'student' };
    expect(buildChildActionTools(options).map((tool) => tool.name)).not.toContain(
      'request_learning_extension',
    );
  });

  it('passes the extension tool to Native children instead of slide or whiteboard tools', async () => {
    const events: StatelessEvent[] = [];
    mocks.nativeChild.mockImplementation(async (options) => {
      expect(options.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'request_learning_extension',
      ]);
      await options.tools[0].execute('extension-call', decision);
      await options.onVisibleTextDelta('The page is being prepared.');
      options.onDispatchedAction();
      return { status: 'completed', visibleOutput: 'The page is being prepared.' };
    });
    const tool = buildCallAgentTool({
      body: body(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
      childRuntimeMode: 'native',
    });
    await tool.execute('agent-call', {
      agentId: teacher.id,
      instruction: 'Explain approach briefly',
    });
    expect(
      events.some(
        (event) =>
          event.type === 'action' && event.data.actionName === 'request_learning_extension',
      ),
    ).toBe(true);
  });

  it('dispatches a structured Legacy extension action through the same validated tool', async () => {
    const events: StatelessEvent[] = [];
    const output = JSON.stringify([
      { type: 'text', content: 'Here is the explanation.' },
      { type: 'action', name: 'request_learning_extension', params: decision },
    ]);
    let subscriber: ((event: unknown) => unknown) | undefined;
    mocks.buildAgent.mockReturnValue({
      subscribe: (listener: (event: unknown) => unknown) => {
        subscriber = listener;
        return () => {};
      },
      prompt: async () => {},
      waitForIdle: async () => {
        await subscriber?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: output },
        });
      },
      state: { messages: [{ role: 'assistant', content: [{ type: 'text', text: output }] }] },
    });
    const tool = buildCallAgentTool({
      body: body(),
      agentConfigs: [teacher],
      send: async (event) => {
        events.push(event);
      },
      languageModel: {} as never,
      onAgentDone: vi.fn(),
      onActionDone: vi.fn(),
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 8,
      enableWhiteboardTools: true,
      childRuntimeMode: 'legacy',
    });
    await tool.execute('legacy-agent-call', {
      agentId: teacher.id,
      instruction: 'Explain briefly',
    });
    expect(events.filter((event) => event.type === 'action')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          actionName: 'request_learning_extension',
          params: decision,
        }),
      }),
    ]);
    expect(
      events.some(
        (event) => event.type === 'text_delta' && event.data.content.includes('explanation'),
      ),
    ).toBe(true);
  });
});
