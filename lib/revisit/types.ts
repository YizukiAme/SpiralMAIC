import type { Scene, Stage } from '@/lib/types/stage';

export type RevisitDimension = 'clarity' | 'doubtResolution' | 'transfer' | 'errorCorrection';

export type RevisitDimensionScores = Record<RevisitDimension, number>;

export type RevisitProbeKind = 'confusion' | 'misconception' | 'transfer' | 'correction';

export interface RevisitProbe {
  id: string;
  conceptId: string;
  pageIndex?: number;
  kind: RevisitProbeKind;
  prompt: string;
  expectedAnswer?: string;
  expectedCorrection?: string;
}

export interface RevisitConcept {
  id: string;
  label: string;
  summary: string;
  anchors: Record<RevisitDimension, string[]>;
  probes: RevisitProbe[];
}

export interface RevisitSkeletonPage {
  id: string;
  title: string;
  summary: string;
  conceptIds: string[];
  cues: string[];
}

export interface RevisitSkeleton {
  pages: RevisitSkeletonPage[];
}

export interface RevisitExamBlueprint {
  id: string;
  stageId: string;
  generatedAt: number;
  language: string;
  sourceHash: string;
  /** Short, lesson-language summary of the completed course's conceptual progression. */
  openingBrief?: string;
  concepts: RevisitConcept[];
  skeleton: RevisitSkeleton;
}

export interface UserConceptState {
  stageId: string;
  conceptId: string;
  label: string;
  hDays: number;
  learnedAt: number;
  lastRetrievalAt: number;
  evidenceCount: number;
  successChallengeDates: string[];
  createdAt: number;
  updatedAt: number;
  stableAt?: number;
}

export interface RevisitFactualError {
  id: string;
  conceptId?: string;
  description: string;
  corrected: boolean;
  severity: 'minor' | 'major' | 'critical';
}

export interface ConceptEvidence {
  id: string;
  attemptId: string;
  stageId: string;
  conceptId: string;
  source: 'teach_back' | 'qa' | 'generation' | 'review';
  scores: RevisitDimensionScores;
  q: number;
  qRaw: number;
  polarity: 'positive' | 'negative' | 'mixed';
  timestamp: number;
  pageIndex?: number;
  notes?: string;
  errors: RevisitFactualError[];
}

export interface RevisitPageReport {
  pageId: string;
  pageIndex: number;
  passed: boolean;
  probeCount: number;
  conceptIds: string[];
  notes?: string;
}

export interface RevisitJudgeReport {
  attemptId: string;
  stageId: string;
  completedAt: number;
  summary: string;
  dimensions: RevisitDimensionScores;
  qRaw: number;
  q: number;
  errors: RevisitFactualError[];
  evidence: ConceptEvidence[];
  pageReports: RevisitPageReport[];
}

export interface LessonProgress {
  stageId: string;
  completedAt: number;
  updatedAt: number;
}

export interface LessonConcept {
  stageId: string;
  conceptId: string;
  label: string;
  summary: string;
  origin: 'lesson' | 'overtime';
  sourceSceneIds: string[];
  introducedAt: number;
  learnedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type RevisitAttemptStatus = 'preparing' | 'ready' | 'completed';

/** Durable generated challenge content. Classroom runtime is deliberately excluded. */
export interface RevisitAttempt {
  attemptId: string;
  stageId: string;
  sequence: number;
  status: RevisitAttemptStatus;
  sourceStage?: Stage;
  sourceScenes: Scene[];
  blueprint?: RevisitExamBlueprint;
  scenes: Array<Scene | null>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  preparationError?: string;
  reportOnly?: boolean;
  spiralAgentGenerationState?: 'pending-reveal' | 'revealed';
}

export interface RevisitDemoSession {
  id: string;
  /** Missing only on demo batches created before course-scoped demos were introduced. */
  stageId?: string;
  databaseName: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  offsetHours: number;
  simulatedAt?: number;
}

export type StudyArtifactKind =
  | 'briefing'
  | 'mindMap'
  | 'studyGuide'
  | 'faq'
  | 'flashcards'
  | 'quiz';

export type StudyArtifactFocusMode = 'balanced' | 'weak-points' | 'selected-scenes';

export interface StudyArtifactReferenceFields {
  conceptIds?: string[];
  sourceSceneIds?: string[];
}

export interface StudyArtifactCommonOptions {
  focusMode: StudyArtifactFocusMode;
  selectedSceneIds: string[];
  customInstructions: string;
}

export interface BriefingStudyArtifactOptions extends StudyArtifactCommonOptions {
  orientation: 'portrait' | 'landscape' | 'square';
  detailLevel: 'standard' | 'compact' | 'detailed';
}

export interface MindMapStudyArtifactOptions extends StudyArtifactCommonOptions {
  depth: number;
  includeExamples: boolean;
}

export interface StudyGuideArtifactOptions extends StudyArtifactCommonOptions {
  detailLevel: 'standard' | 'compact' | 'detailed';
}

export interface FaqStudyArtifactOptions extends StudyArtifactCommonOptions {
  count: number;
}

export interface FlashcardsStudyArtifactOptions extends StudyArtifactCommonOptions {
  count: number;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface QuizStudyArtifactOptions extends StudyArtifactCommonOptions {
  count: number;
  difficulty: 'easy' | 'medium' | 'hard';
  format: 'mcq';
}

export interface StudyArtifactOptionsByKind {
  briefing: BriefingStudyArtifactOptions;
  mindMap: MindMapStudyArtifactOptions;
  studyGuide: StudyGuideArtifactOptions;
  faq: FaqStudyArtifactOptions;
  flashcards: FlashcardsStudyArtifactOptions;
  quiz: QuizStudyArtifactOptions;
}

export type StudyArtifactOptions = StudyArtifactOptionsByKind[StudyArtifactKind];

export interface StudyArtifactListItem extends StudyArtifactReferenceFields {
  text: string;
}

export interface StudyArtifactCalloutBlock extends StudyArtifactReferenceFields {
  type: 'callout';
  title: string;
  body: string;
  tone: 'tip' | 'warning' | 'remember' | 'pitfall';
}

export interface StudyArtifactComparisonBlock extends StudyArtifactReferenceFields {
  type: 'comparison';
  title: string;
  leftLabel: string;
  leftText: string;
  rightLabel: string;
  rightText: string;
  takeaway?: string;
}

export interface StudyArtifactDefinitionBlock extends StudyArtifactReferenceFields {
  type: 'definition';
  term: string;
  definition: string;
}

export interface StudyArtifactExampleBlock extends StudyArtifactReferenceFields {
  type: 'example';
  title: string;
  prompt?: string;
  explanation: string;
}

export interface StudyArtifactListBlock extends StudyArtifactReferenceFields {
  type: 'list';
  style: 'bulleted' | 'numbered';
  title?: string;
  items: StudyArtifactListItem[];
}

export interface StudyArtifactParagraphBlock extends StudyArtifactReferenceFields {
  type: 'paragraph';
  text: string;
}

export interface StudyArtifactHeadingBlock extends StudyArtifactReferenceFields {
  type: 'heading';
  text: string;
  level: 2 | 3;
}

export interface StudyArtifactTableRow extends StudyArtifactReferenceFields {
  cells: string[];
}

export interface StudyArtifactTableBlock extends StudyArtifactReferenceFields {
  type: 'table';
  title?: string;
  columns: string[];
  rows: StudyArtifactTableRow[];
}

export interface StudyArtifactTimelineEntry extends StudyArtifactReferenceFields {
  label: string;
  text: string;
}

export interface StudyArtifactTimelineBlock extends StudyArtifactReferenceFields {
  type: 'timeline';
  title?: string;
  entries: StudyArtifactTimelineEntry[];
}

export type StudyArtifactRichBlock =
  | StudyArtifactCalloutBlock
  | StudyArtifactComparisonBlock
  | StudyArtifactDefinitionBlock
  | StudyArtifactExampleBlock
  | StudyArtifactListBlock
  | StudyArtifactHeadingBlock
  | StudyArtifactParagraphBlock
  | StudyArtifactTableBlock
  | StudyArtifactTimelineBlock;

export interface BriefingStudyArtifactContent {
  blocks: StudyArtifactRichBlock[];
}

export interface StudyGuideArtifactContent {
  blocks: StudyArtifactRichBlock[];
}

export interface StudyArtifactMindMapNode extends StudyArtifactReferenceFields {
  id: string;
  label: string;
  note?: string;
  examples?: string[];
  children: StudyArtifactMindMapNode[];
}

export interface MindMapStudyArtifactContent {
  root: StudyArtifactMindMapNode;
}

export interface StudyArtifactFaqItem extends StudyArtifactReferenceFields {
  id: string;
  question: string;
  answer: string;
}

export interface FaqStudyArtifactContent {
  items: StudyArtifactFaqItem[];
}

export interface StudyArtifactFlashcard extends StudyArtifactReferenceFields {
  id: string;
  front: string;
  back: string;
}

export interface FlashcardsStudyArtifactContent {
  items: StudyArtifactFlashcard[];
}

export interface StudyArtifactQuizItem extends StudyArtifactReferenceFields {
  id: string;
  question: string;
  options: string[];
  answerIndex: number;
  hint?: string;
  explanation: string;
}

export interface QuizStudyArtifactContent {
  items: StudyArtifactQuizItem[];
}

export interface StudyArtifactContentByKind {
  briefing: BriefingStudyArtifactContent;
  mindMap: MindMapStudyArtifactContent;
  studyGuide: StudyGuideArtifactContent;
  faq: FaqStudyArtifactContent;
  flashcards: FlashcardsStudyArtifactContent;
  quiz: QuizStudyArtifactContent;
}

export interface StudyArtifactBase<
  K extends StudyArtifactKind,
  O extends StudyArtifactOptionsByKind[K],
  C extends StudyArtifactContentByKind[K],
> {
  id: string;
  stageId: string;
  kind: K;
  version: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  stageUpdatedAt: number;
  language: string;
  options: O;
  sourceHash: string;
  lessonSourceHash: string;
  content: C;
}

export type BriefingStudyArtifact = StudyArtifactBase<
  'briefing',
  BriefingStudyArtifactOptions,
  BriefingStudyArtifactContent
>;
export type MindMapStudyArtifact = StudyArtifactBase<
  'mindMap',
  MindMapStudyArtifactOptions,
  MindMapStudyArtifactContent
>;
export type StudyGuideArtifact = StudyArtifactBase<
  'studyGuide',
  StudyGuideArtifactOptions,
  StudyGuideArtifactContent
>;
export type FaqStudyArtifact = StudyArtifactBase<
  'faq',
  FaqStudyArtifactOptions,
  FaqStudyArtifactContent
>;
export type FlashcardsStudyArtifact = StudyArtifactBase<
  'flashcards',
  FlashcardsStudyArtifactOptions,
  FlashcardsStudyArtifactContent
>;
export type QuizStudyArtifact = StudyArtifactBase<
  'quiz',
  QuizStudyArtifactOptions,
  QuizStudyArtifactContent
>;

export type StudyArtifact =
  | BriefingStudyArtifact
  | MindMapStudyArtifact
  | StudyGuideArtifact
  | FaqStudyArtifact
  | FlashcardsStudyArtifact
  | QuizStudyArtifact;

export type StudyArtifactFor<K extends StudyArtifactKind> = Extract<StudyArtifact, { kind: K }>;

export interface StudyArtifactDraftBase<
  K extends StudyArtifactKind,
  O extends StudyArtifactOptionsByKind[K],
  C extends StudyArtifactContentByKind[K],
> {
  stageId: string;
  kind: K;
  title: string;
  stageUpdatedAt: number;
  language: string;
  options: O;
  sourceHash: string;
  lessonSourceHash: string;
  content: C;
}

export type StudyArtifactDraft =
  | StudyArtifactDraftBase<'briefing', BriefingStudyArtifactOptions, BriefingStudyArtifactContent>
  | StudyArtifactDraftBase<'mindMap', MindMapStudyArtifactOptions, MindMapStudyArtifactContent>
  | StudyArtifactDraftBase<'studyGuide', StudyGuideArtifactOptions, StudyGuideArtifactContent>
  | StudyArtifactDraftBase<'faq', FaqStudyArtifactOptions, FaqStudyArtifactContent>
  | StudyArtifactDraftBase<
      'flashcards',
      FlashcardsStudyArtifactOptions,
      FlashcardsStudyArtifactContent
    >
  | StudyArtifactDraftBase<'quiz', QuizStudyArtifactOptions, QuizStudyArtifactContent>;

export interface StudyArtifactGenerationResultByKind {
  briefing: { language: string; content: BriefingStudyArtifactContent };
  mindMap: { language: string; content: MindMapStudyArtifactContent };
  studyGuide: { language: string; content: StudyGuideArtifactContent };
  faq: { language: string; content: FaqStudyArtifactContent };
  flashcards: { language: string; content: FlashcardsStudyArtifactContent };
  quiz: { language: string; content: QuizStudyArtifactContent };
}

export type StudyArtifactGenerationResult<K extends StudyArtifactKind = StudyArtifactKind> =
  StudyArtifactGenerationResultByKind[K];

export type StudyPracticeKind = 'flashcards' | 'quiz';

export interface StudyPracticeBase<K extends StudyPracticeKind> {
  artifactId: string;
  stageId: string;
  kind: K;
  updatedAt: number;
  completedAt?: number;
}

export interface FlashcardsStudyPracticeState extends StudyPracticeBase<'flashcards'> {
  currentIndex: number;
  masteredItemIds: string[];
  difficultItemIds: string[];
}

export interface QuizStudyPracticeState extends StudyPracticeBase<'quiz'> {
  answers: Record<string, number>;
  correctItemIds: string[];
}

export type StudyPracticeState = FlashcardsStudyPracticeState | QuizStudyPracticeState;

export interface RevisitAdaptiveContext {
  completedChallengeCount: number;
  memorySummary: LessonMemorySummary;
  conceptStates: UserConceptState[];
  pendingConcepts?: LessonConcept[];
  latestReport?: RevisitJudgeReport;
}

export type RevisitGateStatus = 'pass' | 'probe' | 'rescue' | 'fail';
export type RevisitResponseDirective = 'acknowledge' | 'probe' | 'rescue';
export type RevisitStudentUnderstandingState = 'questioning' | 'uncertain' | 'satisfied';
export type RevisitStudentStateMap = Record<string, RevisitStudentUnderstandingState>;

export interface RevisitAgentPromptContext {
  pageContext: string;
  responseDirective: RevisitResponseDirective;
}

export interface RevisitGateDecision {
  status: RevisitGateStatus;
  pageIndex: number;
  reason: string;
  nextProbeId?: string;
  confidence?: number;
  studentStates?: RevisitStudentStateMap;
}

export interface RevisitSettings {
  reverseChallengeEnabled: boolean;
  stableSuccessesRequired: number;
  activeRevisitDemoSessionByStage: Record<string, string>;
  revisitVirtualClockOffsetHoursByStage: Record<string, number>;
  demoGateSkipEnabled: boolean;
}

export interface LessonMemorySummary {
  status: 'unlearned' | 'fresh' | 'review' | 'stable';
  recall: number | null;
  meanRecall: number | null;
  minRecall: number | null;
  color: string;
  badge?: 'stable';
}
