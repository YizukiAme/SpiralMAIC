import { describe, expect, test } from 'vitest';

import {
  buildRevisitGateContext,
  buildRevisitProbeContext,
  createRevisitChatRequest,
  createAssistantRevisitMessage,
  createTeacherRevisitMessage,
  buildRevisitSceneStatuses,
  buildRevisitChatSession,
  canNavigateRevisitPage,
  getRevisitCueUserLabelKey,
  getRevisitStudentStatusEmoji,
  parseRevisitChatSse,
  REVISIT_ASSISTANT_AGENT_ID,
  REVISIT_DEFAULT_STUDENT_AGENT_IDS,
  REVISIT_PAGE_PROBE_CAP,
  REVISIT_STUDENT_AGENT_ID,
  resolveRevisitAgentIds,
  roleForRevisitAgent,
  type RevisitSessionPageState,
  reduceRevisitCueUserPrompt,
  selectPageProbes,
} from '@/lib/revisit/session';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const blueprint: RevisitExamBlueprint = {
  id: 'bp-1',
  stageId: 'stage-1',
  generatedAt: 1,
  language: 'zh-CN',
  sourceHash: 'hash',
  concepts: [
    {
      id: 'c1',
      label: 'Straw man',
      summary: 'Misrepresenting a claim before attacking it.',
      anchors: {
        clarity: ['define'],
        doubtResolution: ['distinguish'],
        transfer: ['spot examples'],
        errorCorrection: ['repair examples'],
      },
      probes: [
        {
          id: 'p1',
          conceptId: 'c1',
          pageIndex: 0,
          kind: 'confusion',
          prompt: 'What is weakened?',
        },
        {
          id: 'p2',
          conceptId: 'c1',
          pageIndex: 0,
          kind: 'transfer',
          prompt: 'Give a new example.',
        },
        {
          id: 'p3',
          conceptId: 'c1',
          pageIndex: 1,
          kind: 'correction',
          prompt: 'Fix this example.',
        },
      ],
    },
  ],
  skeleton: {
    pages: [
      {
        id: 'page-1',
        title: 'Define it',
        summary: 'Teach the definition.',
        conceptIds: ['c1'],
        cues: ['real claim', 'weaker claim'],
      },
    ],
  },
};

const pageState: RevisitSessionPageState = {
  pageIndex: 0,
  askedProbeIds: ['p1'],
  additionalProbeCount: 1,
  rescued: false,
  passed: false,
};

const stage: Stage = {
  id: 'stage-1',
  name: 'Fallacies',
  createdAt: 1,
  updatedAt: 1,
  languageDirective: 'zh-CN',
};

const scene: Scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  type: 'slide',
  title: 'Define it',
  order: 0,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: [],
        fontColor: '#111111',
        fontName: 'Arial',
      },
      elements: [],
    },
  },
};

describe('revisit session helpers', () => {
  test('selects probes for the active page only', () => {
    expect(selectPageProbes(blueprint, 0).map((probe) => probe.id)).toEqual(['p1', 'p2']);
  });

  test('probe context respects the per-page probe cap', () => {
    const context = buildRevisitProbeContext({ blueprint, pageState });
    expect(context).toContain('Remaining probe budget on this page: 1');
    expect(context).toContain('[p2]');
    expect(context).not.toContain('[p3]');
    expect(REVISIT_PAGE_PROBE_CAP).toBe(2);
  });

  test('gate context carries latest teacher turn and page counters', () => {
    const context = buildRevisitGateContext({
      blueprint,
      pageState,
      latestTeacherText: 'A straw man attacks a weaker version.',
      elapsedMinutes: 3.2,
    });
    expect(context).toContain('page_index: 0');
    expect(context).toContain('additional_probe_count: 1');
    expect(context).toContain('latest_teacher_turn: A straw man attacks');
  });

  test('chat request uses student and assistant seats with revisit contexts', () => {
    const message = createTeacherRevisitMessage('Let me teach it.', 10);
    const request = createRevisitChatRequest({
      stage,
      scenes: [scene],
      blueprint,
      messages: [message],
      pageState,
      latestTeacherText: message.text,
      elapsedMinutes: 1,
      model: 'openai:gpt-4.1-mini',
      apiKey: 'key',
    });
    expect(request.config.agentIds).toEqual([
      ...REVISIT_DEFAULT_STUDENT_AGENT_IDS,
      REVISIT_ASSISTANT_AGENT_ID,
    ]);
    expect(request.config.revisitProbeContext).toContain('Candidate probes');
    expect(request.config.revisitGateContext).toContain('latest_teacher_turn');
    expect(request.messages[0].metadata?.originalRole).toBe('teacher');
  });

  test('builds a non-persisted chat session for the revisit transcript surface', () => {
    const session = buildRevisitChatSession({
      id: 'session-1',
      title: 'Review challenge',
      messages: [
        createTeacherRevisitMessage('I will teach it.', 10),
        {
          id: 'student-1',
          role: 'student',
          text: 'Can you give an example?',
          agentId: 'agent-1',
          agentName: 'Student',
          agentAvatar: '/avatars/student.png',
          createdAt: 20,
        },
      ],
      status: 'active',
    });

    expect(session).toMatchObject({
      id: 'session-1',
      type: 'discussion',
      title: 'Review challenge',
      status: 'active',
      toolCalls: [],
      pendingToolCalls: [],
    });
    expect(session.messages[0]?.role).toBe('user');
    expect(session.messages[0]?.metadata?.originalRole).toBe('teacher');
    expect(session.messages[1]?.role).toBe('assistant');
    expect(session.messages[1]?.metadata?.agentId).toBe('agent-1');
    expect(session.messages[1]?.metadata?.senderAvatar).toBe('/avatars/student.png');
  });

  test('creates a themed assistant opening message for the resolved assistant seat', () => {
    const message = createAssistantRevisitMessage({
      text: '这场挑战会围绕「虚拟语气」展开，第一页是「什么是虚拟语气」。我会在旁边帮大家守住节奏。',
      agentId: 'custom-assistant',
      agentName: 'AI助教',
      agentAvatar: '/avatars/assistant.png',
      now: 30,
    });

    expect(message).toMatchObject({
      id: 'revisit-assistant-opening-30',
      role: 'assistant',
      agentId: 'custom-assistant',
      agentName: 'AI助教',
      agentAvatar: '/avatars/assistant.png',
      createdAt: 30,
    });
    expect(message.text).toContain('虚拟语气');
    expect(message.text).toContain('什么是虚拟语气');
  });

  test('chat request carries generated revisit agent configs to the stateless server', () => {
    const message = createTeacherRevisitMessage('Let me teach it.', 10);
    const request = createRevisitChatRequest({
      stage,
      scenes: [scene],
      blueprint,
      messages: [message],
      pageState,
      latestTeacherText: message.text,
      elapsedMinutes: 1,
      model: 'openai:gpt-4.1-mini',
      apiKey: 'key',
      agentIds: {
        studentAgentId: 'gen-student',
        studentAgentIds: ['gen-student'],
        assistantAgentId: 'gen-assistant',
      },
      agentConfigs: [
        {
          id: 'gen-student',
          name: 'Custom Student',
          role: 'student',
          persona: 'Curious',
          avatar: '/avatars/custom-student.png',
          color: '#22c55e',
          allowedActions: [],
          priority: 9,
          isGenerated: true,
        },
        {
          id: 'gen-assistant',
          name: 'Custom Assistant',
          role: 'assistant',
          persona: 'Helpful',
          avatar: '/avatars/custom-assistant.png',
          color: '#f59e0b',
          allowedActions: [],
          priority: 8,
          isGenerated: true,
        },
      ],
    });

    expect(request.config.agentIds).toEqual(['gen-student', 'gen-assistant']);
    expect(request.config.agentConfigs).toEqual([
      expect.objectContaining({ id: 'gen-student', role: 'student' }),
      expect.objectContaining({ id: 'gen-assistant', role: 'assistant' }),
    ]);
  });

  test('resolves revisit seats by role before falling back to defaults', () => {
    const resolved = resolveRevisitAgentIds([
      { id: 'custom-student-low', role: 'student', priority: 1 },
      { id: 'custom-student-mid', role: 'student', priority: 5 },
      { id: 'custom-student-high', role: 'student', priority: 9 },
      { id: 'custom-assistant', role: 'assistant', priority: 3 },
    ]);
    expect(resolved).toMatchObject({
      studentAgentId: 'custom-student-high',
      studentAgentIds: ['custom-student-high', 'custom-student-mid', 'custom-student-low'],
      assistantAgentId: 'custom-assistant',
    });

    expect(resolveRevisitAgentIds([])).toEqual({
      studentAgentId: REVISIT_STUDENT_AGENT_ID,
      studentAgentIds: REVISIT_DEFAULT_STUDENT_AGENT_IDS,
      assistantAgentId: REVISIT_ASSISTANT_AGENT_ID,
    });
  });

  test('classifies assistant turns using resolved revisit seats', () => {
    const agentIds = {
      studentAgentId: 'custom-student',
      studentAgentIds: ['custom-student'],
      assistantAgentId: 'custom-assistant',
    };
    const sse = [
      'data: {"type":"agent_start","data":{"messageId":"m1","agentId":"custom-assistant","agentName":"Assistant"}}',
      '',
      'data: {"type":"text_delta","data":{"messageId":"m1","content":"Try a simpler example."}}',
      '',
      '',
    ].join('\n');

    expect(roleForRevisitAgent('custom-assistant', agentIds)).toBe('assistant');
    expect(roleForRevisitAgent('custom-student', agentIds)).toBe('student');
    expect(parseRevisitChatSse(sse, agentIds).events.messages[0]?.role).toBe('assistant');
  });

  test('locks forward revisit navigation until the current page passes', () => {
    const states: RevisitSessionPageState[] = [
      { ...pageState, pageIndex: 0, passed: false },
      { ...pageState, pageIndex: 1, passed: false },
      { ...pageState, pageIndex: 2, passed: false },
    ];

    expect(canNavigateRevisitPage(states, 0, 1, false)).toBe(false);
    expect(canNavigateRevisitPage(states, 0, 0, false)).toBe(true);

    const unlocked = [{ ...states[0], passed: true }, states[1], states[2]];
    expect(canNavigateRevisitPage(unlocked, 0, 1, false)).toBe(true);
    expect(canNavigateRevisitPage(unlocked, 1, 2, false)).toBe(false);
    expect(canNavigateRevisitPage(unlocked, 1, 0, false)).toBe(true);
    expect(canNavigateRevisitPage(unlocked, 1, 2, true)).toBe(true);
  });

  test('maps revisit page state to classroom sidebar scene statuses', () => {
    const scenes = [{ id: 'scene-1' }, { id: 'scene-2' }, { id: 'scene-3' }];
    const states: RevisitSessionPageState[] = [
      { ...pageState, pageIndex: 0, passed: true },
      { ...pageState, pageIndex: 1, passed: false },
      { ...pageState, pageIndex: 2, passed: false },
    ];

    expect(buildRevisitSceneStatuses(scenes, states, 1, false)).toEqual({
      'scene-1': { passed: true, locked: false, current: false },
      'scene-2': { passed: false, locked: false, current: true },
      'scene-3': { passed: false, locked: true, current: false },
    });
    expect(buildRevisitSceneStatuses(scenes, states, 1, true)['scene-3']?.locked).toBe(false);
  });

  test('maps page progress to lightweight student status emoji', () => {
    expect(getRevisitStudentStatusEmoji({ ...pageState, additionalProbeCount: 0 }, false)).toBe(
      '🤔',
    );
    expect(getRevisitStudentStatusEmoji({ ...pageState, additionalProbeCount: 0 }, true)).toBe(
      '👂',
    );
    expect(getRevisitStudentStatusEmoji({ ...pageState, additionalProbeCount: 1 }, false)).toBe(
      '🤨',
    );
    expect(getRevisitStudentStatusEmoji({ ...pageState, passed: true }, false)).toBe('🤓');
    expect(getRevisitStudentStatusEmoji({ ...pageState, rescued: true }, false)).toBe('🤔');
  });

  test('uses the teach-this-page cue only when entering a revisit page', () => {
    expect(getRevisitCueUserLabelKey('teach-page')).toBe('revisit.challenge.teachThisPage');
    expect(getRevisitCueUserLabelKey('default')).toBeUndefined();
    expect(reduceRevisitCueUserPrompt('default', 'enter-page')).toBe('teach-page');
    expect(reduceRevisitCueUserPrompt('teach-page', 'teacher-submit')).toBe('default');
    expect(reduceRevisitCueUserPrompt('teach-page', 'agent-cued-user')).toBe('default');
  });

  test('parses revisit gate and streamed agent text from SSE', () => {
    const sse = [
      'data: {"type":"agent_start","data":{"messageId":"m1","agentId":"default-4","agentName":"Student"}}',
      '',
      'data: {"type":"text_delta","data":{"messageId":"m1","content":"Why weaker?"}}',
      '',
      'data: {"type":"revisit_gate","data":{"status":"probe","pageIndex":0,"reason":"missing example"}}',
      '',
      'data: {"type":"done","data":{"totalActions":0,"totalAgents":1,"directorState":{"turnCount":1,"agentResponses":[],"whiteboardLedger":[]}}}',
      '',
      '',
    ].join('\n');

    const parsed = parseRevisitChatSse(sse);
    expect(parsed.events.messages[0]?.text).toBe('Why weaker?');
    expect(parsed.events.gate?.status).toBe('probe');
    expect(parsed.events.directorState?.turnCount).toBe(1);
  });
});
