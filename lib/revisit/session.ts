import type { UIMessage } from 'ai';

import type {
  DirectorState,
  ChatMessageMetadata,
  ChatSession,
  SessionStatus,
  StatelessChatRequest,
  StatelessEvent,
} from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';
import type { ModelServiceTier } from '@/lib/types/provider';
import type { RevisitExamBlueprint, RevisitGateDecision, RevisitProbe } from '@/lib/revisit/types';

export const REVISIT_STUDENT_AGENT_ID = 'default-4';
export const REVISIT_DEFAULT_STUDENT_AGENT_IDS = [
  REVISIT_STUDENT_AGENT_ID,
  'default-3',
  'default-5',
];
export const REVISIT_ASSISTANT_AGENT_ID = 'default-2';
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
}

export interface RevisitParsedSse {
  messages: RevisitMessage[];
  gate: RevisitGateDecision | null;
  directorState?: DirectorState;
  errorMessage: string | null;
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
    `elapsed_minutes: ${Math.round(args.elapsedMinutes)}`,
    `soft_limit_minutes: ${REVISIT_SOFT_LIMIT_MINUTES}`,
    `latest_teacher_turn: ${args.latestTeacherText}`,
  ].join('\n');
}

export function createRevisitChatRequest(args: {
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
  agentIds?: RevisitAgentIds;
  agentConfigs?: NonNullable<StatelessChatRequest['config']['agentConfigs']>;
}): StatelessChatRequest {
  const page = args.blueprint.skeleton.pages[args.pageState.pageIndex];
  const agentIds = args.agentIds ?? {
    studentAgentId: REVISIT_STUDENT_AGENT_ID,
    studentAgentIds: REVISIT_DEFAULT_STUDENT_AGENT_IDS,
    assistantAgentId: REVISIT_ASSISTANT_AGENT_ID,
  };
  const studentAgentIds = agentIds.studentAgentIds.length
    ? agentIds.studentAgentIds
    : [agentIds.studentAgentId];

  return {
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
      }),
    },
    directorState: args.directorState,
    apiKey: args.apiKey,
    model: args.model,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.providerType ? { providerType: args.providerType } : {}),
    ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
  };
}

export function resolveRevisitAgentIds(candidates: RevisitAgentCandidate[]): RevisitAgentIds {
  const byRolePriority = (role: string) =>
    candidates
      .filter((candidate) => candidate.role === role)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const allowedDefaultStudents = new Set(REVISIT_DEFAULT_STUDENT_AGENT_IDS);
  const studentIds = byRolePriority('student')
    .filter(
      (candidate) =>
        !candidate.id.startsWith('default-') || allowedDefaultStudents.has(candidate.id),
    )
    .slice(0, 3)
    .map((candidate) => candidate.id);

  return {
    studentAgentId: studentIds[0] ?? REVISIT_STUDENT_AGENT_ID,
    studentAgentIds: studentIds.length ? studentIds : [...REVISIT_DEFAULT_STUDENT_AGENT_IDS],
    assistantAgentId: byRolePriority('assistant')[0]?.id ?? REVISIT_ASSISTANT_AGENT_ID,
  };
}

export function roleForRevisitAgent(
  agentId: string,
  agentIds: RevisitAgentIds = {
    studentAgentId: REVISIT_STUDENT_AGENT_ID,
    studentAgentIds: REVISIT_DEFAULT_STUDENT_AGENT_IDS,
    assistantAgentId: REVISIT_ASSISTANT_AGENT_ID,
  },
): RevisitMessage['role'] {
  return agentId === agentIds.assistantAgentId ? 'assistant' : 'student';
}

export function canNavigateRevisitPage(
  pageStates: RevisitSessionPageState[],
  currentPageIndex: number,
  targetPageIndex: number,
  gateSkipEnabled = false,
): boolean {
  if (targetPageIndex < 0 || targetPageIndex >= pageStates.length) return false;
  if (targetPageIndex <= currentPageIndex) return true;
  if (gateSkipEnabled) return true;

  return pageStates
    .slice(currentPageIndex, targetPageIndex)
    .every((state) => Boolean(state.passed));
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

export function getRevisitStudentStatusEmoji(
  pageState: RevisitSessionPageState | undefined,
  teacherTurnActive: boolean,
): string {
  if (teacherTurnActive) return '👂';
  if (!pageState) return '🤔';
  if (pageState.passed) return '🤓';
  if (pageState.rescued || pageState.additionalProbeCount >= REVISIT_PAGE_PROBE_CAP) return '🤔';
  if (pageState.additionalProbeCount > 0) return '🤨';
  return '🤔';
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

export function parseRevisitChatSse(
  input: string,
  agentIds?: RevisitAgentIds,
): {
  events: RevisitParsedSse;
  remaining: string;
} {
  const normalized = input.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remaining = blocks.pop() ?? '';
  const messages: RevisitMessage[] = [];
  let activeMessage: RevisitMessage | null = null;
  let gate: RevisitGateDecision | null = null;
  let directorState: DirectorState | undefined;
  let errorMessage: string | null = null;

  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');

    if (!data) continue;

    try {
      const event = JSON.parse(data) as StatelessEvent;
      if (event.type === 'agent_start') {
        activeMessage = {
          id: event.data.messageId,
          role: roleForRevisitAgent(event.data.agentId, agentIds),
          agentId: event.data.agentId,
          agentName: event.data.agentName,
          agentAvatar: event.data.agentAvatar,
          text: '',
          createdAt: Date.now(),
        };
        messages.push(activeMessage);
      } else if (event.type === 'text_delta' && activeMessage) {
        activeMessage.text += event.data.content;
      } else if (event.type === 'revisit_gate') {
        gate = event.data;
      } else if (event.type === 'done') {
        directorState = event.data.directorState;
      } else if (event.type === 'error') {
        errorMessage = event.data.message;
      }
    } catch {
      // Ignore malformed complete blocks; incomplete blocks stay in `remaining`.
    }
  }

  return {
    events: {
      messages: messages.filter((message) => message.text.trim().length > 0),
      gate,
      directorState,
      errorMessage,
    },
    remaining,
  };
}
