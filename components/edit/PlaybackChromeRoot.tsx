'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useStageStore } from '@/lib/store';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { SceneSidebar, type SceneSidebarTailPage } from '@/components/stage/scene-sidebar';
import { Header } from '@/components/header';
import { CanvasArea } from '@/components/canvas/canvas-area';
import { Roundtable } from '@/components/roundtable';
import { PlaybackEngine, computePlaybackView } from '@/lib/playback';
import type { EngineMode, TriggerEvent, Effect } from '@/lib/playback';
import {
  canJumpWithinReconstructablePrefix,
  isUnsafePlaybackNavigationAction,
} from '@/lib/playback/action-navigation';
import {
  getActionResumeRestoreCursor,
  clearActionResumePosition,
  createActionResumePosition,
  getActionResumeStorageKey,
  readActionResumeState,
  saveActionResumePosition,
} from '@/lib/playback/action-resume';
import { ActionEngine } from '@/lib/action/engine';
import { createAudioPlayer } from '@/lib/utils/audio-player';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
import type { Participant } from '@/lib/types/roundtable';
import { cn } from '@/lib/utils';
// Playback state persistence removed — refresh always starts from the beginning
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import { RevisitTranscriptArea } from '@/components/chat/revisit-transcript-area';
import { agentsToParticipants, useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { ChatSession } from '@/lib/types/chat';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, BookOpenCheck, LoaderCircle, RefreshCw } from 'lucide-react';
import { VisuallyHidden } from 'radix-ui';
import { recordLessonCompleted } from '@/lib/revisit/db';
import { shouldRecordLessonPlaybackCompletion } from '@/lib/revisit/progress';
import { resolveActiveRevisitScope } from '@/lib/revisit/clock';
import { listLessonConcepts, markLessonConceptsLearned } from '@/lib/revisit/db';
import {
  buildOvertimeCourseGenerationSession,
  mergeReadyOvertimePage,
} from '@/lib/overtime/classroom';
import { runOvertimeGeneration } from '@/lib/overtime/generation';
import {
  createOrGetOvertimeExtension,
  listOvertimeExtensions,
  markActiveOvertimeExtensionsInterrupted,
} from '@/lib/overtime/store';
import type { OvertimeExtension, RequestLearningExtensionParams } from '@/lib/overtime/types';
import {
  advanceInteractiveEngagement,
  createInteractiveEngagement,
  subscribeOvertimeLearningSignals,
  type InteractiveEngagement,
} from '@/lib/overtime/learning';
import { toast } from 'sonner';

function markOvertimeSceneLearned(scene: Scene): void {
  const conceptIds = scene.overtime?.conceptIds ?? [];
  if (conceptIds.length === 0 || useSettingsStore.getState().activeRevisitDemoSessionId) return;
  void markLessonConceptsLearned(scene.stageId, conceptIds, Date.now()).catch((error) => {
    console.error('[Overtime] Failed to record the page learning completion.', error);
  });
}

/**
 * Imperative handle exposed via `ref` so the parent (`Stage`) can tear
 * down playback state synchronously before flipping mode to `'edit'`.
 * Unmount cleanup would run anyway, but the toggle needs to `await`
 * `endActiveSession()` (which aborts SSE) before we trust the engine /
 * chat to be quiescent — fire-and-forget on unmount loses that guarantee.
 */
export interface PlaybackChromeRootHandle {
  /** Ends any active SSE session, stops the engine, cleans up TTS audio. */
  teardown: () => Promise<void>;
}

export interface RevisitPlaybackConfig {
  readonly participants: Participant[];
  readonly headerSlot?: ReactNode;
  readonly canvasOverlay?: ReactNode;
  readonly currentSpeech?: string | null;
  readonly engineMode?: EngineMode;
  readonly isStreaming?: boolean;
  readonly speakingAgentId?: string | null;
  readonly audioIndicatorState?: AudioIndicatorState;
  readonly audioAgentId?: string | null;
  readonly thinkingState?: { stage: string; agentId?: string } | null;
  readonly isCueUser?: boolean;
  readonly cueUserLabel?: string;
  readonly onMessageSend: (message: string) => void | Promise<void>;
  readonly onUserSpeechStateChange?: (active: boolean) => void;
  readonly onPrevScene: () => void;
  readonly onNextScene: () => void;
  readonly onSceneSelect: (sceneId: string) => void;
  readonly onFailedOutlineSelect?: (outlineId: string) => void;
  readonly canGoPrev: boolean;
  readonly canGoNext: boolean;
  readonly sceneStatuses?: Record<string, { passed?: boolean; locked?: boolean }>;
  readonly tailPages?: SceneSidebarTailPage[];
  readonly transcriptSession?: ChatSession;
  readonly transcriptActiveBubbleId?: string | null;
  readonly onExit?: () => void;
}

interface PlaybackChromeRootProps {
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  /** Whether the Pro Switch in Header should be enabled. */
  readonly canEnterProMode?: boolean;
  /** Pro Switch click handler — parent coordinates editLock + teardown. */
  readonly onEnterProMode?: () => void;
  readonly revisitConfig?: RevisitPlaybackConfig;
}

/**
 * PlaybackChromeRoot — owns the entire playback/autonomous chrome and
 * its state. Mounted whenever `mode !== 'edit'`. The Pro Switch in
 * `Header` calls `onEnterProMode`; the parent `Stage` is responsible
 * for calling `ref.teardown()` before unmounting this root so SSE and
 * the engine wind down cleanly.
 */
export const PlaybackChromeRoot = forwardRef<PlaybackChromeRootHandle, PlaybackChromeRootProps>(
  function PlaybackChromeRoot(
    { onRetryOutline, canEnterProMode, onEnterProMode, revisitConfig },
    ref,
  ) {
    const { t } = useI18n();
    const router = useRouter();
    const {
      mode,
      stage,
      getCurrentScene,
      scenes,
      currentSceneId,
      setCurrentSceneId,
      generatingOutlines,
      outlines,
    } = useStageStore();
    const failedOutlines = useStageStore.use.failedOutlines();
    const generationComplete = useStageStore.use.generationComplete();

    const currentScene = getCurrentScene();

    // Layout state from settings store (persisted via localStorage)
    const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
    const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
    const chatAreaWidth = useSettingsStore((s) => s.chatAreaWidth);
    const setChatAreaWidth = useSettingsStore((s) => s.setChatAreaWidth);
    const chatAreaCollapsed = useSettingsStore((s) => s.chatAreaCollapsed);
    const setChatAreaCollapsed = useSettingsStore((s) => s.setChatAreaCollapsed);
    const setTTSMuted = useSettingsStore((s) => s.setTTSMuted);
    const setTTSVolume = useSettingsStore((s) => s.setTTSVolume);
    const activeRevisitDemoSessionId = useSettingsStore((s) => s.activeRevisitDemoSessionId);
    const revisitVirtualClockOffsetHours = useSettingsStore(
      (s) => s.revisitVirtualClockOffsetHours,
    );
    const revisitDataScope = useMemo(
      () => resolveActiveRevisitScope(activeRevisitDemoSessionId),
      [activeRevisitDemoSessionId],
    );
    const [overtimeExtensions, setOvertimeExtensions] = useState<OvertimeExtension[]>([]);
    const [pendingNewCourse, setPendingNewCourse] = useState<{
      request: RequestLearningExtensionParams;
      userPrompt: string;
    } | null>(null);
    const runningOvertimeIdsRef = useRef(new Set<string>());

    // PlaybackEngine state
    const [engineMode, setEngineMode] = useState<EngineMode>('idle');
    const [playbackCompleted, setPlaybackCompleted] = useState(false); // Distinguishes "never played" idle from "finished" idle
    const [lectureSpeech, setLectureSpeech] = useState<string | null>(null); // From PlaybackEngine (lecture)
    const [currentPlaybackActionIndex, setCurrentPlaybackActionIndex] = useState<number | null>(0);
    const [liveSpeech, setLiveSpeech] = useState<string | null>(null); // From buffer (discussion/QA)
    const [speechProgress, setSpeechProgress] = useState<number | null>(null); // StreamBuffer reveal progress (0–1)
    const [discussionTrigger, setDiscussionTrigger] = useState<TriggerEvent | null>(null);

    // Speaking agent tracking (Issue 2)
    const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);

    // Thinking state (Issue 5)
    const [thinkingState, setThinkingState] = useState<{
      stage: string;
      agentId?: string;
    } | null>(null);

    // Cue user state (Issue 7)
    const [isCueUser, setIsCueUser] = useState(false);

    // End flash state (Issue 3)
    const [showEndFlash, setShowEndFlash] = useState(false);
    const [endFlashSessionType, setEndFlashSessionType] = useState<'qa' | 'discussion'>(
      'discussion',
    );

    // Streaming state for stop button (Issue 1)
    const [chatIsStreaming, setChatIsStreaming] = useState(false);
    const [chatSessionType, setChatSessionType] = useState<string | null>(null);

    // Topic pending state: session is soft-paused, bubble stays visible, waiting for user input
    const [isTopicPending, setIsTopicPending] = useState(false);

    // Active bubble ID for playback highlight in chat area (Issue 8)
    const [activeBubbleId, setActiveBubbleId] = useState<string | null>(null);

    // Scene switch confirmation dialog state
    const [pendingSceneId, setPendingSceneId] = useState<string | null>(null);
    const [isPresenting, setIsPresenting] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [isPresentationInteractionActive, setIsPresentationInteractionActive] = useState(false);

    // Whiteboard state (from canvas store so AI tools can open it)
    const whiteboardOpen = useCanvasStore.use.whiteboardOpen();
    const setWhiteboardOpen = useCanvasStore.use.setWhiteboardOpen();

    // Selected agents from settings store (Zustand)
    const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
    const ttsMuted = useSettingsStore((s) => s.ttsMuted);
    const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);

    // Generate participants from selected agents
    const participants = useMemo(
      () => revisitConfig?.participants ?? agentsToParticipants(selectedAgentIds, t),
      [revisitConfig?.participants, selectedAgentIds, t],
    );

    // Resolved AgentConfig array for hooks that need full agent objects
    // Subscribe to the agents record so voiceConfig changes trigger re-resolution
    const agentsRecord = useAgentRegistry((s) => s.agents);
    const selectedAgents = useMemo(
      () =>
        selectedAgentIds.map((id) => agentsRecord[id]).filter((a): a is AgentConfig => a != null),
      [agentsRecord, selectedAgentIds],
    );

    const updateOvertimeExtension = useCallback((extension: OvertimeExtension) => {
      setOvertimeExtensions((current) => {
        const next = [...current.filter((candidate) => candidate.id !== extension.id), extension];
        return next.sort((a, b) => a.sequence - b.sequence);
      });
    }, []);

    const refreshOvertimeExtensions = useCallback(async (stageId: string) => {
      const extensions = await listOvertimeExtensions(stageId);
      if (useStageStore.getState().stage?.id === stageId) setOvertimeExtensions(extensions);
      return extensions;
    }, []);

    useEffect(() => {
      const stageId = stage?.id;
      if (!stageId || revisitConfig) {
        setOvertimeExtensions([]);
        return;
      }
      let active = true;
      void (async () => {
        await markActiveOvertimeExtensionsInterrupted(stageId);
        const extensions = await listOvertimeExtensions(stageId);
        if (active && useStageStore.getState().stage?.id === stageId) {
          setOvertimeExtensions(extensions);
        }
      })().catch((error) => {
        console.error('[Overtime] Failed to restore extension tasks.', error);
      });
      return () => {
        active = false;
      };
    }, [revisitConfig, stage?.id]);

    useEffect(
      () =>
        subscribeOvertimeLearningSignals(({ sceneId, signal }) => {
          if (signal === 'interactive_activity') return;
          const live = useStageStore.getState();
          if (live.currentSceneId !== sceneId) return;
          const scene = live.scenes.find((candidate) => candidate.id === sceneId);
          if (!scene?.overtime) return;
          if (signal === 'quiz_reviewed' && scene.type !== 'quiz') return;
          if (signal === 'pbl_completed' && scene.type !== 'pbl') return;
          markOvertimeSceneLearned(scene);
        }),
      [],
    );

    useEffect(() => {
      const scene = useStageStore.getState().scenes.find((item) => item.id === currentSceneId);
      if (!scene?.overtime || scene.type !== 'interactive' || activeRevisitDemoSessionId) {
        return;
      }

      let engagement: InteractiveEngagement = createInteractiveEngagement(
        Date.now(),
        document.visibilityState === 'visible',
      );
      const advance = (interacted = false) => {
        const wasCompleted = engagement.completed;
        engagement = advanceInteractiveEngagement(engagement, {
          now: Date.now(),
          visible: document.visibilityState === 'visible',
          interacted,
        });
        if (!wasCompleted && engagement.completed) markOvertimeSceneLearned(scene);
      };
      const unsubscribe = subscribeOvertimeLearningSignals((detail) => {
        if (detail.sceneId === scene.id && detail.signal === 'interactive_activity') advance(true);
      });
      const onVisibilityChange = () => advance(false);
      document.addEventListener('visibilitychange', onVisibilityChange);
      const timer = window.setInterval(() => advance(false), 1000);
      return () => {
        window.clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        unsubscribe();
      };
    }, [activeRevisitDemoSessionId, currentSceneId]);

    const runOvertimeTask = useCallback(
      async (extension: OvertimeExtension) => {
        if (runningOvertimeIdsRef.current.has(extension.id)) return;
        const stageState = useStageStore.getState();
        const sourceStage = stageState.stage;
        if (!sourceStage || sourceStage.id !== extension.stageId) return;

        runningOvertimeIdsRef.current.add(extension.id);
        updateOvertimeExtension(extension);
        try {
          const knownConcepts = await listLessonConcepts(sourceStage.id);
          const agents = selectedAgents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            persona: agent.persona,
          }));
          await runOvertimeGeneration({
            extensionId: extension.id,
            stage: sourceStage,
            scenes: stageState.scenes,
            existingOutlines: stageState.outlines,
            knownConcepts,
            agents,
            onProgress: updateOvertimeExtension,
            onReady: (scene, outline) => {
              const live = useStageStore.getState();
              if (live.stage?.id !== extension.stageId) return;
              const merged = mergeReadyOvertimePage({
                scenes: live.scenes,
                outlines: live.outlines,
                scene,
                outline,
              });
              useStageStore.setState({
                scenes: merged.scenes,
                outlines: merged.outlines,
                currentSceneId: scene.id,
                generationComplete: true,
                stage: { ...live.stage, updatedAt: scene.updatedAt ?? Date.now() },
              });
            },
          });
        } catch (error) {
          console.error('[Overtime] Page generation failed.', error);
          toast.error(t('overtime.status.failed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        } finally {
          runningOvertimeIdsRef.current.delete(extension.id);
          await refreshOvertimeExtensions(extension.stageId).catch(() => undefined);
        }
      },
      [refreshOvertimeExtensions, selectedAgents, t, updateOvertimeExtension],
    );

    const startOvertimeAppend = useCallback(
      async (request: RequestLearningExtensionParams, userPrompt: string) => {
        const live = useStageStore.getState();
        if (!live.stage?.id || revisitConfig || activeRevisitDemoSessionId) {
          return;
        }
        const requestedId = crypto.randomUUID();
        const extension = await createOrGetOvertimeExtension({
          id: requestedId,
          stageId: live.stage.id,
          userPrompt: userPrompt || request.topic,
          decision: { ...request, disposition: 'append_page' },
        });
        updateOvertimeExtension(extension);

        if (extension.id !== requestedId) {
          live.setCurrentSceneId(PENDING_SCENE_ID);
          return;
        }
        void runOvertimeTask(extension);
      },
      [activeRevisitDemoSessionId, revisitConfig, runOvertimeTask, updateOvertimeExtension],
    );

    const handleLearningExtensionRequest = useCallback(
      (request: RequestLearningExtensionParams, userPrompt: string) => {
        if (request.disposition === 'new_course') {
          setPendingNewCourse({ request, userPrompt });
          return;
        }
        void startOvertimeAppend(request, userPrompt);
      },
      [startOvertimeAppend],
    );

    const createOvertimeCourse = useCallback(() => {
      const live = useStageStore.getState();
      if (!live.stage || !pendingNewCourse) return;
      const session = buildOvertimeCourseGenerationSession({
        sessionId: crypto.randomUUID(),
        stage: live.stage,
        scenes: live.scenes,
        userPrompt: pendingNewCourse.userPrompt,
        topic: pendingNewCourse.request.topic,
      });
      sessionStorage.setItem('generationSession', JSON.stringify(session));
      setPendingNewCourse(null);
      router.push('/generation-preview');
    }, [pendingNewCourse, router]);

    // Discussion TTS: audio indicator state
    const [audioIndicatorState, setAudioIndicatorState] = useState<AudioIndicatorState>('idle');
    const [audioAgentId, setAudioAgentId] = useState<string | null>(null);

    const discussionTTS = useDiscussionTTS({
      enabled: ttsEnabled && !ttsMuted,
      agents: selectedAgents,
      onAudioStateChange: (agentId, state) => {
        setAudioAgentId(agentId);
        setAudioIndicatorState(state);
      },
    });

    // Pick a student agent for discussion trigger (prioritize student > non-teacher > fallback)
    const pickStudentAgent = useCallback((): string => {
      const registry = useAgentRegistry.getState();
      const agents = selectedAgentIds
        .map((id) => registry.getAgent(id))
        .filter((a): a is AgentConfig => a != null);
      const students = agents.filter((a) => a.role === 'student');
      if (students.length > 0) {
        return students[Math.floor(Math.random() * students.length)].id;
      }
      const nonTeachers = agents.filter((a) => a.role !== 'teacher');
      if (nonTeachers.length > 0) {
        return nonTeachers[Math.floor(Math.random() * nonTeachers.length)].id;
      }
      return agents[0]?.id || 'default-1';
    }, [selectedAgentIds]);

    const engineRef = useRef<PlaybackEngine | null>(null);
    const audioPlayerRef = useRef(createAudioPlayer());
    const chatAreaRef = useRef<ChatAreaRef>(null);
    const lectureSessionIdRef = useRef<string | null>(null);
    const lectureActionCounterRef = useRef(0);
    const currentPlaybackActionIndexRef = useRef<number | null>(currentPlaybackActionIndex);
    const activeSceneIdRef = useRef<string | null>(currentSceneId);
    const discussionAbortRef = useRef<AbortController | null>(null);
    const presentationIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    // Guard to prevent double flash when manual stop triggers onDiscussionEnd
    const manualStopRef = useRef(false);
    const updateCurrentPlaybackActionIndex = useCallback((actionIndex: number | null) => {
      currentPlaybackActionIndexRef.current = actionIndex;
      setCurrentPlaybackActionIndex(actionIndex);
    }, []);

    const actionResumeStorageKey = useMemo(
      () => getActionResumeStorageKey(stage?.id ?? currentScene?.stageId),
      [currentScene?.stageId, stage?.id],
    );

    const saveSceneResumePosition = useCallback(
      (sceneId: string | null | undefined, actionIndex: number | null | undefined) => {
        if (!sceneId || typeof window === 'undefined') return;
        const scene = scenes.find((s) => s.id === sceneId);
        const actions = scene?.actions ?? [];
        if (!scene || actions.length === 0) return;

        if (Number.isInteger(actionIndex) && actionIndex! >= actions.length) {
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }

        const action = Number.isInteger(actionIndex) ? actions[actionIndex!] : null;
        if (action && action.type !== 'speech') {
          const crossedUnsafe = actions
            .slice(0, actionIndex! + 1)
            .some(isUnsafePlaybackNavigationAction);
          if (crossedUnsafe) {
            clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          }
          return;
        }

        const position = createActionResumePosition(actions, actionIndex);
        if (!position) return;
        if (!canJumpWithinReconstructablePrefix(actions, 0, position.actionIndex)) {
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }
        saveActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId, position);
      },
      [actionResumeStorageKey, scenes],
    );

    const clearSceneResumePosition = useCallback(
      (sceneId: string | null | undefined) => {
        if (!sceneId || typeof window === 'undefined') return;
        clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
      },
      [actionResumeStorageKey],
    );
    const lessonPlaybackProgressRef = useRef<{ stageId: string | null; sceneIds: Set<string> }>({
      stageId: null,
      sceneIds: new Set(),
    });
    useEffect(() => {
      if (lessonPlaybackProgressRef.current.stageId === stage?.id) return;
      lessonPlaybackProgressRef.current = { stageId: stage?.id ?? null, sceneIds: new Set() };
    }, [stage?.id]);
    // Monotonic counter incremented on each scene switch — used to discard stale SSE callbacks
    const sceneEpochRef = useRef(0);
    // When true, the next engine init will auto-start playback (for auto-play scene advance)
    const autoStartRef = useRef(false);
    // Discussion buffer-level pause state (distinct from soft-pause which aborts SSE)
    const [isDiscussionPaused, setIsDiscussionPaused] = useState(false);

    /**
     * Resume a soft-paused topic: re-call /chat with existing session messages.
     * The director picks the next agent to continue.
     */
    const doResumeTopic = useCallback(async () => {
      // Clear old bubble immediately — no lingering on interrupted text
      setIsTopicPending(false);
      setLiveSpeech(null);
      setSpeakingAgentId(null);
      setThinkingState({ stage: 'director' });
      setChatIsStreaming(true);
      // Transition engine back to live — onInputActivate paused it when soft-pausing,
      // so we must explicitly resume to keep engine mode in sync with the chat loop.
      engineRef.current?.resume();
      // Fire new chat round — SSE events will drive thinking → agent_start → speech
      await chatAreaRef.current?.resumeActiveSession();
    }, []);

    /** Reset all live/discussion state (shared by doSessionCleanup & onDiscussionEnd) */
    const resetLiveState = useCallback(() => {
      setLiveSpeech(null);
      setSpeakingAgentId(null);
      setSpeechProgress(null);
      setThinkingState(null);
      setIsCueUser(false);
      setIsTopicPending(false);
      setChatIsStreaming(false);
      setChatSessionType(null);
      setIsDiscussionPaused(false);
    }, []);

    /** Full scene reset (scene switch) — resetLiveState + lecture/visual state */
    const resetSceneState = useCallback(
      (initial?: { actionIndex?: number | null; lectureSpeech?: string | null }) => {
        resetLiveState();
        setPlaybackCompleted(false);
        setLectureSpeech(initial?.lectureSpeech ?? null);
        updateCurrentPlaybackActionIndex(initial?.actionIndex ?? 0);
        setSpeechProgress(null);
        setShowEndFlash(false);
        setActiveBubbleId(null);
        setDiscussionTrigger(null);
      },
      [resetLiveState, updateCurrentPlaybackActionIndex],
    );

    /** Request failure should exit live discussion UI without hard-closing the session. */
    const handleLiveSessionError = useCallback(() => {
      engineRef.current?.handleDiscussionError();
      resetLiveState();
      setActiveBubbleId(null);
    }, [resetLiveState]);

    /**
     * Unified session cleanup — called by both roundtable stop button and chat area end button.
     * Handles: engine transition, flash, roundtable state clearing.
     */
    const doSessionCleanup = useCallback(() => {
      const activeType = chatSessionType;

      // Engine cleanup — guard to avoid double flash from onDiscussionEnd
      manualStopRef.current = true;
      engineRef.current?.handleEndDiscussion();
      manualStopRef.current = false;

      // Show end flash with correct session type
      if (activeType === 'qa' || activeType === 'discussion') {
        setEndFlashSessionType(activeType);
        setShowEndFlash(true);
        setTimeout(() => setShowEndFlash(false), 1800);
      }

      // Stop any in-flight discussion TTS audio
      discussionTTS.cleanup();

      resetLiveState();
    }, [chatSessionType, resetLiveState, discussionTTS]);

    // Shared stop-discussion handler (used by both Roundtable and Canvas toolbar)
    const handleStopDiscussion = useCallback(async () => {
      await chatAreaRef.current?.endActiveSession();
      doSessionCleanup();
    }, [doSessionCleanup]);

    // Imperative teardown so the parent can `await` SSE / engine / TTS
    // shutdown before flipping mode to 'edit'. Mirrors what the old in-
    // component `handleToggleEditMode` did, but exposed through ref so
    // the toggle lives one layer up.
    useImperativeHandle(
      ref,
      () => ({
        teardown: async () => {
          await chatAreaRef.current?.endActiveSession();
          if (discussionAbortRef.current) {
            discussionAbortRef.current.abort();
            discussionAbortRef.current = null;
          }
          engineRef.current?.stop();
          discussionTTS.cleanup();
          resetSceneState();
        },
      }),
      [discussionTTS, resetSceneState],
    );

    const clearPresentationIdleTimer = useCallback(() => {
      if (presentationIdleTimerRef.current) {
        clearTimeout(presentationIdleTimerRef.current);
        presentationIdleTimerRef.current = null;
      }
    }, []);

    const resetPresentationIdleTimer = useCallback(() => {
      setControlsVisible(true);
      clearPresentationIdleTimer();
      if (isPresenting && !isPresentationInteractionActive) {
        presentationIdleTimerRef.current = setTimeout(() => {
          setControlsVisible(false);
        }, 3000);
      }
    }, [clearPresentationIdleTimer, isPresenting, isPresentationInteractionActive]);

    const togglePresentation = useCallback(async () => {
      const stageElement = stageRef.current;
      if (!stageElement) return;

      try {
        if (document.fullscreenElement === stageElement) {
          // Unlock Escape key before exiting fullscreen
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          await document.exitFullscreen();
          return;
        }

        setControlsVisible(true);
        await stageElement.requestFullscreen();
        // Lock Escape key so it doesn't auto-exit fullscreen (#255)
        // Escape is handled manually in our keydown handler instead
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (navigator as any).keyboard?.lock?.(['Escape']).catch(() => {});
        setSidebarCollapsed(true);
        setChatAreaCollapsed(true);
      } catch {
        // Firefox may deny fullscreen from certain keyboard events (e.g. F11)
        console.warn('[Presentation] Fullscreen request denied — browser policy');
      }
    }, [setChatAreaCollapsed, setSidebarCollapsed]);

    useEffect(() => {
      const onFullscreenChange = () => {
        const active = document.fullscreenElement === stageRef.current;
        setIsPresenting(active);

        if (!active) {
          // Ensure keyboard unlock on any fullscreen exit
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          setControlsVisible(true);
          clearPresentationIdleTimer();
        }
      };

      document.addEventListener('fullscreenchange', onFullscreenChange);
      return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, [clearPresentationIdleTimer]);

    useEffect(() => {
      if (!isPresenting) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
        return;
      }

      const handleActivity = () => {
        resetPresentationIdleTimer();
      };

      window.addEventListener('mousemove', handleActivity);
      window.addEventListener('mousedown', handleActivity);
      window.addEventListener('touchstart', handleActivity);
      if (isPresentationInteractionActive) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
      } else {
        resetPresentationIdleTimer();
      }

      return () => {
        window.removeEventListener('mousemove', handleActivity);
        window.removeEventListener('mousedown', handleActivity);
        window.removeEventListener('touchstart', handleActivity);
        clearPresentationIdleTimer();
      };
    }, [
      clearPresentationIdleTimer,
      isPresenting,
      isPresentationInteractionActive,
      resetPresentationIdleTimer,
    ]);

    // Initialize playback engine when scene changes
    useEffect(() => {
      const previousSceneId = activeSceneIdRef.current;
      if (previousSceneId && previousSceneId !== currentScene?.id) {
        saveSceneResumePosition(previousSceneId, currentPlaybackActionIndexRef.current);
      }

      // Bump epoch so any stale SSE callbacks from the previous scene are discarded
      sceneEpochRef.current++;

      // End any active QA/discussion session — this synchronously aborts the SSE
      // stream inside use-chat-sessions (abortControllerRef.abort()), preventing
      // stale onLiveSpeech callbacks from leaking into the new scene.
      chatAreaRef.current?.endActiveSession();

      // Also abort the engine-level discussion controller
      if (discussionAbortRef.current) {
        discussionAbortRef.current.abort();
        discussionAbortRef.current = null;
      }

      // Stop any in-flight discussion TTS audio on scene switch
      discussionTTS.cleanup();

      const savedResumeCursor =
        currentScene && typeof window !== 'undefined'
          ? getActionResumeRestoreCursor(
              readActionResumeState(window.sessionStorage, actionResumeStorageKey),
              currentScene.id,
              currentScene.actions ?? [],
            )
          : { actionIndex: 0, position: null };
      const savedResumeAction = currentScene?.actions?.[savedResumeCursor.actionIndex];

      // Reset all roundtable/live state so scenes are fully isolated. Use the
      // saved action cursor immediately so mount/refresh cannot persist the
      // default first-speech cursor before the async engine jump finishes.
      resetSceneState({
        actionIndex: savedResumeCursor.actionIndex,
        lectureSpeech:
          savedResumeAction?.type === 'speech' ? (savedResumeAction as SpeechAction).text : null,
      });

      // A slide scene with no actions is still playable: the engine dwells on it
      // (see resolvePlaybackCursor) so a freshly inserted / emptied blank slide
      // shows for a beat and auto-play advances past it. Non-slide scenes
      // (quiz / interactive / pbl) without timeline actions get no lecture engine
      // as before. Don't touch `autoStartRef` here: in the PENDING_SCENE_ID
      // handoff `currentScene` is null while a pending auto-start legitimately
      // waits for the next generated scene to materialize.
      const hasPlayableActions =
        !!currentScene?.actions &&
        (currentScene.actions.length > 0 || currentScene.type === 'slide');
      if (!currentScene || !hasPlayableActions) {
        engineRef.current = null;
        setEngineMode('idle');
        activeSceneIdRef.current = currentSceneId;

        return;
      }

      // Stop previous engine
      if (engineRef.current) {
        engineRef.current.stop();
      }

      // Widget iframe messaging callback for interactive scenes, resolved lazily
      // at send time (keyed by sceneId). The interactive iframe now lives in the
      // keep-alive host (#619), which registers its postMessage callback a commit
      // after this engine is built — so resolving eagerly here would capture null
      // on a scene's first visit and silently drop every widget action. Looking it
      // up per-send always sees the live registration.
      const sceneIdForWidget = currentScene.id;
      const widgetSendMessage = (type: string, payload: Record<string, unknown>) =>
        useWidgetIframeStore.getState().getSendMessage(sceneIdForWidget)?.(type, payload);

      // Create ActionEngine for playback (with audioPlayer for TTS and widget messaging)
      const actionEngine = new ActionEngine(
        useStageStore,
        audioPlayerRef.current,
        widgetSendMessage,
      );

      const markCurrentScenePlaybackCompleted = () => {
        const stageState = useStageStore.getState();
        if (lessonPlaybackProgressRef.current.stageId !== stageState.stage?.id) {
          lessonPlaybackProgressRef.current = {
            stageId: stageState.stage?.id ?? null,
            sceneIds: new Set(),
          };
        }
        lessonPlaybackProgressRef.current.sceneIds.add(currentScene.id);
      };

      // Create new PlaybackEngine
      const engine = new PlaybackEngine([currentScene], actionEngine, audioPlayerRef.current, {
        onModeChange: (mode) => {
          setEngineMode(mode);
        },
        onProgress: (snapshot) => {
          updateCurrentPlaybackActionIndex(snapshot.actionIndex);
          saveSceneResumePosition(snapshot.sceneId, snapshot.actionIndex);
        },
        onSceneChange: (_sceneId) => {
          // Scene change handled by engine
        },
        onSpeechStart: (text) => {
          setLectureSpeech(text);
          // Add to lecture session with incrementing index for dedup
          // Chat area pacing is handled by the StreamBuffer (onTextReveal)
          if (lectureSessionIdRef.current) {
            const idx = lectureActionCounterRef.current++;
            const speechId = `speech-${Date.now()}`;
            chatAreaRef.current?.addLectureMessage(
              lectureSessionIdRef.current,
              { id: speechId, type: 'speech', text } as Action,
              idx,
            );
            // Track active bubble for highlight (Issue 8)
            const msgId = chatAreaRef.current?.getLectureMessageId(lectureSessionIdRef.current!);
            if (msgId) setActiveBubbleId(msgId);
          }
        },
        onSpeechEnd: () => {
          // Don't clear lectureSpeech — let it persist until the next
          // onSpeechStart replaces it or the scene transitions.
          // Clearing here causes fallback to idleText (first sentence).
          setActiveBubbleId(null);
        },
        onEffectFire: (effect: Effect) => {
          // Add to lecture session with incrementing index
          if (
            lectureSessionIdRef.current &&
            (effect.kind === 'spotlight' || effect.kind === 'laser')
          ) {
            const idx = lectureActionCounterRef.current++;
            chatAreaRef.current?.addLectureMessage(
              lectureSessionIdRef.current,
              {
                id: `${effect.kind}-${Date.now()}`,
                type: effect.kind,
                elementId: effect.targetId,
              } as Action,
              idx,
            );
          }
        },
        onProactiveShow: (trigger) => {
          if (!trigger.agentId) {
            // Mutate in-place so engine.currentTrigger also gets the agentId
            // (confirmDiscussion reads agentId from the same object reference)
            trigger.agentId = pickStudentAgent();
          }
          setDiscussionTrigger(trigger);
        },
        onProactiveHide: () => {
          setDiscussionTrigger(null);
        },
        onDiscussionConfirmed: (topic, prompt, agentId) => {
          // Start SSE discussion via ChatArea
          handleDiscussionSSE(topic, prompt, agentId);
        },
        onDiscussionEnd: () => {
          // Abort any active SSE
          if (discussionAbortRef.current) {
            discussionAbortRef.current.abort();
            discussionAbortRef.current = null;
          }
          setDiscussionTrigger(null);
          // Stop any in-flight discussion TTS audio
          discussionTTS.cleanup();
          // Clear roundtable state (idempotent — may already be cleared by doSessionCleanup)
          resetLiveState();
          // Only show flash for engine-initiated ends (not manual stop — that's handled by doSessionCleanup)
          if (!manualStopRef.current) {
            setEndFlashSessionType('discussion');
            setShowEndFlash(true);
            setTimeout(() => setShowEndFlash(false), 1800);
          }
          // If all actions are exhausted (discussion was the last action), mark
          // playback as completed so the bubble shows reset instead of play.
          if (engineRef.current?.isExhausted()) {
            setPlaybackCompleted(true);
            markCurrentScenePlaybackCompleted();
            if (currentScene.type === 'slide') markOvertimeSceneLearned(currentScene);
          }
        },
        onUserInterrupt: (text) => {
          // User interrupted → start a discussion via chat
          chatAreaRef.current?.sendMessage(text);
        },
        isAgentSelected: (agentId) => {
          const ids = useSettingsStore.getState().selectedAgentIds;
          return ids.includes(agentId);
        },
        getPlaybackSpeed: () => useSettingsStore.getState().playbackSpeed || 1,
        onComplete: () => {
          // lectureSpeech intentionally NOT cleared — last sentence stays visible
          // until scene transition (auto-play) or user restarts. Scene change
          // effect handles the reset.
          updateCurrentPlaybackActionIndex(currentScene.actions?.length ?? 0);
          clearSceneResumePosition(currentScene.id);
          setPlaybackCompleted(true);

          markCurrentScenePlaybackCompleted();
          if (currentScene.type === 'slide') markOvertimeSceneLearned(currentScene);

          // End lecture session on playback complete
          if (lectureSessionIdRef.current) {
            chatAreaRef.current?.endSession(lectureSessionIdRef.current);
            lectureSessionIdRef.current = null;
          }
          // Auto-play: advance to next scene after a short pause
          const { autoPlayLecture } = useSettingsStore.getState();
          if (autoPlayLecture && !revisitConfig) {
            setTimeout(() => {
              const stageState = useStageStore.getState();
              if (!useSettingsStore.getState().autoPlayLecture) return;
              const allScenes = stageState.scenes;
              const curId = stageState.currentSceneId;
              const idx = allScenes.findIndex((s) => s.id === curId);
              if (idx >= 0 && idx < allScenes.length - 1) {
                const currentScene = allScenes[idx];
                if (
                  currentScene.type === 'quiz' ||
                  currentScene.type === 'interactive' ||
                  currentScene.type === 'pbl'
                ) {
                  return;
                }
                autoStartRef.current = true;
                stageState.setCurrentSceneId(allScenes[idx + 1].id);
              } else if (idx === allScenes.length - 1 && stageState.generatingOutlines.length > 0) {
                // Last scene exhausted but next is still generating — go to pending page
                const currentScene = allScenes[idx];
                if (
                  currentScene.type === 'quiz' ||
                  currentScene.type === 'interactive' ||
                  currentScene.type === 'pbl'
                ) {
                  return;
                }
                autoStartRef.current = true;
                stageState.setCurrentSceneId(PENDING_SCENE_ID);
              }
            }, 1500);
          }
        },
      });

      engineRef.current = engine;
      activeSceneIdRef.current = currentScene.id;

      // Auto-start if triggered by auto-play scene advance
      if (autoStartRef.current) {
        autoStartRef.current = false;
        (async () => {
          if (currentScene && chatAreaRef.current) {
            const sessionId = await chatAreaRef.current.startLecture(currentScene.id);
            lectureSessionIdRef.current = sessionId;
            lectureActionCounterRef.current = 0;
          }
          engine.start();
        })();
      } else {
        // Load saved playback state and restore position (but never auto-play).
        const savedPosition = savedResumeCursor.position;
        if (savedPosition && engine.canJumpToAction(savedPosition.actionIndex)) {
          void engine
            .jumpToAction(savedPosition.actionIndex, { autoplay: false })
            .then((restored) => {
              if (!restored || engineRef.current !== engine) return;
              updateCurrentPlaybackActionIndex(savedPosition.actionIndex);
              const action = currentScene.actions?.[savedPosition.actionIndex];
              if (action?.type === 'speech') {
                setLectureSpeech(action.text);
              }
            });
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-run when scene changes, functions are stable refs
    }, [currentScene]);

    // Cleanup on unmount
    useEffect(() => {
      const audioPlayer = audioPlayerRef.current;
      const chatArea = chatAreaRef.current;
      return () => {
        saveSceneResumePosition(activeSceneIdRef.current, currentPlaybackActionIndexRef.current);
        if (engineRef.current) {
          engineRef.current.stop();
        }
        audioPlayer.destroy();
        if (discussionAbortRef.current) {
          discussionAbortRef.current.abort();
        }
        discussionTTS.cleanup();
        chatArea?.endActiveSession();
        clearPresentationIdleTimer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup, clearPresentationIdleTimer is stable
    }, []);

    // Sync mute state from settings store to audioPlayer
    useEffect(() => {
      audioPlayerRef.current.setMuted(ttsMuted);
    }, [ttsMuted]);

    // Sync volume from settings store to audioPlayer
    const ttsVolume = useSettingsStore((s) => s.ttsVolume);
    useEffect(() => {
      if (!ttsMuted) {
        audioPlayerRef.current.setVolume(ttsVolume);
      }
    }, [ttsVolume, ttsMuted]);

    // Sync playback speed to audio player (for live-updating current audio)
    const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
    useEffect(() => {
      audioPlayerRef.current.setPlaybackRate(playbackSpeed);
    }, [playbackSpeed]);

    /**
     * Handle discussion SSE — POST /api/chat and push events to engine
     */
    const handleDiscussionSSE = useCallback(
      async (topic: string, prompt?: string, agentId?: string) => {
        // Start discussion display in ChatArea (lecture speech is preserved independently)
        chatAreaRef.current?.startDiscussion({
          topic,
          prompt,
          agentId: agentId || 'default-1',
        });
        // Auto-switch to chat tab when discussion starts
        chatAreaRef.current?.switchToTab('chat');
        // Immediately mark streaming for synchronized stop button
        setChatIsStreaming(true);
        setChatSessionType('discussion');
        // Optimistic thinking: show thinking dots immediately (same as onMessageSend)
        setThinkingState({ stage: 'director' });
      },
      [],
    );

    // First speech text for idle display (extracted here for playbackView)
    const firstSpeechText = useMemo(
      () =>
        currentScene?.actions?.find((a): a is SpeechAction => a.type === 'speech')?.text ?? null,
      [currentScene],
    );

    // Whether the speaking agent is a student (for bubble role derivation)
    const speakingStudentFlag = useMemo(() => {
      if (!speakingAgentId) return false;
      const agent = useAgentRegistry.getState().getAgent(speakingAgentId);
      return agent?.role !== 'teacher';
    }, [speakingAgentId]);

    // Centralised derived playback view
    const playbackView = useMemo(
      () =>
        computePlaybackView({
          engineMode,
          lectureSpeech,
          liveSpeech,
          speakingAgentId,
          thinkingState,
          isCueUser,
          isTopicPending,
          chatIsStreaming,
          discussionTrigger,
          playbackCompleted,
          idleText: firstSpeechText,
          speakingStudent: speakingStudentFlag,
          sessionType: chatSessionType,
        }),
      [
        engineMode,
        lectureSpeech,
        liveSpeech,
        speakingAgentId,
        thinkingState,
        isCueUser,
        isTopicPending,
        chatIsStreaming,
        discussionTrigger,
        playbackCompleted,
        firstSpeechText,
        speakingStudentFlag,
        chatSessionType,
      ],
    );

    const isTopicActive = playbackView.isTopicActive;

    /**
     * Gated scene switch — if a topic is active, show AlertDialog before switching.
     * Returns true if the switch was immediate, false if gated (dialog shown).
     */
    const gatedSceneSwitch = useCallback(
      (targetSceneId: string): boolean => {
        if (targetSceneId === currentSceneId) return false;
        if (revisitConfig) {
          revisitConfig.onSceneSelect(targetSceneId);
          return true;
        }
        if (isTopicActive) {
          setPendingSceneId(targetSceneId);
          return false;
        }
        setCurrentSceneId(targetSceneId);
        return true;
      },
      [currentSceneId, isTopicActive, revisitConfig, setCurrentSceneId],
    );

    /** User confirmed scene switch via AlertDialog */
    const confirmSceneSwitch = useCallback(() => {
      if (!pendingSceneId) return;
      chatAreaRef.current?.endActiveSession();
      doSessionCleanup();
      setCurrentSceneId(pendingSceneId);
      setPendingSceneId(null);
    }, [pendingSceneId, setCurrentSceneId, doSessionCleanup]);

    /** User cancelled scene switch via AlertDialog */
    const cancelSceneSwitch = useCallback(() => {
      setPendingSceneId(null);
    }, []);

    // play/pause toggle
    const handlePlayPause = useCallback(async () => {
      const engine = engineRef.current;
      if (!engine) return;

      const mode = engine.getMode();
      if (mode === 'playing' || mode === 'live') {
        saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
        engine.pause();
        // Pause lecture buffer so text stops immediately
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.pauseBuffer(lectureSessionIdRef.current);
        }
      } else if (mode === 'paused') {
        engine.resume();
        // Resume lecture buffer
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.resumeBuffer(lectureSessionIdRef.current);
        }
      } else {
        const wasCompleted = playbackCompleted;
        setPlaybackCompleted(false);
        // Starting playback - create/reuse lecture session
        if (currentScene && chatAreaRef.current) {
          const sessionId = await chatAreaRef.current.startLecture(currentScene.id);
          lectureSessionIdRef.current = sessionId;
        }
        if (wasCompleted) {
          // Restart from beginning (user clicked restart after completion)
          lectureActionCounterRef.current = 0;
          engine.start();
        } else {
          // Continue from current position (e.g. after discussion end)
          engine.continuePlayback();
        }
      }
    }, [playbackCompleted, currentScene, saveSceneResumePosition]);

    // get scene information
    const isPendingScene = currentSceneId === PENDING_SCENE_ID;
    const currentTailPage = revisitConfig?.tailPages?.find((page) => page.id === currentSceneId);
    const hasNextPending = generatingOutlines.length > 0;
    // True when every outline has materialized into a scene and nothing is
    // currently generating — signals the classroom has finished and the user
    // can see a completion page. Comparing scenes.length === outlines.length
    // (rather than just `scenes.length > 0`) means a partial generation with
    // some failed outlines does not falsely trigger completion. The persisted
    // generationComplete flag also marks completion directly, so an edited
    // finished deck (e.g. a deleted slide, leaving outlines.length > scenes)
    // still reads as complete.
    const isCourseComplete =
      generationComplete ||
      (outlines.length > 0 && scenes.length === outlines.length && generatingOutlines.length === 0);
    const activeOvertimeExtension = overtimeExtensions.find(
      (extension) => extension.status !== 'ready',
    );
    const canAdvanceToPendingSlot = hasNextPending || isCourseComplete;
    const completionVisible = !revisitConfig && isPendingScene && isCourseComplete;
    const playbackSceneIds = useMemo(
      () =>
        scenes
          .filter(
            (scene) =>
              Boolean(scene.actions) &&
              ((scene.actions?.length ?? 0) > 0 || scene.type === 'slide'),
          )
          .map((scene) => scene.id),
      [scenes],
    );

    useEffect(() => {
      if (
        !stage?.id ||
        !shouldRecordLessonPlaybackCompletion({
          sceneIds: playbackSceneIds,
          completedSceneIds: Array.from(lessonPlaybackProgressRef.current.sceneIds),
          reachedCourseEnd: completionVisible,
          materializedSceneCount: scenes.length,
          outlineCount: outlines.length,
          generatingOutlineCount: generatingOutlines.length,
          generationComplete,
          isRevisit: Boolean(revisitConfig),
        })
      ) {
        return;
      }
      void recordLessonCompleted(
        stage.id,
        Date.now() + revisitVirtualClockOffsetHours * 60 * 60 * 1000,
        revisitDataScope,
      ).catch(() => {
        // Spiral metadata must not disrupt the original playback experience.
      });
    }, [
      completionVisible,
      generationComplete,
      generatingOutlines.length,
      outlines.length,
      playbackSceneIds,
      revisitConfig,
      revisitDataScope,
      revisitVirtualClockOffsetHours,
      scenes.length,
      stage?.id,
    ]);

    // previous scene (gated)
    const handlePreviousScene = useCallback(() => {
      if (revisitConfig) {
        revisitConfig.onPrevScene();
        return;
      }
      if (isPendingScene) {
        // From pending page → go to last real scene
        if (scenes.length > 0) {
          gatedSceneSwitch(scenes[scenes.length - 1].id);
        }
        return;
      }
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex > 0) {
        gatedSceneSwitch(scenes[currentIndex - 1].id);
      }
    }, [currentSceneId, gatedSceneSwitch, isPendingScene, revisitConfig, scenes]);

    // next scene (gated)
    const handleNextScene = useCallback(() => {
      if (revisitConfig) {
        revisitConfig.onNextScene();
        return;
      }
      if (isPendingScene) return; // Already on pending, nowhere to go
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex < scenes.length - 1) {
        gatedSceneSwitch(scenes[currentIndex + 1].id);
      } else if (canAdvanceToPendingSlot) {
        // On last real scene → advance to pending slot (generating or completion page)
        setCurrentSceneId(PENDING_SCENE_ID);
      }
    }, [
      currentSceneId,
      gatedSceneSwitch,
      canAdvanceToPendingSlot,
      isPendingScene,
      revisitConfig,
      scenes,
      setCurrentSceneId,
    ]);

    const currentSceneIndex = currentTailPage
      ? scenes.length + (revisitConfig?.tailPages?.indexOf(currentTailPage) ?? 0)
      : isPendingScene
        ? scenes.length
        : scenes.findIndex((s) => s.id === currentSceneId);
    const totalScenesCount = revisitConfig?.tailPages
      ? scenes.length + revisitConfig.tailPages.length
      : scenes.length + (canAdvanceToPendingSlot ? 1 : 0);

    // get action information
    const totalActions = currentScene?.actions?.length || 0;
    const canJumpToAction = useCallback(
      (sceneId: string, actionIndex: number): boolean => {
        if (sceneId !== currentSceneId) return false;
        return canJumpWithinReconstructablePrefix(
          currentScene?.actions ?? [],
          currentPlaybackActionIndex,
          actionIndex,
        );
      },
      [currentPlaybackActionIndex, currentScene?.actions, currentSceneId],
    );

    const handleJumpToAction = useCallback(
      async (sceneId: string, actionIndex: number) => {
        const engine = engineRef.current;
        if (!engine || sceneId !== currentSceneId || !currentScene) return;
        const autoplay = engine.getMode() === 'playing';
        const jumped = await engine.jumpToAction(actionIndex, { autoplay });
        if (!jumped) return;
        setPlaybackCompleted(false);
        updateCurrentPlaybackActionIndex(actionIndex);
        const action = currentScene.actions?.[actionIndex];
        if (action?.type === 'speech') {
          setLectureSpeech(action.text);
        }
      },
      [currentScene, currentSceneId, updateCurrentPlaybackActionIndex],
    );

    // whiteboard toggle
    const handleWhiteboardToggle = () => {
      setWhiteboardOpen(!whiteboardOpen);
    };

    const isPresentationShortcutTarget = useCallback((target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;

      if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
        return true;
      }

      return (
        target.closest(
          ['input', 'textarea', 'select', '[role="slider"]', 'input[type="range"]'].join(', '),
        ) !== null
      );
    }, []);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        // Let modifier-key combos (Ctrl+C, Ctrl+S, etc.) pass through to the browser
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          isPresentationShortcutTarget(event.target) ||
          isPresentationShortcutTarget(document.activeElement)
        ) {
          return;
        }

        switch (event.key) {
          case 'ArrowLeft':
            if (!isPresenting) return;
            event.preventDefault();
            handlePreviousScene();
            resetPresentationIdleTimer();
            break;
          case 'ArrowRight':
            if (!isPresenting) return;
            event.preventDefault();
            handleNextScene();
            resetPresentationIdleTimer();
            break;
          case ' ':
          case 'Spacebar':
            if (revisitConfig) break;
            // During active QA/discussion, Roundtable owns Space for
            // buffer-level pause/resume — don't also fire engine play/pause.
            if (chatSessionType === 'qa' || chatSessionType === 'discussion') break;
            event.preventDefault();
            handlePlayPause();
            break;
          case 'Escape':
            // With keyboard.lock(), Escape no longer auto-exits fullscreen.
            // If panels are open, roundtable handles Escape (close panels).
            // If no panels are open, manually exit fullscreen.
            if (isPresenting && !isPresentationInteractionActive) {
              event.preventDefault();
              togglePresentation();
            }
            break;
          case 'ArrowUp':
            event.preventDefault();
            setTTSVolume(ttsVolume + 0.1);
            break;
          case 'ArrowDown':
            event.preventDefault();
            setTTSVolume(ttsVolume - 0.1);
            break;
          case 'm':
          case 'M':
            event.preventDefault();
            setTTSMuted(!ttsMuted);
            break;
          case 's':
          case 'S':
            event.preventDefault();
            setSidebarCollapsed(!sidebarCollapsed);
            break;
          case 'c':
          case 'C':
            event.preventDefault();
            setChatAreaCollapsed(!chatAreaCollapsed);
            break;
          default:
            break;
        }
      };

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [
      chatSessionType,
      chatAreaCollapsed,
      handleNextScene,
      handlePlayPause,
      handlePreviousScene,
      isPresenting,
      isPresentationInteractionActive,
      isPresentationShortcutTarget,
      resetPresentationIdleTimer,
      revisitConfig,
      setChatAreaCollapsed,
      setSidebarCollapsed,
      setTTSMuted,
      setTTSVolume,
      sidebarCollapsed,
      togglePresentation,
      ttsMuted,
      ttsVolume,
    ]);

    // Intercept F11 to use our presentation fullscreen instead of browser fullscreen
    // This way ESC can exit fullscreen (browser F11 fullscreen requires F11 to exit)
    useEffect(() => {
      const onF11 = (event: KeyboardEvent) => {
        if (event.key === 'F11') {
          event.preventDefault();
          togglePresentation();
        }
      };

      window.addEventListener('keydown', onF11);
      return () => window.removeEventListener('keydown', onF11);
    }, [togglePresentation]);

    // Map engine mode to the CanvasArea's expected engine state
    const canvasEngineState = (() => {
      switch (engineMode) {
        case 'playing':
        case 'live':
          return 'playing';
        case 'paused':
          return 'paused';
        default:
          return 'idle';
      }
    })();

    // Build discussion request for Roundtable ProactiveCard from trigger
    const discussionRequest: DiscussionAction | null = discussionTrigger
      ? {
          type: 'discussion',
          id: discussionTrigger.id,
          topic: discussionTrigger.question,
          prompt: discussionTrigger.prompt,
          agentId: discussionTrigger.agentId || 'default-1',
        }
      : null;

    // Scene viewer height — header is 80px when visible, roundtable is
    // 192px in playback mode (autonomous hides it). Mode is guaranteed
    // non-'edit' here since the parent Stage unmounts this component
    // when entering Pro mode.
    const sceneViewerHeight = (() => {
      const headerHeight = isPresenting ? 0 : 80;
      const roundtableHeight = mode === 'playback' && !isPresenting ? 192 : 0;
      return `calc(100% - ${headerHeight + roundtableHeight}px)`;
    })();

    return (
      <div
        ref={stageRef}
        className={cn(
          'flex-1 flex overflow-hidden bg-gray-50 dark:bg-gray-900',
          isPresenting && !controlsVisible && 'cursor-none',
        )}
      >
        <SceneSidebar
          collapsed={sidebarCollapsed}
          onCollapseChange={setSidebarCollapsed}
          onSceneSelect={gatedSceneSwitch}
          onFailedOutlineSelect={revisitConfig?.onFailedOutlineSelect}
          onRetryOutline={onRetryOutline}
          isCourseComplete={isCourseComplete}
          sceneStatuses={revisitConfig?.sceneStatuses}
          tailPages={revisitConfig?.tailPages}
          overtimeExtensions={revisitConfig ? [] : overtimeExtensions}
          onRetryOvertime={(extension) => runOvertimeTask(extension)}
        />

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
          {/* Header — playback only. The Pro Switch fires `onEnterProMode`
            (passed by the parent Stage) which acquires the cross-tab
            edit lock and then awaits our `teardown()` before flipping
            mode to 'edit'. */}
          {!isPresenting && (
            <Header
              currentSceneTitle={
                currentTailPage?.title ||
                currentScene?.title ||
                (isCourseComplete && isPendingScene ? t('stage.courseComplete') : '')
              }
              mode={mode}
              canEdit={!!canEnterProMode && !revisitConfig}
              onToggleEditMode={onEnterProMode}
              rightSlot={revisitConfig?.headerSlot}
              onBack={revisitConfig?.onExit}
            />
          )}

          {/* Canvas Area — playback-only renderer. The parent Stage swaps
            this whole PlaybackChromeRoot out when entering edit mode, so
            no inline branching is needed here. */}
          <div
            className="overflow-hidden relative flex-1 min-h-0 isolate"
            style={{
              height: sceneViewerHeight,
            }}
            suppressHydrationWarning
          >
            <CanvasArea
              currentScene={currentScene}
              currentSceneIndex={currentSceneIndex}
              scenesCount={totalScenesCount}
              mode={mode}
              engineState={canvasEngineState}
              isLiveSession={
                revisitConfig
                  ? !!revisitConfig.isStreaming
                  : chatIsStreaming || isTopicPending || engineMode === 'live' || !!chatSessionType
              }
              whiteboardOpen={whiteboardOpen}
              sidebarCollapsed={sidebarCollapsed}
              chatCollapsed={chatAreaCollapsed}
              onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
              onToggleChat={
                revisitConfig && !revisitConfig.transcriptSession
                  ? undefined
                  : () => setChatAreaCollapsed(!chatAreaCollapsed)
              }
              onPrevSlide={handlePreviousScene}
              onNextSlide={handleNextScene}
              canGoPrevOverride={revisitConfig?.canGoPrev}
              canGoNextOverride={revisitConfig?.canGoNext}
              onPlayPause={handlePlayPause}
              onWhiteboardClose={handleWhiteboardToggle}
              isPresenting={isPresenting}
              onTogglePresentation={togglePresentation}
              showStopDiscussion={
                !revisitConfig &&
                (engineMode === 'live' ||
                  (chatIsStreaming &&
                    (chatSessionType === 'qa' || chatSessionType === 'discussion')))
              }
              onStopDiscussion={handleStopDiscussion}
              hideToolbar={mode === 'playback' || (isPresenting && !controlsVisible)}
              isPendingScene={isPendingScene}
              isCourseComplete={isCourseComplete}
              isGenerationFailed={
                isPendingScene && failedOutlines.some((f) => f.id === generatingOutlines[0]?.id)
              }
              onRetryGeneration={
                onRetryOutline && generatingOutlines[0]
                  ? () => onRetryOutline(generatingOutlines[0].id)
                  : undefined
              }
              overlay={revisitConfig?.canvasOverlay}
              hidePlaybackControls={Boolean(revisitConfig)}
            />
          </div>

          {!revisitConfig && isPendingScene && activeOvertimeExtension && (
            <div
              className={cn(
                'absolute left-1/2 z-[130] -translate-x-1/2 max-w-[calc(100%-2rem)] rounded-xl border border-cyan-200/80 dark:border-cyan-800/70 bg-white/90 dark:bg-slate-900/90 px-4 py-3 shadow-xl backdrop-blur-xl flex items-center gap-3',
                isPresenting ? 'top-6' : 'top-24',
              )}
            >
              {activeOvertimeExtension.status === 'failed' ||
              activeOvertimeExtension.status === 'interrupted' ? (
                <AlertTriangle className="w-5 h-5 shrink-0 text-amber-500" />
              ) : (
                <LoaderCircle className="w-5 h-5 shrink-0 animate-spin text-cyan-600 dark:text-cyan-400" />
              )}
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {activeOvertimeExtension.decision.topic}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {activeOvertimeExtension.status === 'failed'
                    ? t('overtime.status.failed')
                    : activeOvertimeExtension.status === 'interrupted'
                      ? t('overtime.status.interrupted')
                      : t(`overtime.phase.${activeOvertimeExtension.phase}`)}
                </div>
              </div>
              {(activeOvertimeExtension.status === 'failed' ||
                activeOvertimeExtension.status === 'interrupted') && (
                <button
                  type="button"
                  onClick={() => void runOvertimeTask(activeOvertimeExtension)}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('overtime.retry')}
                </button>
              )}
            </div>
          )}

          {/* Roundtable Area */}
          {mode === 'playback' && (
            <div
              className={cn(
                'transition-opacity duration-300',
                !isPresenting && 'shrink-0',
                isPresenting && 'absolute inset-x-0 bottom-0 z-20',
              )}
            >
              <Roundtable
                mode={mode}
                initialParticipants={participants}
                playbackView={revisitConfig ? undefined : playbackView}
                currentSpeech={revisitConfig ? revisitConfig.currentSpeech : liveSpeech}
                lectureSpeech={revisitConfig ? null : lectureSpeech}
                idleText={revisitConfig ? null : firstSpeechText}
                playbackCompleted={revisitConfig ? false : playbackCompleted}
                discussionRequest={revisitConfig ? null : discussionRequest}
                engineMode={revisitConfig?.engineMode ?? engineMode}
                isStreaming={revisitConfig?.isStreaming ?? chatIsStreaming}
                audioIndicatorState={revisitConfig?.audioIndicatorState ?? audioIndicatorState}
                audioAgentId={revisitConfig?.audioAgentId ?? audioAgentId}
                sessionType={
                  revisitConfig
                    ? 'qa'
                    : chatSessionType === 'qa'
                      ? 'qa'
                      : chatSessionType === 'discussion'
                        ? 'discussion'
                        : undefined
                }
                speakingAgentId={revisitConfig?.speakingAgentId ?? speakingAgentId}
                speechProgress={revisitConfig ? null : speechProgress}
                showEndFlash={revisitConfig ? false : showEndFlash}
                endFlashSessionType={endFlashSessionType}
                thinkingState={revisitConfig?.thinkingState ?? thinkingState}
                isCueUser={revisitConfig ? !!revisitConfig.isCueUser : isCueUser}
                cueUserLabel={revisitConfig?.cueUserLabel}
                isTopicPending={revisitConfig ? false : isTopicPending}
                onUserSpeechStateChange={revisitConfig?.onUserSpeechStateChange}
                onMessageSend={async (msg) => {
                  if (revisitConfig) {
                    await revisitConfig.onMessageSend(msg);
                    return;
                  }
                  // Always clear Level-1 pause state — the closure may hold a stale
                  // isDiscussionPaused value (e.g. voice input's onTranscription callback
                  // captures onMessageSend before React re-renders with the updated state).
                  setIsDiscussionPaused(false);
                  // Clear the sticky livePausedRef so the next agent-loop buffer
                  // starts unpaused. (pauseActiveLiveBuffer sets a ref that new
                  // buffers inherit — must be cleared before sendMessage creates one.)
                  chatAreaRef.current?.resumeActiveLiveBuffer();
                  // Flush any buffered / in-flight TTS audio from the previous
                  // agent turn so it doesn't leak into the next round.
                  discussionTTS.cleanup();
                  // Clear soft-paused state — user is continuing the topic
                  if (isTopicPending) {
                    setIsTopicPending(false);
                    setLiveSpeech(null);
                    setSpeakingAgentId(null);
                  }
                  // User interrupts during playback — handleUserInterrupt triggers
                  // onUserInterrupt callback which already calls sendMessage, so skip
                  // the direct sendMessage below to avoid sending twice.
                  // Include 'paused' because onInputActivate pauses the engine before
                  // the user finishes typing — without this the interrupt position
                  // would never be saved and resuming after QA skips to the next sentence.
                  if (
                    engineRef.current &&
                    (engineMode === 'playing' || engineMode === 'live' || engineMode === 'paused')
                  ) {
                    engineRef.current.handleUserInterrupt(msg);
                  } else {
                    chatAreaRef.current?.sendMessage(msg);
                  }
                  // Auto-switch to chat tab when user sends a message
                  chatAreaRef.current?.switchToTab('chat');
                  setIsCueUser(false);
                  // Immediately mark streaming for synchronized stop button
                  setChatIsStreaming(true);
                  setChatSessionType(chatSessionType || 'qa');
                  // Optimistic thinking: show thinking dots immediately so there's
                  // no blank gap between userMessage expiry and the SSE thinking event.
                  // The real SSE event will overwrite this with the same or updated value.
                  setThinkingState({ stage: 'director' });
                }}
                onDiscussionStart={() => {
                  // User clicks "Join" on ProactiveCard
                  engineRef.current?.confirmDiscussion();
                }}
                onDiscussionSkip={() => {
                  // User clicks "Skip" on ProactiveCard
                  engineRef.current?.skipDiscussion();
                }}
                onStopDiscussion={handleStopDiscussion}
                showStopDiscussionOverride={revisitConfig ? false : undefined}
                onInputActivate={() => {
                  // Level-1 pause: freeze buffer tick + TTS audio while SSE keeps buffering.
                  // User resumes manually via Space / pause button after closing the input.
                  // No isDiscussionPaused guard — always attempt to pause the buffer.
                  // The return value ensures UI state stays in sync with buffer state.
                  if (chatSessionType === 'qa' || chatSessionType === 'discussion') {
                    const paused = chatAreaRef.current?.pauseActiveLiveBuffer();
                    if (paused) {
                      discussionTTS.pause();
                      setIsDiscussionPaused(true);
                    }
                  }
                  // Also pause playback engine
                  if (engineRef.current && (engineMode === 'playing' || engineMode === 'live')) {
                    engineRef.current.pause();
                  }
                }}
                onResumeTopic={doResumeTopic}
                onPlayPause={handlePlayPause}
                isDiscussionPaused={isDiscussionPaused}
                onDiscussionPause={() => {
                  const paused = chatAreaRef.current?.pauseActiveLiveBuffer();
                  if (paused) {
                    discussionTTS.pause();
                    setIsDiscussionPaused(true);
                  }
                }}
                onDiscussionResume={() => {
                  chatAreaRef.current?.resumeActiveLiveBuffer();
                  discussionTTS.resume();
                  setIsDiscussionPaused(false);
                }}
                totalActions={totalActions}
                currentActionIndex={currentPlaybackActionIndex ?? 0}
                currentSceneIndex={currentSceneIndex}
                scenesCount={totalScenesCount}
                whiteboardOpen={whiteboardOpen}
                sidebarCollapsed={sidebarCollapsed}
                chatCollapsed={chatAreaCollapsed}
                onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
                onToggleChat={
                  revisitConfig && !revisitConfig.transcriptSession
                    ? undefined
                    : () => setChatAreaCollapsed(!chatAreaCollapsed)
                }
                onPrevSlide={handlePreviousScene}
                onNextSlide={handleNextScene}
                canGoPrevOverride={revisitConfig?.canGoPrev}
                canGoNextOverride={revisitConfig?.canGoNext}
                onWhiteboardClose={handleWhiteboardToggle}
                isPresenting={isPresenting}
                controlsVisible={controlsVisible}
                onTogglePresentation={togglePresentation}
                onPresentationInteractionChange={setIsPresentationInteractionActive}
                hidePlaybackControls={Boolean(revisitConfig)}
                fullscreenContainerRef={stageRef}
              />
            </div>
          )}
        </div>

        {revisitConfig?.transcriptSession ? (
          <div className="flex shrink-0">
            <RevisitTranscriptArea
              width={chatAreaWidth}
              collapsed={chatAreaCollapsed}
              onCollapseChange={setChatAreaCollapsed}
              session={revisitConfig.transcriptSession}
              isStreaming={!!revisitConfig.isStreaming}
              activeBubbleId={revisitConfig.transcriptActiveBubbleId}
            />
          </div>
        ) : !revisitConfig ? (
          <div className="flex shrink-0">
            <ChatArea
              ref={chatAreaRef}
              width={chatAreaWidth}
              onWidthChange={setChatAreaWidth}
              collapsed={chatAreaCollapsed}
              onCollapseChange={setChatAreaCollapsed}
              activeBubbleId={activeBubbleId}
              onActiveBubble={(id) => setActiveBubbleId(id)}
              currentSceneId={currentSceneId}
              currentActionIndex={currentPlaybackActionIndex}
              canJumpToAction={canJumpToAction}
              onJumpToAction={(sceneId, actionIndex) => {
                void handleJumpToAction(sceneId, actionIndex);
              }}
              onLearningExtensionRequest={handleLearningExtensionRequest}
              onLiveSpeech={(text, agentId) => {
                // Capture epoch at call time — discard if scene has changed since
                const epoch = sceneEpochRef.current;
                // Use queueMicrotask to let any pending scene-switch reset settle first
                queueMicrotask(() => {
                  if (sceneEpochRef.current !== epoch) return; // stale — scene changed
                  setLiveSpeech(text);
                  if (agentId !== undefined) {
                    setSpeakingAgentId(agentId);
                  }
                  if (text !== null || agentId) {
                    setChatIsStreaming(true);
                    setChatSessionType(chatAreaRef.current?.getActiveSessionType?.() ?? null);
                    setIsTopicPending(false);
                  } else if (text === null && agentId === null) {
                    setChatIsStreaming(false);
                    // Don't clear chatSessionType here — it's needed by the stop
                    // button when director cues user (cue_user → done → liveSpeech null).
                    // It gets properly cleared in doSessionCleanup and scene change.
                  }
                });
              }}
              onSpeechProgress={(ratio) => {
                const epoch = sceneEpochRef.current;
                queueMicrotask(() => {
                  if (sceneEpochRef.current !== epoch) return;
                  setSpeechProgress(ratio);
                });
              }}
              onThinking={(state) => {
                const epoch = sceneEpochRef.current;
                queueMicrotask(() => {
                  if (sceneEpochRef.current !== epoch) return;
                  setThinkingState(state);
                });
              }}
              onCueUser={(_fromAgentId, _prompt) => {
                setIsCueUser(true);
              }}
              onLiveSessionError={handleLiveSessionError}
              onStopSession={doSessionCleanup}
              onSegmentSealed={discussionTTS.handleSegmentSealed}
              shouldHoldAfterReveal={discussionTTS.shouldHold}
            />
          </div>
        ) : null}

        {/* Scene switch confirmation dialog */}
        <AlertDialog
          open={!!pendingSceneId}
          onOpenChange={(open) => {
            if (!open) cancelSceneSwitch();
          }}
        >
          <AlertDialogContent
            container={isPresenting ? stageRef.current : undefined}
            className="max-w-sm rounded-2xl p-0 overflow-hidden border-0 shadow-[0_25px_60px_-12px_rgba(0,0,0,0.15)] dark:shadow-[0_25px_60px_-12px_rgba(0,0,0,0.5)]"
          >
            <VisuallyHidden.Root>
              <AlertDialogTitle>{t('stage.confirmSwitchTitle')}</AlertDialogTitle>
            </VisuallyHidden.Root>
            {/* Top accent bar */}
            <div className="h-1 bg-gradient-to-r from-amber-400 via-orange-400 to-red-400" />

            <div className="px-6 pt-5 pb-2 flex flex-col items-center text-center">
              {/* Icon */}
              <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mb-4 ring-1 ring-amber-200/50 dark:ring-amber-700/30">
                <AlertTriangle className="w-6 h-6 text-amber-500 dark:text-amber-400" />
              </div>
              {/* Title */}
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1.5">
                {t('stage.confirmSwitchTitle')}
              </h3>
              {/* Description */}
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                {t('stage.confirmSwitchMessage')}
              </p>
            </div>

            <AlertDialogFooter className="px-6 pb-5 pt-3 flex-row gap-3">
              <AlertDialogCancel onClick={cancelSceneSwitch} className="flex-1 rounded-xl">
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmSceneSwitch}
                className="flex-1 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0 shadow-md shadow-amber-200/50 dark:shadow-amber-900/30"
              >
                {t('common.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={!!pendingNewCourse}
          onOpenChange={(open) => {
            if (!open) setPendingNewCourse(null);
          }}
        >
          <AlertDialogContent
            container={isPresenting ? stageRef.current : undefined}
            className="max-w-md rounded-2xl border border-slate-200/80 dark:border-slate-700/80 bg-white/95 dark:bg-slate-900/95 shadow-2xl backdrop-blur-xl"
          >
            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 flex items-center justify-center shrink-0">
                <BookOpenCheck className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <AlertDialogTitle className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  {t('overtime.newCourse.title')}
                </AlertDialogTitle>
                <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                  {t('overtime.newCourse.description')}
                </p>
                {pendingNewCourse && (
                  <p className="mt-3 rounded-lg bg-slate-100/80 dark:bg-slate-800/80 px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                    {pendingNewCourse.request.topic}
                  </p>
                )}
              </div>
            </div>
            <AlertDialogFooter className="mt-2 gap-2 sm:gap-2">
              <AlertDialogCancel
                onClick={() => {
                  const pending = pendingNewCourse;
                  setPendingNewCourse(null);
                  if (pending) {
                    void startOvertimeAppend(
                      { ...pending.request, disposition: 'append_page' },
                      pending.userPrompt,
                    );
                  }
                }}
              >
                {t('overtime.newCourse.stay')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={createOvertimeCourse}
                className="bg-purple-600 text-white hover:bg-purple-500"
              >
                {t('overtime.newCourse.create')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  },
);
