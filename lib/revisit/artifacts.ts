import { z, type ZodType } from 'zod';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { normalizeStudyArtifactOptions } from '@/lib/revisit/artifact-options';
import { simpleSourceHash } from '@/lib/revisit/blueprint';
import { extractJsonObject } from '@/lib/revisit/prompt-builders';
import {
  buildLessonSourceHash,
  buildSceneDigestWithStableIds,
  selectSourceScenes,
} from '@/lib/revisit/source';
import type {
  BriefingStudyArtifactContent,
  RevisitAdaptiveContext,
  StudyArtifactCommonOptions,
  StudyArtifactGenerationResult,
  StudyArtifactKind,
  StudyArtifactMindMapNode,
  StudyArtifactOptions,
  StudyArtifactOptionsByKind,
  StudyArtifactRichBlock,
  StudyGuideArtifactContent,
} from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const STUDY_ARTIFACT_KIND_VALUES = [
  'briefing',
  'mindMap',
  'studyGuide',
  'faq',
  'flashcards',
  'quiz',
] as const satisfies readonly StudyArtifactKind[];

const FORBIDDEN_HTML_RE = /<(?:!doctype|html|head|body|script|style)\b|<[^>]+>/i;
const FORBIDDEN_CODE_FENCE_RE = /```/;
const FORBIDDEN_MARKDOWN_HEADING_RE = /(^|\n)\s{0,3}#{1,6}\s/;
const FORBIDDEN_MARKDOWN_BLOCK_RE =
  /(^|\n)\s{0,3}(?:>\s+|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/m;
const FORBIDDEN_MARKDOWN_INLINE_RE =
  /(?:\*\*|__)[^\n]+(?:\*\*|__)|!?\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`/;

const ARTIFACT_KIND_LABELS: Record<StudyArtifactKind, string> = {
  briefing: 'Briefing',
  mindMap: 'Mind Map',
  studyGuide: 'Study Guide',
  faq: 'FAQ',
  flashcards: 'Flashcards',
  quiz: 'Quiz',
};

const LOCALIZED_ARTIFACT_KIND_LABELS: Record<
  'en-US' | 'zh-CN' | 'zh-TW' | 'ja-JP' | 'ko-KR' | 'pt-BR' | 'ru-RU' | 'ar-SA',
  Record<StudyArtifactKind, string>
> = {
  'en-US': ARTIFACT_KIND_LABELS,
  'zh-CN': {
    briefing: '视觉简报',
    mindMap: '思维导图',
    studyGuide: '学习指南',
    faq: '常见问题',
    flashcards: '闪卡',
    quiz: '测验',
  },
  'zh-TW': {
    briefing: '視覺簡報',
    mindMap: '心智圖',
    studyGuide: '學習指南',
    faq: '常見問題',
    flashcards: '閃卡',
    quiz: '測驗',
  },
  'ja-JP': {
    briefing: 'ビジュアル概要',
    mindMap: 'マインドマップ',
    studyGuide: '学習ガイド',
    faq: 'よくある質問',
    flashcards: 'フラッシュカード',
    quiz: 'クイズ',
  },
  'ko-KR': {
    briefing: '비주얼 브리핑',
    mindMap: '마인드맵',
    studyGuide: '학습 가이드',
    faq: '자주 묻는 질문',
    flashcards: '플래시카드',
    quiz: '퀴즈',
  },
  'pt-BR': {
    briefing: 'Resumo visual',
    mindMap: 'Mapa mental',
    studyGuide: 'Guia de estudo',
    faq: 'Perguntas frequentes',
    flashcards: 'Cartões de estudo',
    quiz: 'Questionário',
  },
  'ru-RU': {
    briefing: 'Визуальный конспект',
    mindMap: 'Карта знаний',
    studyGuide: 'Учебное руководство',
    faq: 'Частые вопросы',
    flashcards: 'Карточки',
    quiz: 'Тест',
  },
  'ar-SA': {
    briefing: 'موجز مرئي',
    mindMap: 'خريطة ذهنية',
    studyGuide: 'دليل دراسة',
    faq: 'أسئلة شائعة',
    flashcards: 'بطاقات تعليمية',
    quiz: 'اختبار',
  },
};

const ARTIFACT_PROMPT_IDS: Record<StudyArtifactKind, (typeof PROMPT_IDS)[keyof typeof PROMPT_IDS]> =
  {
    briefing: PROMPT_IDS.REVISIT_STUDY_ARTIFACT_BRIEFING,
    mindMap: PROMPT_IDS.REVISIT_STUDY_ARTIFACT_MIND_MAP,
    studyGuide: PROMPT_IDS.REVISIT_STUDY_ARTIFACT_STUDY_GUIDE,
    faq: PROMPT_IDS.REVISIT_STUDY_ARTIFACT_FAQ,
    flashcards: PROMPT_IDS.REVISIT_STUDY_ARTIFACT_FLASHCARDS,
    quiz: PROMPT_IDS.REVISIT_STUDY_ARTIFACT_QUIZ,
  };

const sceneSchema = z.object({
  id: z.string().trim().min(1),
  stageId: z.string().trim().min(1),
});

const stageSchema = z.object({
  id: z.string().trim().min(1),
  updatedAt: z.number().finite(),
});

function safeModelText(field: string): z.ZodString {
  return z
    .string()
    .trim()
    .min(1, `${field} must be non-empty text`)
    .refine((value) => !FORBIDDEN_HTML_RE.test(value), {
      message: `${field} must not contain HTML tags or document wrappers`,
    })
    .refine((value) => !FORBIDDEN_CODE_FENCE_RE.test(value), {
      message: `${field} must not contain code fences`,
    })
    .refine((value) => !FORBIDDEN_MARKDOWN_HEADING_RE.test(value), {
      message: `${field} must not contain Markdown headings`,
    })
    .refine(
      (value) =>
        !FORBIDDEN_MARKDOWN_BLOCK_RE.test(value) && !FORBIDDEN_MARKDOWN_INLINE_RE.test(value),
      {
        message: `${field} must not contain Markdown formatting`,
      },
    );
}

const optionalRefsSchema = z.object({
  conceptIds: z.array(z.string().trim().min(1)).optional(),
  sourceSceneIds: z.array(z.string().trim().min(1)).optional(),
});

const paragraphBlockSchema = optionalRefsSchema.extend({
  type: z.literal('paragraph'),
  text: safeModelText('paragraph.text'),
});

const headingBlockSchema = optionalRefsSchema.extend({
  type: z.literal('heading'),
  text: safeModelText('heading.text'),
  level: z.union([z.literal(2), z.literal(3)]),
});

const listItemSchema = optionalRefsSchema.extend({
  text: safeModelText('list.items[].text'),
});

const listBlockSchema = optionalRefsSchema.extend({
  type: z.literal('list'),
  style: z.enum(['bulleted', 'numbered']),
  title: safeModelText('list.title').optional(),
  items: z.array(listItemSchema).min(1),
});

const calloutBlockSchema = optionalRefsSchema.extend({
  type: z.literal('callout'),
  title: safeModelText('callout.title'),
  body: safeModelText('callout.body'),
  tone: z.enum(['tip', 'warning', 'remember', 'pitfall']),
});

const definitionBlockSchema = optionalRefsSchema.extend({
  type: z.literal('definition'),
  term: safeModelText('definition.term'),
  definition: safeModelText('definition.definition'),
});

const exampleBlockSchema = optionalRefsSchema.extend({
  type: z.literal('example'),
  title: safeModelText('example.title'),
  prompt: safeModelText('example.prompt').optional(),
  explanation: safeModelText('example.explanation'),
});

const comparisonBlockSchema = optionalRefsSchema.extend({
  type: z.literal('comparison'),
  title: safeModelText('comparison.title'),
  leftLabel: safeModelText('comparison.leftLabel'),
  leftText: safeModelText('comparison.leftText'),
  rightLabel: safeModelText('comparison.rightLabel'),
  rightText: safeModelText('comparison.rightText'),
  takeaway: safeModelText('comparison.takeaway').optional(),
});

const timelineEntrySchema = optionalRefsSchema.extend({
  label: safeModelText('timeline.entries[].label'),
  text: safeModelText('timeline.entries[].text'),
});

const timelineBlockSchema = optionalRefsSchema.extend({
  type: z.literal('timeline'),
  title: safeModelText('timeline.title').optional(),
  entries: z.array(timelineEntrySchema).min(1),
});

const tableRowSchema = optionalRefsSchema.extend({
  cells: z.array(safeModelText('table.rows[].cells[]')).min(1),
});

const tableBlockSchema = optionalRefsSchema
  .extend({
    type: z.literal('table'),
    title: safeModelText('table.title').optional(),
    columns: z.array(safeModelText('table.columns[]')).min(1),
    rows: z.array(tableRowSchema).min(1),
  })
  .superRefine((value, ctx) => {
    for (const [index, row] of value.rows.entries()) {
      if (row.cells.length !== value.columns.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', index, 'cells'],
          message: 'table rows must align with the declared columns',
        });
      }
    }
  });

const richBlockSchema: ZodType<StudyArtifactRichBlock> = z.union([
  headingBlockSchema,
  paragraphBlockSchema,
  listBlockSchema,
  calloutBlockSchema,
  definitionBlockSchema,
  exampleBlockSchema,
  comparisonBlockSchema,
  timelineBlockSchema,
  tableBlockSchema,
]);

const briefingContentSchema: ZodType<BriefingStudyArtifactContent> = z.object({
  blocks: z.array(richBlockSchema).min(1),
});

const studyGuideContentSchema: ZodType<StudyGuideArtifactContent> = z.object({
  blocks: z.array(richBlockSchema).min(1),
});

type ParsedMindMapNode = Omit<StudyArtifactMindMapNode, 'id' | 'children'> & {
  children?: ParsedMindMapNode[];
};

const parsedMindMapNodeSchema: ZodType<ParsedMindMapNode> = z.lazy(() =>
  optionalRefsSchema.extend({
    label: safeModelText('mindMap.root.label'),
    note: safeModelText('mindMap.root.note').optional(),
    examples: z.array(safeModelText('mindMap.root.examples[]')).optional(),
    children: z.array(parsedMindMapNodeSchema).optional(),
  }),
);

const mindMapContentSchema = z
  .object({
    root: parsedMindMapNodeSchema,
  })
  .transform(({ root }) => ({ root: assignMindMapNodeIds(root, ['root']) }));

const faqContentSchema = z
  .object({
    items: z
      .array(
        optionalRefsSchema.extend({
          question: safeModelText('faq.items[].question'),
          answer: safeModelText('faq.items[].answer'),
        }),
      )
      .min(1),
  })
  .transform(({ items }) => ({
    items: items.map((item, index) => ({ id: `faq-${index + 1}`, ...item })),
  }));

const flashcardsContentSchema = z
  .object({
    items: z
      .array(
        optionalRefsSchema.extend({
          front: safeModelText('flashcards.items[].front'),
          back: safeModelText('flashcards.items[].back'),
        }),
      )
      .min(1),
  })
  .transform(({ items }) => ({
    items: items.map((item, index) => ({ id: `flashcard-${index + 1}`, ...item })),
  }));

const quizContentSchema = z
  .object({
    items: z
      .array(
        optionalRefsSchema.extend({
          question: safeModelText('quiz.items[].question'),
          options: z.array(safeModelText('quiz.items[].options[]')).min(2),
          answerIndex: z.number().int().min(0),
          hint: safeModelText('quiz.items[].hint').optional(),
          explanation: safeModelText('quiz.items[].explanation'),
        }),
      )
      .min(1),
  })
  .superRefine((value, ctx) => {
    for (const [index, item] of value.items.entries()) {
      if (item.answerIndex >= item.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'answerIndex'],
          message: 'quiz answerIndex must point to an existing option',
        });
      }
    }
  })
  .transform(({ items }) => ({
    items: items.map((item, index) => ({ id: `quiz-${index + 1}`, ...item })),
  }));

const generationResultSchemas = {
  briefing: z.object({
    language: z.string().trim().min(1),
    content: briefingContentSchema,
  }),
  mindMap: z.object({
    language: z.string().trim().min(1),
    content: mindMapContentSchema,
  }),
  studyGuide: z.object({
    language: z.string().trim().min(1),
    content: studyGuideContentSchema,
  }),
  faq: z.object({
    language: z.string().trim().min(1),
    content: faqContentSchema,
  }),
  flashcards: z.object({
    language: z.string().trim().min(1),
    content: flashcardsContentSchema,
  }),
  quiz: z.object({
    language: z.string().trim().min(1),
    content: quizContentSchema,
  }),
};

export class StudyArtifactRequestError extends Error {}

// Options schemas/defaults live in the client-safe artifact-options module;
// re-exported here so server callers keep a single import surface.
export {
  getDefaultStudyArtifactOptions,
  normalizeStudyArtifactOptions,
} from '@/lib/revisit/artifact-options';

export function validateStudyArtifactRequest(body: unknown): {
  kind: StudyArtifactKind;
  options: StudyArtifactOptions;
  stage: Stage;
  scenes: Scene[];
  adaptiveContext?: RevisitAdaptiveContext;
} {
  const raw = z
    .object({
      kind: z.enum(STUDY_ARTIFACT_KIND_VALUES),
      options: z.unknown().optional(),
      stage: stageSchema.passthrough(),
      scenes: z.array(sceneSchema.passthrough()).min(1),
      adaptiveContext: z.unknown().optional(),
    })
    .safeParse(body);

  if (!raw.success) {
    throw new StudyArtifactRequestError(raw.error.issues[0]?.message ?? 'Invalid artifact request');
  }

  const stage = raw.data.stage as unknown as Stage;
  const scenes = raw.data.scenes as unknown as Scene[];
  const options = normalizeStudyArtifactOptions(raw.data.kind, raw.data.options);
  ensureSceneSelectionIsValid(options, scenes);

  return {
    kind: raw.data.kind,
    options,
    stage,
    scenes,
    adaptiveContext: raw.data.adaptiveContext as RevisitAdaptiveContext | undefined,
  };
}

export function buildStudyArtifactPrompt<K extends StudyArtifactKind>(args: {
  stage: Stage;
  scenes: Scene[];
  kind: K;
  options?: Partial<StudyArtifactOptionsByKind[K]> | StudyArtifactOptionsByKind[K];
  adaptiveContext?: RevisitAdaptiveContext;
}): {
  system: string;
  user: string;
  sourceHash: string;
  lessonSourceHash: string;
  options: StudyArtifactOptionsByKind[K];
  selectedScenes: Scene[];
} {
  const options = normalizeStudyArtifactOptions(
    args.kind,
    args.options,
  ) as StudyArtifactOptionsByKind[K];
  ensureSceneSelectionIsValid(options, args.scenes);
  const selectedScenes = resolveArtifactSourceScenes(args.scenes, options);
  const sceneDigest = buildSceneDigestWithStableIds(selectedScenes);
  const lessonSourceHash = buildLessonSourceHash(args.stage, args.scenes);
  const sourceHash = simpleSourceHash(
    JSON.stringify({
      kind: args.kind,
      lessonSourceHash,
      options,
      adaptiveContext: args.adaptiveContext ?? null,
    }),
  );

  const prompt = buildPrompt(ARTIFACT_PROMPT_IDS[args.kind], {
    languageDirective: args.stage.languageDirective || 'Follow the classroom language.',
    stageTitle: args.stage.name || 'Untitled classroom',
    stageSummary: args.stage.description || '',
    artifactKindLabel: ARTIFACT_KIND_LABELS[args.kind],
    artifactOptionsJson: JSON.stringify(options, null, 2),
    selectedSceneDigest: sceneDigest,
    adaptiveContextJson: JSON.stringify(args.adaptiveContext ?? {}, null, 2),
    customInstructions: options.customInstructions || '(none)',
  });

  if (!prompt) {
    throw new Error(`${ARTIFACT_PROMPT_IDS[args.kind]} template not found`);
  }

  return {
    ...prompt,
    sourceHash,
    lessonSourceHash,
    options,
    selectedScenes,
  };
}

export function parseStudyArtifactResponse<K extends StudyArtifactKind>(args: {
  kind: K;
  text: string;
}): StudyArtifactGenerationResult<K> {
  const schema = generationResultSchemas[args.kind] as unknown as z.ZodType<
    StudyArtifactGenerationResult<K>
  >;
  const parsed = schema.parse(extractJsonObject(args.text));
  return {
    ...parsed,
    language: parsed.language.trim(),
  };
}

export function sanitizeStudyArtifactReferences<T extends StudyArtifactGenerationResult>(
  generation: T,
  validReferences: {
    validConceptIds: Iterable<string>;
    validSourceSceneIds: Iterable<string>;
  },
): T {
  const allowedConceptIds = new Set(validReferences.validConceptIds);
  const allowedSourceSceneIds = new Set(validReferences.validSourceSceneIds);
  return sanitizeReferenceValue(generation, {
    conceptIds: allowedConceptIds,
    sourceSceneIds: allowedSourceSceneIds,
  }) as T;
}

export function suggestStudyArtifactTitle(
  stage: Pick<Stage, 'name'>,
  kind: StudyArtifactKind,
  language = 'en-US',
): string {
  const base = stage.name?.trim() || 'Untitled classroom';
  const locale = resolveArtifactTitleLocale(language);
  return `${base} ${LOCALIZED_ARTIFACT_KIND_LABELS[locale][kind]}`;
}

export { createStudyArtifactVersionId } from '@/lib/revisit/artifact-ids';

export { isStudyArtifactStale } from '@/lib/revisit/source';

function ensureSceneSelectionIsValid(options: StudyArtifactCommonOptions, scenes: Scene[]): void {
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const missing = options.selectedSceneIds.filter((sceneId) => !sceneIds.has(sceneId));
  if (missing.length > 0) {
    throw new StudyArtifactRequestError(
      `selectedSceneIds contains unknown scene ids: ${missing.join(', ')}`,
    );
  }
  if (options.focusMode === 'selected-scenes' && options.selectedSceneIds.length === 0) {
    throw new StudyArtifactRequestError(
      'selectedSceneIds is required when focusMode is selected-scenes',
    );
  }
}

function resolveArtifactSourceScenes(
  scenes: Scene[],
  options: Pick<StudyArtifactCommonOptions, 'selectedSceneIds'>,
): Scene[] {
  return selectSourceScenes(scenes, options.selectedSceneIds);
}

function assignMindMapNodeIds(node: ParsedMindMapNode, path: string[]): StudyArtifactMindMapNode {
  return {
    ...node,
    id: path.join('-'),
    children: (node.children ?? []).map((child, index) =>
      assignMindMapNodeIds(child, [...path, String(index + 1)]),
    ),
  };
}

function resolveArtifactTitleLocale(language: string): keyof typeof LOCALIZED_ARTIFACT_KIND_LABELS {
  const normalized = language.trim().toLowerCase();
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hant')) return 'zh-TW';
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('ja')) return 'ja-JP';
  if (normalized.startsWith('ko')) return 'ko-KR';
  if (normalized.startsWith('pt')) return 'pt-BR';
  if (normalized.startsWith('ru')) return 'ru-RU';
  if (normalized.startsWith('ar')) return 'ar-SA';
  return 'en-US';
}

function sanitizeReferenceValue(
  value: unknown,
  allowed: { conceptIds: Set<string>; sourceSceneIds: Set<string> },
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReferenceValue(item, allowed));
  }
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'conceptIds' || key === 'sourceSceneIds') && Array.isArray(child)) {
      const filtered = [
        ...new Set(
          child.filter((id): id is string => typeof id === 'string' && allowed[key].has(id)),
        ),
      ];
      if (filtered.length > 0) output[key] = filtered;
      continue;
    }
    output[key] = sanitizeReferenceValue(child, allowed);
  }
  return output;
}
