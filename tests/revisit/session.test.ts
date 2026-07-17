import { describe, expect, test } from 'vitest';

import {
  buildRevisitGateContext,
  buildRevisitOpeningContext,
  buildRevisitProbeContext,
  createRevisitChatRequest,
  createAssistantRevisitMessage,
  createTeacherRevisitMessage,
  applyRevisitGateToPageState,
  applyRevisitGateToPageStates,
  buildRevisitSceneStatuses,
  buildRevisitChatSession,
  canNavigateRevisitPage,
  compactRevisitDirectorState,
  getRevisitCueUserLabelKey,
  getLastUnlockedRevisitPageIndex,
  getRevisitParticipantStatusBadge,
  isRevisitStudentQuestion,
  REVISIT_PAGE_PROBE_CAP,
  reduceRevisitOpeningPlayback,
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

const defaultRevisitAgentIds = {
  studentAgentId: 'spiral-student-1',
  studentAgentIds: ['spiral-student-1', 'spiral-student-2'],
  assistantAgentId: 'spiral-assistant',
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

describe('Reverse Challenge assistant opening context', () => {
  test('uses the model-authored whole-course brief when the blueprint provides one', () => {
    const context = buildRevisitOpeningContext({
      blueprint: {
        ...blueprint,
        openingBrief: '  本课从辨认真实主张出发，进一步理解主张如何在稻草人谬误中被歪曲。  ',
      },
      sourceScenes: [scene],
      locale: 'zh-CN',
    });

    expect(context.brief).toBe('本课从辨认真实主张出发，进一步理解主张如何在稻草人谬误中被歪曲。');
  });

  test('builds an ordered topic path from source pages for older blueprints', () => {
    const context = buildRevisitOpeningContext({
      blueprint,
      sourceScenes: [
        { ...scene, id: 'object', order: 2, title: '什么是宾语' },
        { ...scene, id: 'subject', order: 0, title: '什么是主语' },
        { ...scene, id: 'predicate', order: 1, title: '什么是谓语' },
      ],
      locale: 'zh-CN',
    });

    expect(context.brief).toBeNull();
    expect(context.topics.indexOf('什么是主语')).toBeLessThan(context.topics.indexOf('什么是谓语'));
    expect(context.topics.indexOf('什么是谓语')).toBeLessThan(context.topics.indexOf('什么是宾语'));
  });
});

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
      attemptId: 'attempt-1',
      stage,
      scenes: [scene],
      blueprint,
      messages: [message],
      pageState,
      latestTeacherText: message.text,
      elapsedMinutes: 1,
      model: 'openai:gpt-4.1-mini',
      apiKey: 'key',
      agentIds: defaultRevisitAgentIds,
    });
    expect(request.config.agentIds).toEqual([
      ...defaultRevisitAgentIds.studentAgentIds,
      defaultRevisitAgentIds.assistantAgentId,
    ]);
    expect(request.session).toEqual({ kind: 'revisit-attempt', id: 'attempt-1' });
    expect(request.config.revisitProbeContext).toContain('Candidate probes');
    expect(request.config.revisitGateContext).toContain('latest_teacher_turn');
    expect(request.config.revisitFallbackDirective).toBe('probe');
    expect(request.messages[0].metadata?.originalRole).toBe('teacher');
  });

  test('chat request falls back to rescue after the page probe budget is exhausted', () => {
    const request = createRevisitChatRequest({
      attemptId: 'attempt-1',
      stage,
      scenes: [scene],
      blueprint,
      messages: [createTeacherRevisitMessage('Let me try again.', 10)],
      pageState: { ...pageState, additionalProbeCount: REVISIT_PAGE_PROBE_CAP },
      latestTeacherText: 'Let me try again.',
      elapsedMinutes: 1,
      model: 'openai:gpt-4.1-mini',
      apiKey: 'key',
      agentIds: defaultRevisitAgentIds,
    });

    expect(request.config.revisitFallbackDirective).toBe('rescue');
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
      text: '上一堂课从语气的作用讲到虚拟语气的表达方式。这次会沿着这条脉络回顾和应用，先从「什么是虚拟语气」开始。',
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
      attemptId: 'attempt-1',
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

  test('resolves revisit seats from roster order without default fallbacks', () => {
    const resolved = resolveRevisitAgentIds([
      { id: 'custom-student-low', role: 'student', priority: 1 },
      { id: 'custom-student-mid', role: 'student', priority: 5 },
      { id: 'custom-student-high', role: 'student', priority: 9 },
      { id: 'custom-assistant', role: 'assistant', priority: 3 },
    ]);
    expect(resolved).toMatchObject({
      studentAgentId: 'custom-student-low',
      studentAgentIds: ['custom-student-low', 'custom-student-mid', 'custom-student-high'],
      assistantAgentId: 'custom-assistant',
    });

    expect(resolveRevisitAgentIds([])).toBeNull();
    expect(
      resolveRevisitAgentIds([
        { id: 'default-4', role: 'student' },
        { id: 'default-2', role: 'assistant' },
      ]),
    ).toBeNull();
  });

  test('classifies agent roles using resolved revisit seats', () => {
    const agentIds = {
      studentAgentId: 'custom-student',
      studentAgentIds: ['custom-student'],
      assistantAgentId: 'custom-assistant',
    };
    expect(roleForRevisitAgent('custom-assistant', agentIds)).toBe('assistant');
    expect(roleForRevisitAgent('custom-student', agentIds)).toBe('student');
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

  test('allows opening a failed page without unlocking other future pages', () => {
    const states: RevisitSessionPageState[] = [
      { ...pageState, pageIndex: 0, passed: false },
      { ...pageState, pageIndex: 1, passed: false },
      { ...pageState, pageIndex: 2, passed: false },
    ];

    expect(canNavigateRevisitPage(states, 0, 1, false, 2)).toBe(false);
    expect(canNavigateRevisitPage(states, 0, 2, false, 2)).toBe(true);
  });

  test('finds the last generated page unlocked by the pass chain', () => {
    const states: RevisitSessionPageState[] = [
      { ...pageState, pageIndex: 0, passed: true },
      { ...pageState, pageIndex: 1, passed: false },
      { ...pageState, pageIndex: 2, passed: false },
    ];

    expect(getLastUnlockedRevisitPageIndex(states, [{}, {}, undefined], false)).toBe(1);
    expect(getLastUnlockedRevisitPageIndex(states, [{}, undefined, undefined], false)).toBe(0);
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

  test('keeps displayed states when a pass gate is incomplete but does not unlock the page', () => {
    const incomplete = applyRevisitGateToPageState({
      pageState: {
        ...pageState,
        studentStates: {
          'student-1': 'uncertain',
          'student-2': 'satisfied',
        },
      },
      gate: {
        status: 'pass',
        pageIndex: 0,
        reason: 'covered enough',
        studentStates: { 'student-1': 'satisfied' },
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
    });

    expect(incomplete.passed).toBe(false);
    expect(incomplete.studentStates).toEqual({
      'student-1': 'satisfied',
      'student-2': 'satisfied',
    });
  });

  test('applies pass only when every active student is satisfied', () => {
    const complete = applyRevisitGateToPageState({
      pageState,
      gate: {
        status: 'pass',
        pageIndex: 0,
        reason: 'everyone accepted it',
        studentStates: {
          'student-1': 'satisfied',
          'student-2': 'satisfied',
        },
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
    });

    expect(complete.passed).toBe(true);
  });

  test('clears the responding student question after a complete pass and acknowledgment', () => {
    const next = applyRevisitGateToPageState({
      pageState: {
        ...pageState,
        askedProbeIds: ['p1'],
        additionalProbeCount: 1,
        studentStates: {
          'student-1': 'questioning',
          'student-2': 'satisfied',
        },
      },
      gate: {
        status: 'pass',
        pageIndex: 0,
        reason: 'the answer resolved the question',
        studentStates: {
          'student-1': 'questioning',
          'student-2': 'satisfied',
        },
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
      studentMessagesSinceTeacherTurn: [
        {
          id: 'm-ack',
          role: 'student',
          agentId: 'student-1',
          text: '明白了，sep 只影响参数之间的分隔。',
          createdAt: 20,
        },
      ],
      fallbackNextProbeId: 'p2',
    });

    expect(next.studentStates).toEqual({
      'student-1': 'satisfied',
      'student-2': 'satisfied',
    });
    expect(next.passed).toBe(true);
    expect(next.additionalProbeCount).toBe(1);
    expect(next.askedProbeIds).toEqual(['p1']);
  });

  test('a stale questioning state blocks pass without consuming another probe', () => {
    const next = applyRevisitGateToPageState({
      pageState: {
        ...pageState,
        askedProbeIds: ['p1'],
        additionalProbeCount: 1,
        studentStates: {
          'student-1': 'questioning',
          'student-2': 'satisfied',
        },
      },
      gate: {
        status: 'pass',
        pageIndex: 0,
        reason: 'covered enough',
        studentStates: {
          'student-1': 'questioning',
          'student-2': 'satisfied',
        },
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
      fallbackNextProbeId: 'p2',
    });

    expect(next.passed).toBe(false);
    expect(next.additionalProbeCount).toBe(1);
    expect(next.askedProbeIds).toEqual(['p1']);
  });

  test('student questions locally block a pass decision and consume a probe turn', () => {
    const next = applyRevisitGateToPageState({
      pageState: { ...pageState, askedProbeIds: [], additionalProbeCount: 0 },
      gate: {
        status: 'pass',
        pageIndex: 0,
        reason: 'covered enough',
        studentStates: {
          'student-1': 'satisfied',
          'student-2': 'satisfied',
        },
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
      studentMessagesSinceTeacherTurn: [
        {
          id: 'm1',
          role: 'student',
          agentId: 'student-2',
          text: '老师，apples 算主语吗？',
          createdAt: 20,
        },
      ],
      fallbackNextProbeId: 'p2',
    });

    expect(next.passed).toBe(false);
    expect(next.additionalProbeCount).toBe(1);
    expect(next.askedProbeIds).toEqual(['p2']);
    expect(next.studentStates).toMatchObject({ 'student-2': 'questioning' });
  });

  test('successive gates merge into the latest page state in one teacher turn', () => {
    const initial = [{ ...pageState, askedProbeIds: [], additionalProbeCount: 0 }];
    const first = applyRevisitGateToPageStates({
      pageStates: initial,
      pageIndex: 0,
      gate: { status: 'probe', pageIndex: 0, reason: 'ask once' },
      activeStudentAgentIds: ['student-1'],
      candidateProbeIds: ['p1', 'p2'],
    });
    const second = applyRevisitGateToPageStates({
      pageStates: first,
      pageIndex: 0,
      gate: { status: 'probe', pageIndex: 0, reason: 'ask again' },
      activeStudentAgentIds: ['student-1'],
      candidateProbeIds: ['p1', 'p2'],
    });

    expect(second[0]).toMatchObject({
      additionalProbeCount: 2,
      askedProbeIds: ['p1', 'p2'],
    });
  });

  test('an incomplete probe still consumes exactly one probe turn', () => {
    const next = applyRevisitGateToPageState({
      pageState: {
        ...pageState,
        askedProbeIds: [],
        additionalProbeCount: 0,
        studentStates: { 'student-2': 'satisfied' },
      },
      gate: {
        status: 'probe',
        pageIndex: 0,
        reason: 'ask once',
        studentStates: { 'student-1': 'questioning' },
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
      studentMessagesSinceTeacherTurn: [
        {
          id: 'm-probe',
          role: 'student',
          agentId: 'student-1',
          text: 'sep 可以使用换行符吗？',
          createdAt: 20,
        },
      ],
      fallbackNextProbeId: 'p1',
    });

    expect(next.additionalProbeCount).toBe(1);
    expect(next.askedProbeIds).toEqual(['p1']);
    expect(next.studentStates).toEqual({
      'student-1': 'questioning',
      'student-2': 'satisfied',
    });
  });

  test('a fail gate consumes one probe turn even when the state table is incomplete', () => {
    const next = applyRevisitGateToPageState({
      pageState: { ...pageState, askedProbeIds: [], additionalProbeCount: 0 },
      gate: {
        status: 'fail',
        pageIndex: 0,
        reason: 'the explanation needs one focused retry',
        studentStates: { 'student-1': 'uncertain' },
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
      fallbackNextProbeId: 'p1',
    });

    expect(next.additionalProbeCount).toBe(1);
    expect(next.askedProbeIds).toEqual(['p1']);
    expect(next.passed).toBe(false);
  });

  test('rescue marks the page as rescued without consuming another probe turn', () => {
    const next = applyRevisitGateToPageState({
      pageState: {
        ...pageState,
        askedProbeIds: ['p1', 'p2'],
        additionalProbeCount: REVISIT_PAGE_PROBE_CAP,
      },
      gate: {
        status: 'rescue',
        pageIndex: 0,
        reason: 'the probe budget is exhausted',
      },
      activeStudentAgentIds: ['student-1', 'student-2'],
      fallbackNextProbeId: 'p3',
    });

    expect(next.rescued).toBe(true);
    expect(next.passed).toBe(false);
    expect(next.additionalProbeCount).toBe(REVISIT_PAGE_PROBE_CAP);
    expect(next.askedProbeIds).toEqual(['p1', 'p2']);
  });

  test('filters unknown student ids from the visible state map', () => {
    const next = applyRevisitGateToPageState({
      pageState,
      gate: {
        status: 'pass',
        pageIndex: 0,
        reason: 'covered',
        studentStates: {
          'student-1': 'satisfied',
          'unknown-student': 'satisfied',
        },
      },
      activeStudentAgentIds: ['student-1'],
    });

    expect(next.studentStates).toEqual({ 'student-1': 'satisfied' });
    expect(next.passed).toBe(true);
  });

  test('compacts revisit director state without resetting its total turn count', () => {
    const compacted = compactRevisitDirectorState({
      turnCount: 9,
      agentResponses: Array.from({ length: 9 }, (_, index) => ({
        agentId: `student-${index}`,
        agentName: `Student ${index}`,
        contentPreview: `response-${index}`,
        actionCount: 0,
        whiteboardActions: [],
      })),
      whiteboardLedger: Array.from({ length: 30 }, (_, index) => ({
        actionName: 'wb_clear' as const,
        agentId: `student-${index}`,
        agentName: `Student ${index}`,
        params: {},
      })),
    });

    expect(compacted.turnCount).toBe(9);
    expect(compacted.agentResponses).toHaveLength(6);
    expect(compacted.agentResponses[0]?.contentPreview).toBe('response-3');
    expect(compacted.whiteboardLedger).toHaveLength(24);
    expect(compacted.whiteboardLedger[0]?.agentId).toBe('student-6');
  });

  test('detects direct student questions without treating acknowledgements as questions', () => {
    expect(isRevisitStudentQuestion('老师，为什么这里不是 apples？')).toBe(true);
    expect(isRevisitStudentQuestion('我还是不明白。')).toBe(true);
    expect(isRevisitStudentQuestion('这个我还不会。')).toBe(true);
    expect(isRevisitStudentQuestion("I still don't understand.")).toBe(true);
    expect(isRevisitStudentQuestion('I am still confused.')).toBe(true);
    expect(isRevisitStudentQuestion("I don't know.")).toBe(true);
    expect(isRevisitStudentQuestion("This still doesn't make sense.")).toBe(true);
    expect(isRevisitStudentQuestion('懂了，我会把 Cats 当成主语。')).toBe(false);
    expect(isRevisitStudentQuestion('我现在明白什么是主语了。')).toBe(false);
    expect(isRevisitStudentQuestion('我知道为什么这里用主语了。')).toBe(false);
    expect(isRevisitStudentQuestion('I understand it now.')).toBe(false);
  });

  test('maps per-student revisit state to lightweight status badges', () => {
    expect(
      getRevisitParticipantStatusBadge({
        pageState,
        agentId: 'student-1',
        teacherSpeaking: true,
      }),
    ).toMatchObject({ emoji: '👂', labelKey: 'revisit.challenge.studentStatus.listening' });

    expect(
      getRevisitParticipantStatusBadge({
        pageState,
        agentId: 'student-1',
        awaitingStudentStatusUpdate: true,
      }),
    ).toMatchObject({ emoji: '🤔', labelKey: 'revisit.challenge.studentStatus.thinking' });

    expect(
      getRevisitParticipantStatusBadge({
        pageState: {
          ...pageState,
          studentStates: {
            'student-1': 'questioning',
            'student-2': 'satisfied',
            'student-3': 'uncertain',
          },
        },
        agentId: 'student-1',
      }),
    ).toMatchObject({ emoji: '❓', labelKey: 'revisit.challenge.studentStatus.questioning' });

    expect(
      getRevisitParticipantStatusBadge({
        pageState: {
          ...pageState,
          studentStates: {
            'student-1': 'questioning',
            'student-2': 'satisfied',
            'student-3': 'uncertain',
          },
        },
        agentId: 'student-2',
      }),
    ).toMatchObject({ emoji: '🤓', labelKey: 'revisit.challenge.studentStatus.satisfied' });

    expect(
      getRevisitParticipantStatusBadge({
        pageState: {
          ...pageState,
          studentStates: {
            'student-1': 'questioning',
            'student-2': 'satisfied',
            'student-3': 'uncertain',
          },
        },
        agentId: 'student-3',
      }),
    ).toMatchObject({ emoji: '🤨', labelKey: 'revisit.challenge.studentStatus.uncertain' });

    expect(
      getRevisitParticipantStatusBadge({
        pageState: { ...pageState, rescued: true },
        agentId: 'assistant-1',
        assistant: true,
      }),
    ).toMatchObject({ emoji: '🛟', labelKey: 'revisit.challenge.studentStatus.rescue' });
  });

  test('uses the teach-this-page cue only when entering a revisit page', () => {
    expect(getRevisitCueUserLabelKey('teach-page')).toBe('revisit.challenge.teachThisPage');
    expect(getRevisitCueUserLabelKey('default')).toBeUndefined();
    expect(reduceRevisitCueUserPrompt('default', 'enter-page')).toBe('teach-page');
    expect(reduceRevisitCueUserPrompt('teach-page', 'teacher-submit')).toBe('default');
    expect(reduceRevisitCueUserPrompt('teach-page', 'agent-cued-user')).toBe('default');
  });

  test('keeps the opening active until audio finishes or the fallback elapses', () => {
    const active = { active: true, audioStarted: false };

    expect(reduceRevisitOpeningPlayback(active, 'audio-idle')).toEqual(active);

    const playing = reduceRevisitOpeningPlayback(active, 'audio-started');
    expect(playing).toEqual({ active: true, audioStarted: true });
    expect(reduceRevisitOpeningPlayback(playing, 'audio-idle')).toEqual({
      active: false,
      audioStarted: true,
    });

    expect(reduceRevisitOpeningPlayback(active, 'fallback-elapsed')).toEqual({
      active: false,
      audioStarted: false,
    });
  });
});
