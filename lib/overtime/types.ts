import type { SceneOutline, WidgetOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

export type OvertimeTeachingMove = 'extend' | 'remediate' | 'apply' | 'trace';
export type OvertimeDisposition = 'append_page' | 'new_course';

export interface RequestLearningExtensionParams {
  disposition: OvertimeDisposition;
  topic: string;
  teachingMove: OvertimeTeachingMove;
  reason?: string;
}

export interface OvertimeChatContext {
  stageId: string;
  entry: 'course_complete' | 'overtime_page';
  formal: true;
}

export type OvertimeConceptDraft =
  | { kind: 'existing'; conceptId: string }
  | { kind: 'new'; label: string; summary: string };

export type OvertimeSceneOutlineDraft = Omit<SceneOutline, 'id' | 'order'>;

export interface OvertimePlanDraft {
  outline: OvertimeSceneOutlineDraft;
  sourceSceneIds: string[];
  concepts: OvertimeConceptDraft[];
}

export type OvertimeExtensionStatus =
  | 'planning'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'interrupted';

export type OvertimeExtensionPhase = 'outline' | 'content' | 'actions' | 'tts' | 'commit';

export interface OvertimeSceneProvenance {
  extensionId: string;
  sequence: number;
  teachingMove: OvertimeTeachingMove;
  conceptIds: string[];
  sourceSceneIds: string[];
}

/** Durable generation checkpoints. Classroom runtime state is intentionally excluded. */
export interface OvertimeExtension {
  id: string;
  stageId: string;
  sequence: number;
  reservedOrder: number;
  status: OvertimeExtensionStatus;
  phase: OvertimeExtensionPhase;
  userPrompt: string;
  decision: RequestLearningExtensionParams;
  plan?: OvertimePlanDraft;
  outline?: SceneOutline;
  content?: unknown;
  scene?: Scene;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

const TEACHING_MOVES = new Set<OvertimeTeachingMove>(['extend', 'remediate', 'apply', 'trace']);
const DISPOSITIONS = new Set<OvertimeDisposition>(['append_page', 'new_course']);
const SCENE_TYPES = new Set<SceneOutline['type']>(['slide', 'quiz', 'interactive', 'pbl']);
const WIDGET_TYPES = new Set(['simulation', 'diagram', 'code', 'game', 'visualization3d']);
const DIAGRAM_TYPES = new Set<NonNullable<WidgetOutline['diagramType']>>([
  'flowchart',
  'mindmap',
  'hierarchy',
  'system',
]);
const CODE_LANGUAGES = new Set<NonNullable<WidgetOutline['language']>>([
  'python',
  'javascript',
  'typescript',
  'java',
  'cpp',
]);
const GAME_TYPES = new Set<NonNullable<WidgetOutline['gameType']>>([
  'quiz',
  'puzzle',
  'strategy',
  'card',
  'action',
]);
const VISUALIZATION_TYPES = new Set<NonNullable<WidgetOutline['visualizationType']>>([
  'molecular',
  'solar',
  'anatomy',
  'geometry',
  'physics',
  'custom',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(nonEmptyString).filter((item): item is string => Boolean(item));
}

function parseWidgetOutline(
  widgetType: NonNullable<SceneOutline['widgetType']>,
  value: unknown,
): WidgetOutline | null {
  const input = record(value);
  if (!input) return null;
  const concept = nonEmptyString(input.concept) ?? undefined;

  switch (widgetType) {
    case 'simulation': {
      const keyVariables = stringArray(input.keyVariables);
      return keyVariables.length > 0 ? { concept, keyVariables } : null;
    }
    case 'diagram': {
      const diagramType = input.diagramType as NonNullable<WidgetOutline['diagramType']>;
      if (!DIAGRAM_TYPES.has(diagramType)) return null;
      const nodeCount =
        typeof input.nodeCount === 'number' && input.nodeCount > 0
          ? Math.floor(input.nodeCount)
          : undefined;
      return { concept, diagramType, ...(nodeCount ? { nodeCount } : {}) };
    }
    case 'code': {
      const language = input.language as NonNullable<WidgetOutline['language']>;
      if (!CODE_LANGUAGES.has(language)) return null;
      const challengeType = nonEmptyString(input.challengeType) ?? undefined;
      return { concept, language, ...(challengeType ? { challengeType } : {}) };
    }
    case 'game': {
      const gameType = input.gameType as NonNullable<WidgetOutline['gameType']>;
      if (!GAME_TYPES.has(gameType)) return null;
      const challenge = nonEmptyString(input.challenge) ?? undefined;
      const playerControls = stringArray(input.playerControls);
      return {
        concept,
        gameType,
        ...(challenge ? { challenge } : {}),
        ...(playerControls.length > 0 ? { playerControls } : {}),
      };
    }
    case 'visualization3d': {
      const visualizationType = input.visualizationType as NonNullable<
        WidgetOutline['visualizationType']
      >;
      const objects = stringArray(input.objects);
      const interactions = stringArray(input.interactions);
      if (
        !VISUALIZATION_TYPES.has(visualizationType) ||
        objects.length === 0 ||
        interactions.length === 0
      ) {
        return null;
      }
      return { concept, visualizationType, objects, interactions };
    }
    default:
      return null;
  }
}

export function parseRequestLearningExtensionParams(
  value: unknown,
): RequestLearningExtensionParams | null {
  const input = record(value);
  if (!input) return null;
  const disposition = input.disposition as OvertimeDisposition;
  const teachingMove = input.teachingMove as OvertimeTeachingMove;
  const topic = nonEmptyString(input.topic);
  if (!DISPOSITIONS.has(disposition) || !TEACHING_MOVES.has(teachingMove) || !topic) return null;
  const reason = nonEmptyString(input.reason);
  return {
    disposition,
    topic,
    teachingMove,
    ...(reason ? { reason } : {}),
  };
}

export function parseOvertimePlanDraft(
  value: unknown,
  context: { knownSceneIds: ReadonlySet<string>; knownConceptIds: ReadonlySet<string> },
): OvertimePlanDraft {
  const input = record(value);
  const rawOutline = record(input?.outline);
  if (!input || !rawOutline) throw new Error('Overtime planner returned no outline.');

  const type = rawOutline.type as SceneOutline['type'];
  const title = nonEmptyString(rawOutline.title);
  const description = nonEmptyString(rawOutline.description);
  const keyPoints = stringArray(rawOutline.keyPoints);
  if (!SCENE_TYPES.has(type) || !title || !description || keyPoints.length === 0) {
    throw new Error('Overtime planner returned an invalid one-page outline.');
  }

  const outline: OvertimeSceneOutlineDraft = {
    type,
    title,
    description,
    keyPoints,
  };
  const teachingObjective = nonEmptyString(rawOutline.teachingObjective);
  if (teachingObjective) outline.teachingObjective = teachingObjective;
  if (typeof rawOutline.estimatedDuration === 'number' && rawOutline.estimatedDuration > 0) {
    outline.estimatedDuration = rawOutline.estimatedDuration;
  }
  const languageNote = nonEmptyString(rawOutline.languageNote);
  if (languageNote) outline.languageNote = languageNote;

  if (type === 'quiz') {
    const config = record(rawOutline.quizConfig);
    const difficulty = config?.difficulty;
    const questionTypes = stringArray(config?.questionTypes).filter(
      (item): item is 'single' | 'multiple' | 'text' =>
        item === 'single' || item === 'multiple' || item === 'text',
    );
    if (
      !config ||
      typeof config.questionCount !== 'number' ||
      config.questionCount < 1 ||
      (difficulty !== 'easy' && difficulty !== 'medium' && difficulty !== 'hard') ||
      questionTypes.length === 0
    ) {
      throw new Error('Quiz overtime outline requires a complete quizConfig.');
    }
    outline.quizConfig = {
      questionCount: Math.floor(config.questionCount),
      difficulty,
      questionTypes,
    };
  }

  if (type === 'interactive') {
    const widgetType = nonEmptyString(rawOutline.widgetType);
    const widgetOutline =
      widgetType && WIDGET_TYPES.has(widgetType)
        ? parseWidgetOutline(
            widgetType as NonNullable<SceneOutline['widgetType']>,
            rawOutline.widgetOutline,
          )
        : null;
    if (!widgetType || !WIDGET_TYPES.has(widgetType) || !widgetOutline) {
      throw new Error('Interactive overtime outline requires widgetType and widgetOutline.');
    }
    outline.widgetType = widgetType as NonNullable<SceneOutline['widgetType']>;
    outline.widgetOutline = widgetOutline;
  }

  if (type === 'pbl') {
    const config = record(rawOutline.pblConfig);
    const projectTopic = nonEmptyString(config?.projectTopic);
    const projectDescription = nonEmptyString(config?.projectDescription);
    const targetSkills = stringArray(config?.targetSkills);
    if (!config || !projectTopic || !projectDescription || targetSkills.length === 0) {
      throw new Error('PBL overtime outline requires a complete pblConfig.');
    }
    outline.pblConfig = {
      projectTopic,
      projectDescription,
      targetSkills,
      ...(typeof config.issueCount === 'number'
        ? { issueCount: Math.max(1, Math.floor(config.issueCount)) }
        : {}),
      ...(typeof config.scenarioRoleplay === 'boolean'
        ? { scenarioRoleplay: config.scenarioRoleplay }
        : {}),
      ...(nonEmptyString(config.scenarioBrief)
        ? { scenarioBrief: nonEmptyString(config.scenarioBrief)! }
        : {}),
    };
  }

  const sourceSceneIds = Array.from(new Set(stringArray(input.sourceSceneIds)));
  for (const sceneId of sourceSceneIds) {
    if (!context.knownSceneIds.has(sceneId)) {
      throw new Error(`Overtime planner invented source scene id "${sceneId}".`);
    }
  }

  if (!Array.isArray(input.concepts) || input.concepts.length === 0) {
    throw new Error('Overtime planner returned no concept references.');
  }
  const concepts: OvertimeConceptDraft[] = [];
  const seen = new Set<string>();
  for (const rawConcept of input.concepts) {
    const concept = record(rawConcept);
    if (!concept) throw new Error('Overtime planner returned an invalid concept reference.');
    const existingConceptId = nonEmptyString(concept.existingConceptId);
    if (existingConceptId) {
      if (!context.knownConceptIds.has(existingConceptId)) {
        throw new Error(`Overtime planner invented concept id "${existingConceptId}".`);
      }
      const key = `existing:${existingConceptId}`;
      if (!seen.has(key)) concepts.push({ kind: 'existing', conceptId: existingConceptId });
      seen.add(key);
      continue;
    }
    const label = nonEmptyString(concept.label);
    const summary = nonEmptyString(concept.summary);
    if (!label || !summary) throw new Error('New overtime concepts require label and summary.');
    const key = `new:${label.toLocaleLowerCase()}`;
    if (!seen.has(key)) concepts.push({ kind: 'new', label, summary });
    seen.add(key);
  }
  if (type === 'quiz' && concepts.some((concept) => concept.kind === 'new')) {
    throw new Error('Quiz overtime pages cannot introduce a new concept.');
  }

  return { outline, sourceSceneIds, concepts };
}

export function isOvertimeScene(scene: Pick<Scene, 'overtime'>): boolean {
  return Boolean(scene.overtime?.extensionId);
}
