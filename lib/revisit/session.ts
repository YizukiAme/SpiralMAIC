import type { UIMessage } from 'ai';

import type {
  DirectorState,
  ChatMessageMetadata,
  ChatSession,
  SessionStatus,
  StatelessChatRequest,
} from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';
import type { ModelServiceTier } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';
import type {
  RevisitExamBlueprint,
  RevisitGateDecision,
  RevisitProbe,
  RevisitStudentStateMap,
} from '@/lib/revisit/types';

const log = createLogger('RevisitSession');

export const REVISIT_PAGE_PROBE_CAP = 2;
export const REVISIT_SOFT_LIMIT_MINUTES = 15;

export interface RevisitAgentCandidate {
  id: string;
  role: string;
  priority?: number;
}

export interface RevisitAgentIds {
  studentAgentId: string;
  studentAgentIds: string[];
  assistantAgentId: string;
}

export interface RevisitMessage {
  id: string;
  role: 'teacher' | 'student' | 'assistant';
  text: string;
  agentId?: string;
  agentName?: string;
  agentAvatar?: string;
  createdAt: number;
}

export interface RevisitSessionPageState {
  pageIndex: number;
  askedProbeIds: string[];
  additionalProbeCount: number;
  rescued: boolean;
  passed: boolean;
  studentStates?: RevisitStudentStateMap;
}

export function buildRevisitOpeningContext(args: {
  blueprint: RevisitExamBlueprint;
  sourceScenes: Scene[];
  locale: string;
}): { brief: string | null; topics: string } {
  const brief = args.blueprint.openingBrief?.replace(/\s+/g, ' ').trim() || null;
  const orderedSceneTitles = [...args.sourceScenes]
    .sort((left, right) => left.order - right.order)
    .map((scene) => scene.title.trim())
    .filter(Boolean);
  const candidates =
    orderedSceneTitles.length > 0
      ? orderedSceneTitles
      : args.blueprint.concepts.map((concept) => concept.label.trim()).filter(Boolean);
  const topics = Array.from(new Set(candidates)).slice(0, 5);

  try {
    return {
      brief,
      topics: new Intl.ListFormat(args.locale, {
        style: 'long',
        type: 'conjunction',
      }).format(topics),
    };
  } catch {
    return { brief, topics: topics.join(', ') };
  }
}

export function createTeacherRevisitMessage(text: string, now = Date.now()): RevisitMessage {
  return {
    id: `revisit-teacher-${now}`,
    role: 'teacher',
    text,
    createdAt: now,
  };
}

export function createAssistantRevisitMessage(args: {
  text: string;
  agentId: string;
  agentName?: string;
  agentAvatar?: string;
  now?: number;
}): RevisitMessage {
  const now = args.now ?? Date.now();
  return {
    id: `revisit-assistant-opening-${now}`,
    role: 'assistant',
    text: args.text,
    agentId: args.agentId,
    agentName: args.agentName,
    agentAvatar: args.agentAvatar,
    createdAt: now,
  };
}

export function revisitMessagesToUiMessages(
  messages: RevisitMessage[],
): UIMessage<ChatMessageMetadata>[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role === 'teacher' ? 'user' : 'assistant',
    parts: [{ type: 'text', text: message.text }],
    metadata: {
      originalRole: message.role === 'teacher' ? 'teacher' : 'agent',
      senderName:
        message.role === 'teacher'
          ? 'Teacher (Human)'
          : message.agentName || (message.role === 'assistant' ? 'AI Assistant' : 'AI Student'),
      senderAvatar: message.agentAvatar,
      agentId: message.agentId,
      createdAt: message.createdAt,
    },
  }));
}

export function buildRevisitChatSession(args: {
  id: string;
  title: string;
  messages: RevisitMessage[];
  status: SessionStatus;
  now?: number;
}): ChatSession {
  const now = args.now ?? Date.now();
  return {
    id: args.id,
    type: 'discussion',
    title: args.title,
    status: args.status,
    messages: revisitMessagesToUiMessages(args.messages),
    config: {
      agentIds: Array.from(
        new Set(args.messages.map((message) => message.agentId).filter((id): id is string => !!id)),
      ),
    },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function selectPageProbes(
  blueprint: RevisitExamBlueprint,
  pageIndex: number,
): RevisitProbe[] {
  const page = blueprint.skeleton.pages[pageIndex];
  if (!page) return [];
  const conceptIds = new Set(page.conceptIds);
  return blueprint.concepts
    .filter((concept) => conceptIds.has(concept.id))
    .flatMap((concept) =>
      concept.probes.filter((probe) => probe.pageIndex == null || probe.pageIndex === pageIndex),
    );
}

export function buildRevisitProbeContext(args: {
  blueprint: RevisitExamBlueprint;
  pageState: RevisitSessionPageState;
}): string {
  const page = args.blueprint.skeleton.pages[args.pageState.pageIndex];
  if (!page) return '';

  const probes = selectPageProbes(args.blueprint, args.pageState.pageIndex);
  const asked = new Set(args.pageState.askedProbeIds);
  const available = probes.filter((probe) => !asked.has(probe.id)).slice(0, REVISIT_PAGE_PROBE_CAP);
  const concepts = args.blueprint.concepts.filter((concept) =>
    page.conceptIds.includes(concept.id),
  );

  return [
    `Page ${args.pageState.pageIndex + 1}: ${page.title}`,
    `Summary: ${page.summary}`,
    `Concepts: ${concepts.map((concept) => `${concept.label} - ${concept.summary}`).join('; ')}`,
    `Cues: ${page.cues.join('; ')}`,
    `Already asked probe ids: ${args.pageState.askedProbeIds.join(', ') || 'none'}`,
    `Remaining probe budget on this page: ${Math.max(0, REVISIT_PAGE_PROBE_CAP - args.pageState.additionalProbeCount)}`,
    `Candidate probes: ${available.map((probe) => `[${probe.id}] ${probe.prompt}`).join(' | ') || 'none'}`,
  ].join('\n');
}

export function buildRevisitGateContext(args: {
  blueprint: RevisitExamBlueprint;
  pageState: RevisitSessionPageState;
  latestTeacherText: string;
  elapsedMinutes: number;
  activeStudentAgentIds?: string[];
}): string {
  const page = args.blueprint.skeleton.pages[args.pageState.pageIndex];
  if (!page) return '';
  const probes = selectPageProbes(args.blueprint, args.pageState.pageIndex);
  const concepts = args.blueprint.concepts.filter((concept) =>
    page.conceptIds.includes(concept.id),
  );

  return [
    `page_index: ${args.pageState.pageIndex}`,
    `page_title: ${page.title}`,
    `page_summary: ${page.summary}`,
    `concepts: ${concepts.map((concept) => `${concept.id}=${concept.label}: ${concept.summary}`).join('; ')}`,
    `expected_cues: ${page.cues.join('; ')}`,
    `available_probes: ${probes.map((probe) => `${probe.id}: ${probe.prompt}`).join(' | ') || 'none'}`,
    `asked_probe_ids: ${args.pageState.askedProbeIds.join(', ') || 'none'}`,
    `additional_probe_count: ${args.pageState.additionalProbeCount}`,
    `additional_probe_cap: ${REVISIT_PAGE_PROBE_CAP}`,
    `rescued: ${args.pageState.rescued}`,
    `active_student_ids: ${args.activeStudentAgentIds?.join(', ') || 'none'}`,
    `current_student_states: ${formatStudentStates(args.pageState.studentStates)}`,
    `elapsed_minutes: ${Math.round(args.elapsedMinutes)}`,
    `soft_limit_minutes: ${REVISIT_SOFT_LIMIT_MINUTES}`,
    `latest_teacher_turn: ${args.latestTeacherText}`,
  ].join('\n');
}

export function createRevisitChatRequest(args: {
  attemptId: string;
  stage: Stage;
  scenes: Scene[];
  blueprint: RevisitExamBlueprint;
  messages: RevisitMessage[];
  pageState: RevisitSessionPageState;
  latestTeacherText: string;
  elapsedMinutes: number;
  directorState?: DirectorState;
  model: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: string;
  serviceTier?: ModelServiceTier;
  agentIds: RevisitAgentIds;
  agentConfigs?: NonNullable<StatelessChatRequest['config']['agentConfigs']>;
}): StatelessChatRequest {
  const page = args.blueprint.skeleton.pages[args.pageState.pageIndex];
  const agentIds = args.agentIds;
  const studentAgentIds = agentIds.studentAgentIds.length
    ? agentIds.studentAgentIds
    : [agentIds.studentAgentId];

  return {
    session: { kind: 'revisit-attempt', id: args.attemptId },
    messages: revisitMessagesToUiMessages(args.messages),
    storeState: {
      stage: args.stage,
      scenes: args.scenes,
      currentSceneId: args.scenes[args.pageState.pageIndex]?.id ?? args.scenes[0]?.id ?? null,
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: {
      agentIds: [...studentAgentIds, agentIds.assistantAgentId],
      ...(args.agentConfigs?.length ? { agentConfigs: args.agentConfigs } : {}),
      sessionType: 'discussion',
      discussionTopic: page?.title || args.stage.name,
      revisitProbeContext: buildRevisitProbeContext({
        blueprint: args.blueprint,
        pageState: args.pageState,
      }),
      revisitGateContext: buildRevisitGateContext({
        blueprint: args.blueprint,
        pageState: args.pageState,
        latestTeacherText: args.latestTeacherText,
        elapsedMinutes: args.elapsedMinutes,
        activeStudentAgentIds: studentAgentIds,
      }),
      revisitFallbackDirective:
        args.pageState.additionalProbeCount >= REVISIT_PAGE_PROBE_CAP ? 'rescue' : 'probe',
    },
    directorState: args.directorState,
    apiKey: args.apiKey,
    model: args.model,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.providerType ? { providerType: args.providerType } : {}),
    ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
  };
}

export function resolveRevisitAgentIds(
  candidates: RevisitAgentCandidate[],
): RevisitAgentIds | null {
  if (candidates.some((candidate) => candidate.id.startsWith('default-'))) return null;
  const assistants = candidates.filter((candidate) => candidate.role === 'assistant');
  const students = candidates.filter((candidate) => candidate.role === 'student');
  if (
    assistants.length !== 1 ||
    students.length < 2 ||
    students.length > 3 ||
    assistants.length + students.length !== candidates.length
  ) {
    return null;
  }
  const studentIds = students.map((candidate) => candidate.id);
  return {
    studentAgentId: studentIds[0],
    studentAgentIds: studentIds,
    assistantAgentId: assistants[0].id,
  };
}

export function roleForRevisitAgent(
  agentId: string,
  agentIds: RevisitAgentIds,
): RevisitMessage['role'] {
  return agentId === agentIds.assistantAgentId ? 'assistant' : 'student';
}

export function canNavigateRevisitPage(
  pageStates: RevisitSessionPageState[],
  currentPageIndex: number,
  targetPageIndex: number,
  gateSkipEnabled = false,
  failedPageIndex?: number | null,
): boolean {
  if (targetPageIndex < 0 || targetPageIndex >= pageStates.length) return false;
  if (failedPageIndex != null && targetPageIndex === failedPageIndex) return true;
  if (targetPageIndex <= currentPageIndex) return true;
  if (gateSkipEnabled) return true;

  return pageStates
    .slice(currentPageIndex, targetPageIndex)
    .every((state) => Boolean(state.passed));
}

export function getLastUnlockedRevisitPageIndex(
  pageStates: RevisitSessionPageState[],
  availablePages: Array<unknown | null | undefined>,
  gateSkipEnabled = false,
): number {
  let lastUnlockedIndex = 0;
  for (let index = 0; index < pageStates.length; index += 1) {
    if (!availablePages[index]) continue;
    const unlocked =
      gateSkipEnabled || index === 0 || pageStates.slice(0, index).every((state) => state.passed);
    if (unlocked) lastUnlockedIndex = index;
  }
  return lastUnlockedIndex;
}

export interface RevisitSceneStatus {
  passed: boolean;
  locked: boolean;
  current: boolean;
}

export function buildRevisitSceneStatuses(
  scenes: Array<{ id: string }>,
  pageStates: RevisitSessionPageState[],
  currentPageIndex: number,
  gateSkipEnabled = false,
): Record<string, RevisitSceneStatus> {
  return Object.fromEntries(
    scenes.map((scene, index) => [
      scene.id,
      {
        passed: Boolean(pageStates[index]?.passed),
        locked: !canNavigateRevisitPage(pageStates, currentPageIndex, index, gateSkipEnabled),
        current: index === currentPageIndex,
      },
    ]),
  );
}

export interface RevisitParticipantStatusBadge {
  emoji: string;
  labelKey:
    | 'revisit.challenge.studentStatus.listening'
    | 'revisit.challenge.studentStatus.thinking'
    | 'revisit.challenge.studentStatus.questioning'
    | 'revisit.challenge.studentStatus.uncertain'
    | 'revisit.challenge.studentStatus.satisfied'
    | 'revisit.challenge.studentStatus.rescue';
}

export function applyRevisitGateToPageState(args: {
  pageState: RevisitSessionPageState;
  gate: RevisitGateDecision | null;
  activeStudentAgentIds: string[];
  studentMessagesSinceTeacherTurn?: RevisitMessage[];
  fallbackNextProbeId?: string;
}): RevisitSessionPageState {
  const decision =
    args.gate ??
    ({
      status: args.pageState.additionalProbeCount >= REVISIT_PAGE_PROBE_CAP ? 'rescue' : 'probe',
      pageIndex: args.pageState.pageIndex,
      reason: '',
    } satisfies RevisitGateDecision);
  const activeStudentAgentIds = Array.from(new Set(args.activeStudentAgentIds));
  const activeStudentIdSet = new Set(activeStudentAgentIds);
  const gateStudentStates = decision.studentStates ?? {};
  const hasCompleteGateStates =
    args.gate != null &&
    activeStudentAgentIds.length > 0 &&
    activeStudentAgentIds.every((agentId) =>
      Object.prototype.hasOwnProperty.call(gateStudentStates, agentId),
    );
  const studentStates: RevisitStudentStateMap = {};

  for (const agentId of activeStudentAgentIds) {
    const previousState = args.pageState.studentStates?.[agentId];
    if (previousState) studentStates[agentId] = previousState;
  }
  for (const [agentId, state] of Object.entries(gateStudentStates)) {
    if (!activeStudentIdSet.has(agentId)) {
      log.warn('[RevisitGate] Ignoring unknown student state id', {
        agentId,
        pageIndex: decision.pageIndex,
        gateStatus: decision.status,
        activeStudentAgentIds,
      });
      continue;
    }
    studentStates[agentId] = state;
  }

  const respondingStudentMessages = (args.studentMessagesSinceTeacherTurn ?? []).filter(
    (message) =>
      message.role === 'student' &&
      Boolean(message.agentId) &&
      activeStudentIdSet.has(message.agentId as string) &&
      message.text.trim().length > 0,
  );
  if (decision.status === 'pass') {
    for (const message of respondingStudentMessages) {
      if (!isRevisitStudentQuestion(message.text)) {
        studentStates[message.agentId as string] = 'satisfied';
      }
    }
  }
  const questioningAgentIds = respondingStudentMessages
    .filter((message) => isRevisitStudentQuestion(message.text))
    .map((message) => message.agentId as string);
  for (const agentId of questioningAgentIds) {
    studentStates[agentId] = 'questioning';
  }

  const nextState: RevisitSessionPageState = {
    ...args.pageState,
    studentStates,
  };

  if (decision.status === 'rescue') {
    return {
      ...nextState,
      rescued: true,
      passed: false,
    };
  }

  const respondingStudentAskedNewQuestion = questioningAgentIds.length > 0;
  const shouldConsumeProbe =
    decision.status === 'probe' ||
    decision.status === 'fail' ||
    (decision.status === 'pass' && respondingStudentAskedNewQuestion);
  if (shouldConsumeProbe) {
    return consumeRevisitProbeTurn(nextState, args.fallbackNextProbeId);
  }

  if (decision.status === 'pass') {
    const allSatisfied = activeStudentAgentIds.every(
      (agentId) => studentStates[agentId] === 'satisfied',
    );
    return {
      ...nextState,
      studentStates,
      passed: hasCompleteGateStates && allSatisfied,
    };
  }

  return { ...nextState, passed: false };
}

export function applyRevisitGateToPageStates(args: {
  pageStates: RevisitSessionPageState[];
  pageIndex: number;
  gate: RevisitGateDecision | null;
  activeStudentAgentIds: string[];
  studentMessagesSinceTeacherTurn?: RevisitMessage[];
  candidateProbeIds?: string[];
}): RevisitSessionPageState[] {
  const pageState = args.pageStates[args.pageIndex];
  if (!pageState) return args.pageStates;

  const fallbackNextProbeId =
    args.gate?.nextProbeId ??
    args.candidateProbeIds?.find((probeId) => !pageState.askedProbeIds.includes(probeId));
  const nextState = applyRevisitGateToPageState({
    pageState,
    gate: args.gate,
    activeStudentAgentIds: args.activeStudentAgentIds,
    studentMessagesSinceTeacherTurn: args.studentMessagesSinceTeacherTurn,
    fallbackNextProbeId,
  });

  return args.pageStates.map((state, index) => (index === args.pageIndex ? nextState : state));
}

export function isRevisitStudentQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[?？]/.test(trimmed)) return true;
  const explicitlyUnresolved =
    /(不明白|不懂|不知道|不理解|不清楚|不会|没(?:有)?(?:懂|学会|搞懂)|还没(?:有)?弄懂|搞不懂|想不通)/.test(
      trimmed,
    );
  const explicitlyUnresolvedEnglish =
    /\b(?:(?:i\s+)?(?:still\s+)?(?:do(?:n't| not)|cannot|can't)\s+(?:understand|follow|know)|(?:i(?:'m| am)\s+)?(?:still\s+)?(?:confused|lost|uncertain)|(?:this|that|it)\s+(?:still\s+)?(?:does(?:n't| not)|is(?:n't| not))\s+(?:make\s+sense|clear))\b/i.test(
      trimmed,
    );
  if (explicitlyUnresolved || explicitlyUnresolvedEnglish) return true;
  const resolvedAcknowledgement =
    /我(?:现在|已经|终于|这下)?(?:明白|懂|理解|知道|清楚)|(?:明白|懂|理解|知道|清楚)了/.test(
      trimmed,
    );
  if (resolvedAcknowledgement && !/[吗呢][。！!\s]*$/.test(trimmed)) {
    return false;
  }
  return /(为什么|怎么|如何|什么|哪里|哪[个里]?|谁|是否|是不是|能不能|可不可以|算不算|吗[。！!\s]*$|呢[。！!\s]*$)/.test(
    trimmed,
  );
}

export function compactRevisitDirectorState(state: DirectorState): DirectorState {
  return {
    turnCount: state.turnCount,
    agentResponses: state.agentResponses.slice(-6),
    whiteboardLedger: state.whiteboardLedger.slice(-24),
  };
}

export function getRevisitParticipantStatusBadge(args: {
  pageState: RevisitSessionPageState | undefined;
  agentId: string;
  assistant?: boolean;
  teacherSpeaking?: boolean;
  awaitingStudentStatusUpdate?: boolean;
}): RevisitParticipantStatusBadge | undefined {
  if (args.assistant) {
    return args.pageState?.rescued
      ? { emoji: '🛟', labelKey: 'revisit.challenge.studentStatus.rescue' }
      : undefined;
  }
  if (args.teacherSpeaking) {
    return { emoji: '👂', labelKey: 'revisit.challenge.studentStatus.listening' };
  }
  if (args.awaitingStudentStatusUpdate) {
    return { emoji: '🤔', labelKey: 'revisit.challenge.studentStatus.thinking' };
  }

  const state = args.pageState?.studentStates?.[args.agentId];
  if (state === 'questioning') {
    return { emoji: '❓', labelKey: 'revisit.challenge.studentStatus.questioning' };
  }
  if (state === 'uncertain') {
    return { emoji: '🤨', labelKey: 'revisit.challenge.studentStatus.uncertain' };
  }
  if (state === 'satisfied' || args.pageState?.passed) {
    return { emoji: '🤓', labelKey: 'revisit.challenge.studentStatus.satisfied' };
  }

  return { emoji: '🤔', labelKey: 'revisit.challenge.studentStatus.thinking' };
}

function formatStudentStates(studentStates: RevisitStudentStateMap | undefined): string {
  if (!studentStates || Object.keys(studentStates).length === 0) return 'none';
  return Object.entries(studentStates)
    .map(([agentId, state]) => `${agentId}=${state}`)
    .join(', ');
}

function consumeRevisitProbeTurn(
  pageState: RevisitSessionPageState,
  nextProbeId: string | undefined,
): RevisitSessionPageState {
  return {
    ...pageState,
    passed: false,
    additionalProbeCount: Math.min(REVISIT_PAGE_PROBE_CAP, pageState.additionalProbeCount + 1),
    askedProbeIds: nextProbeId
      ? Array.from(new Set([...pageState.askedProbeIds, nextProbeId]))
      : pageState.askedProbeIds,
  };
}

export type RevisitCueUserPrompt = 'teach-page' | 'default';
export type RevisitCueUserPromptEvent = 'enter-page' | 'teacher-submit' | 'agent-cued-user';

export function reduceRevisitCueUserPrompt(
  _current: RevisitCueUserPrompt,
  event: RevisitCueUserPromptEvent,
): RevisitCueUserPrompt {
  return event === 'enter-page' ? 'teach-page' : 'default';
}

export function getRevisitCueUserLabelKey(
  prompt: RevisitCueUserPrompt,
): 'revisit.challenge.teachThisPage' | undefined {
  return prompt === 'teach-page' ? 'revisit.challenge.teachThisPage' : undefined;
}

export interface RevisitOpeningPlaybackState {
  active: boolean;
  audioStarted: boolean;
}

export type RevisitOpeningPlaybackEvent =
  | 'activate'
  | 'audio-started'
  | 'audio-idle'
  | 'fallback-elapsed';

export function reduceRevisitOpeningPlayback(
  state: RevisitOpeningPlaybackState,
  event: RevisitOpeningPlaybackEvent,
): RevisitOpeningPlaybackState {
  if (event === 'activate') return { active: true, audioStarted: false };
  if (event === 'audio-started') {
    return state.active ? { ...state, audioStarted: true } : state;
  }
  if (event === 'audio-idle' && state.audioStarted) {
    return { active: false, audioStarted: true };
  }
  if (event === 'fallback-elapsed') return { ...state, active: false };
  return state;
}
