import { StreamBuffer, type StreamBufferOptions } from '@/lib/buffer/stream-buffer';
import {
  runAgentLoop,
  type AgentLoopOutcome,
  type AgentLoopStoreState,
  type AgentLoopIterationResult,
} from '@/lib/chat/agent-loop';
import {
  isRevisitStudentQuestion,
  roleForRevisitAgent,
  type RevisitAgentIds,
  type RevisitMessage,
} from '@/lib/revisit/session';
import type { RevisitGateDecision } from '@/lib/revisit/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

export const REVISIT_MAX_AGENT_TURNS_PER_TEACHER_TURN = 1;

export interface RevisitAgentLoopCallbacks {
  onAgentMessageStart?: (message: RevisitMessage) => void;
  onAgentMessageText?: (messageId: string, text: string) => void;
  onAgentMessageEnd?: (messageId: string, agentId: string) => void;
  onLiveSpeech?: (text: string | null, agentId: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onGate?: (gate: RevisitGateDecision) => void;
  onError?: (message: string) => void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
  ) => void;
  shouldHoldAfterReveal?: () => { holding: boolean; segmentDone: number } | boolean;
}

export interface RunRevisitAgentLoopArgs {
  request: StatelessChatRequest;
  agentIds: RevisitAgentIds;
  signal?: AbortSignal;
  fetchChat?: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;
  getStoreState?: () => AgentLoopStoreState;
  getMessages?: () => unknown[];
  bufferOptions?: StreamBufferOptions;
  callbacks: RevisitAgentLoopCallbacks;
}

export interface RunRevisitAgentLoopResult {
  outcome: AgentLoopOutcome;
  gate: RevisitGateDecision | null;
}

export async function runRevisitAgentLoop({
  request,
  agentIds,
  signal,
  fetchChat = defaultFetchChat,
  getStoreState,
  getMessages,
  bufferOptions,
  callbacks,
}: RunRevisitAgentLoopArgs): Promise<RunRevisitAgentLoopResult> {
  const controller = signal ? null : new AbortController();
  const loopSignal = signal ?? controller?.signal;
  if (!loopSignal) throw new Error('missing loop signal');

  let currentBuffer: StreamBuffer | null = null;
  let currentMessageId: string | null = null;
  let doneData: AgentLoopIterationResult | null = null;
  let pendingGate: RevisitGateDecision | null = null;
  let lastGate: RevisitGateDecision | null = null;
  let streamError: Error | null = null;
  let agentTurnsThisTeacherTurn = 0;
  let currentIterationMessages = new Map<string, RevisitMessage>();

  const createBuffer = () => {
    const buffer = new StreamBuffer(
      {
        onAgentStart(data) {
          const message: RevisitMessage = {
            id: data.messageId,
            role: roleForRevisitAgent(data.agentId, agentIds),
            agentId: data.agentId,
            agentName: data.agentName,
            agentAvatar: data.avatar,
            text: '',
            createdAt: Date.now(),
          };
          currentIterationMessages.set(message.id, message);
          callbacks.onAgentMessageStart?.({
            ...message,
          });
        },
        onAgentEnd(data) {
          callbacks.onAgentMessageEnd?.(data.messageId, data.agentId);
        },
        onTextReveal(messageId, _partId, revealedText) {
          const message = currentIterationMessages.get(messageId);
          if (message) {
            currentIterationMessages.set(messageId, { ...message, text: revealedText });
          }
          callbacks.onAgentMessageText?.(messageId, revealedText);
        },
        onActionReady() {
          // Revisit currently routes student/assistant talk through the normal
          // classroom loop, but does not expose whiteboard/tool actions as a
          // product surface. Keeping actions in the buffer preserves ordering;
          // a later UI pass can attach an ActionEngine callback here.
        },
        onLiveSpeech(text, liveAgentId) {
          callbacks.onLiveSpeech?.(text, liveAgentId);
        },
        onSpeechProgress(ratio) {
          callbacks.onSpeechProgress?.(ratio);
        },
        onThinking(state) {
          callbacks.onThinking?.(state);
        },
        onCueUser(fromAgentId, prompt) {
          doneData = {
            totalAgents: doneData?.totalAgents ?? 0,
            agentHadContent: doneData?.agentHadContent ?? true,
            cueUserReceived: true,
            directorState: doneData?.directorState,
          };
          callbacks.onCueUser?.(fromAgentId, prompt);
        },
        onDone(data) {
          doneData = {
            directorState: data.directorState,
            totalAgents: data.totalAgents,
            agentHadContent: data.agentHadContent ?? true,
            cueUserReceived: doneData?.cueUserReceived ?? false,
          };
        },
        onError(message) {
          callbacks.onError?.(message);
        },
        onSegmentSealed(messageId, partId, fullText, liveAgentId) {
          callbacks.onSegmentSealed?.(messageId, partId, fullText, liveAgentId);
        },
        shouldHoldAfterReveal: callbacks.shouldHoldAfterReveal,
      },
      { postTextDelayMs: 1200, actionDelayMs: 800, ...bufferOptions },
    );
    buffer.start();
    return buffer;
  };

  const ensureBuffer = () => {
    currentBuffer ??= createBuffer();
    return currentBuffer;
  };

  const outcome = await (async () => {
    try {
      return await runAgentLoop(
        {
          session: request.session,
          config: request.config,
          userProfile: request.userProfile,
          apiKey: request.apiKey,
          baseUrl: request.baseUrl,
          model: request.model,
          providerType: request.providerType,
          thinkingConfig: request.thinkingConfig,
          serviceTier: request.serviceTier,
          initialDirectorState: request.directorState,
        },
        {
          getStoreState: () => getStoreState?.() ?? request.storeState,
          getMessages: () => getMessages?.() ?? request.messages,
          fetchChat,
          onEvent: (event) => {
            processRevisitLoopEvent(event, ensureBuffer(), {
              getCurrentMessageId: () => currentMessageId,
              setCurrentMessageId: (messageId) => {
                currentMessageId = messageId;
              },
              setGate: (gate) => {
                pendingGate = gate;
              },
              setError: (error) => {
                streamError = error;
              },
            });
          },
          onIterationEnd: async () => {
            if (!currentBuffer) return null;
            await currentBuffer.waitUntilDrained();
            currentBuffer = null;

            if (streamError) {
              throw streamError;
            }

            if (pendingGate) {
              lastGate = pendingGate;
              callbacks.onGate?.(pendingGate);
              pendingGate = null;
            }

            const result = doneData;
            doneData = null;
            currentMessageId = null;
            const iterationHadStudentQuestion = Array.from(currentIterationMessages.values()).some(
              (message) => message.role === 'student' && isRevisitStudentQuestion(message.text),
            );
            currentIterationMessages = new Map();
            if (result && result.totalAgents > 0) {
              agentTurnsThisTeacherTurn += result.totalAgents;
              if (!result.cueUserReceived && iterationHadStudentQuestion) {
                callbacks.onCueUser?.();
                return { ...result, cueUserReceived: true };
              }
              if (
                !result.cueUserReceived &&
                agentTurnsThisTeacherTurn >= REVISIT_MAX_AGENT_TURNS_PER_TEACHER_TURN
              ) {
                callbacks.onCueUser?.();
                return { ...result, cueUserReceived: true };
              }
            }
            return result;
          },
        },
        loopSignal,
      );
    } finally {
      const leftoverBuffer = currentBuffer as StreamBuffer | null;
      leftoverBuffer?.dispose();
    }
  })();

  return {
    outcome,
    gate: lastGate,
  };
}

function processRevisitLoopEvent(
  event: StatelessEvent,
  buffer: StreamBuffer,
  state: {
    getCurrentMessageId: () => string | null;
    setCurrentMessageId: (messageId: string | null) => void;
    setGate: (gate: RevisitGateDecision) => void;
    setError: (error: Error) => void;
  },
) {
  switch (event.type) {
    case 'agent_start':
      state.setCurrentMessageId(event.data.messageId);
      buffer.pushAgentStart({
        messageId: event.data.messageId,
        agentId: event.data.agentId,
        agentName: event.data.agentName,
        avatar: event.data.agentAvatar,
        color: event.data.agentColor,
      });
      break;
    case 'agent_end':
      buffer.pushAgentEnd({
        messageId: event.data.messageId,
        agentId: event.data.agentId,
      });
      break;
    case 'text_delta': {
      const messageId = event.data.messageId ?? state.getCurrentMessageId();
      if (messageId) buffer.pushText(messageId, event.data.content);
      break;
    }
    case 'action': {
      const messageId = event.data.messageId ?? state.getCurrentMessageId();
      if (!messageId) break;
      buffer.pushAction({
        actionId: event.data.actionId,
        actionName: event.data.actionName,
        params: event.data.params,
        messageId,
        agentId: event.data.agentId,
      });
      break;
    }
    case 'thinking':
      buffer.pushThinking(event.data);
      break;
    case 'cue_user':
      buffer.pushCueUser(event.data);
      break;
    case 'revisit_gate':
      state.setGate(event.data);
      break;
    case 'done':
      buffer.pushDone(event.data);
      break;
    case 'error': {
      const error = new Error(event.data.message);
      state.setError(error);
      buffer.pushError(event.data.message);
      buffer.pushDone({
        totalActions: 0,
        totalAgents: 0,
        agentHadContent: false,
      });
      break;
    }
  }
}

async function defaultFetchChat(body: Record<string, unknown>, signal: AbortSignal) {
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}
