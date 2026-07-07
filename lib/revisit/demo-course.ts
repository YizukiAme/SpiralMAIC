import type { Scene, Stage } from '@/lib/types/stage';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';
import { saveStageData } from '@/lib/utils/stage-storage';
import { saveBlueprintAndInitializeState } from '@/lib/revisit/db';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@/lib/edit/slide-schema';
import type { PPTTextElement } from '@openmaic/dsl';

export const DEMO_REVISIT_STAGE_ID = 'revisit-demo-fallacies';

export async function installRevisitDemoCourse(now = Date.now()): Promise<string> {
  const stage = createDemoStage(now);
  const scenes = createDemoScenes(stage.id, now);
  await saveStageData(stage.id, {
    stage,
    scenes,
    currentSceneId: scenes[0]?.id ?? null,
    chats: [],
  });
  await saveBlueprintAndInitializeState(createDemoBlueprint(stage.id, now), now);
  return stage.id;
}

function createDemoStage(now: number): Stage {
  return {
    id: DEMO_REVISIT_STAGE_ID,
    name: 'Non-formal Fallacies Demo',
    description: 'A pre-generated Spiral Review demo course about informal logical fallacies.',
    createdAt: now,
    updatedAt: now,
    languageDirective: 'zh-CN',
  };
}

function createDemoScenes(stageId: string, now: number): Scene[] {
  return [
    createSlideScene({
      id: 'fallacy-demo-01',
      stageId,
      order: 0,
      title: '识别稻草人谬误',
      lines: [
        '真实主张：减少一点作业。',
        '弱化版本：完全不想学习。',
        '攻击弱化版本，就是稻草人谬误。',
      ],
      now,
    }),
    createSlideScene({
      id: 'fallacy-demo-02',
      stageId,
      order: 1,
      title: '因果谬误',
      lines: ['先后发生不等于因果关系。', '需要机制、对照或更多证据来支持因果判断。'],
      now,
    }),
    createSlideScene({
      id: 'fallacy-demo-03',
      stageId,
      order: 2,
      title: '虚假两难',
      lines: ['把复杂选择压成两个极端选项。', '反驳时先找被排除的第三种可能。'],
      now,
    }),
  ];
}

function createSlideScene(args: {
  id: string;
  stageId: string;
  order: number;
  title: string;
  lines: string[];
  now: number;
}): Scene {
  return {
    id: args.id,
    stageId: args.stageId,
    type: 'slide',
    title: args.title,
    order: args.order,
    createdAt: args.now,
    updatedAt: args.now,
    content: {
      type: 'slide',
      canvas: {
        id: `${args.id}-canvas`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#f8fafc',
          themeColors: ['#0f172a', '#2563eb', '#f59e0b'],
          fontColor: '#0f172a',
          fontName: 'Inter',
        },
        background: { type: 'solid', color: '#f8fafc' },
        elements: [
          textElement({
            id: `${args.id}-title`,
            content: args.title,
            left: 90,
            top: 80,
            width: 820,
            height: 80,
            fontSize: 44,
            bold: true,
          }),
          ...args.lines.map((line, index) =>
            textElement({
              id: `${args.id}-line-${index + 1}`,
              content: line,
              left: 110,
              top: 210 + index * 90,
              width: 780,
              height: 60,
              fontSize: 28,
            }),
          ),
        ],
      },
      schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    },
  };
}

function textElement(args: {
  id: string;
  content: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  bold?: boolean;
}): PPTTextElement {
  return {
    id: args.id,
    type: 'text',
    left: args.left,
    top: args.top,
    width: args.width,
    height: args.height,
    rotate: 0,
    content: `<p style="font-size: ${args.fontSize}px; font-weight: ${args.bold ? 700 : 400};">${args.content}</p>`,
    defaultFontName: 'Inter',
    defaultColor: '#0f172a',
    lineHeight: 1.2,
  };
}

function createDemoBlueprint(stageId: string, now: number): RevisitExamBlueprint {
  return {
    id: `${stageId}:demo-blueprint`,
    stageId,
    generatedAt: now,
    language: 'zh-CN',
    sourceHash: 'demo-blueprint',
    concepts: [
      {
        id: 'straw-man',
        label: '稻草人谬误',
        summary: '把对方观点替换成更弱、更夸张的版本后再攻击。',
        anchors: {
          clarity: ['能说清真实主张和弱化版本的区别'],
          doubtResolution: ['能回答为什么这不是直接反驳'],
          transfer: ['能判断新例子是否换了靶子'],
          errorCorrection: ['能修正把普通类比误判成稻草人的错误'],
        },
        probes: [
          {
            id: 'p-straw-transfer',
            conceptId: 'straw-man',
            pageIndex: 0,
            kind: 'transfer',
            prompt: '如果有人说“你支持减少作业就是不想学习”，这是不是稻草人？为什么？',
          },
        ],
      },
      {
        id: 'false-cause',
        label: '因果谬误',
        summary: '把时间先后、相关性或巧合误当成因果关系。',
        anchors: {
          clarity: ['能区分相关和因果'],
          doubtResolution: ['能说明为什么先后发生不等于因果'],
          transfer: ['能给出需要更多证据的例子'],
          errorCorrection: ['能补上机制或对照证据'],
        },
        probes: [
          {
            id: 'p-cause-evidence',
            conceptId: 'false-cause',
            pageIndex: 1,
            kind: 'confusion',
            prompt: '如果两件事总是一起出现，我们还缺什么证据才敢说有因果？',
          },
        ],
      },
      {
        id: 'false-dilemma',
        label: '虚假两难',
        summary: '把多种可能压缩成两个极端选择。',
        anchors: {
          clarity: ['能指出被隐藏的第三种可能'],
          doubtResolution: ['能回答为什么不是所有选择都二选一'],
          transfer: ['能识别生活中的虚假两难'],
          errorCorrection: ['能把二选一改写成更完整的选项集'],
        },
        probes: [
          {
            id: 'p-dilemma-third-option',
            conceptId: 'false-dilemma',
            pageIndex: 2,
            kind: 'correction',
            prompt: '“不是满分就是失败”这句话漏掉了哪些可能？',
          },
        ],
      },
    ],
    skeleton: {
      pages: [
        {
          id: 'page-01',
          title: '识别稻草人',
          summary: '讲清真实主张、弱化版本和攻击对象。',
          conceptIds: ['straw-man'],
          cues: ['真实主张', '弱化版本', '换了靶子'],
        },
        {
          id: 'page-02',
          title: '判断因果',
          summary: '区分相关、先后发生和真正因果。',
          conceptIds: ['false-cause'],
          cues: ['相关不等于因果', '机制', '对照证据'],
        },
        {
          id: 'page-03',
          title: '拆开虚假两难',
          summary: '找出被二选一叙述藏起来的中间选项。',
          conceptIds: ['false-dilemma'],
          cues: ['两个极端', '第三种可能', '改写选项'],
        },
      ],
    },
    raw: { demo: true },
  };
}
