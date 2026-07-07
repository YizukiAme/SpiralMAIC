import { describe, expect, test } from 'vitest';

import {
  buildRevisitGateContext,
  buildRevisitProbeContext,
  createRevisitChatRequest,
  createTeacherRevisitMessage,
  parseRevisitChatSse,
  REVISIT_ASSISTANT_AGENT_ID,
  REVISIT_PAGE_PROBE_CAP,
  REVISIT_STUDENT_AGENT_ID,
  type RevisitSessionPageState,
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
    expect(request.config.agentIds).toEqual([REVISIT_STUDENT_AGENT_ID, REVISIT_ASSISTANT_AGENT_ID]);
    expect(request.config.revisitProbeContext).toContain('Candidate probes');
    expect(request.config.revisitGateContext).toContain('latest_teacher_turn');
    expect(request.messages[0].metadata?.originalRole).toBe('teacher');
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
