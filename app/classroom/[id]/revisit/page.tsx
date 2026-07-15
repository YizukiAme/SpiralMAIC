'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, GraduationCap, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Stage as ClassroomStage } from '@/components/stage';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import {
  ensureRevisitBlueprint,
  ensureRevisitSkeletonDeck,
  submitRevisitAttempt,
} from '@/lib/revisit/client';
import { runRevisitAgentLoop } from '@/lib/revisit/chat-loop';
import { buildRevisitSkeletonOutlines } from '@/lib/revisit/slides';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { GeneratingProgress } from '@/components/generation/generating-progress';
import {
  buildRevisitSceneStatuses,
  buildRevisitChatSession,
  canNavigateRevisitPage,
  createAssistantRevisitMessage,
  createRevisitChatRequest,
  createTeacherRevisitMessage,
  getRevisitCueUserLabelKey,
  getRevisitStudentStatusEmoji,
  REVISIT_PAGE_PROBE_CAP,
  reduceRevisitCueUserPrompt,
  revisitMessagesToUiMessages,
  resolveRevisitAgentIds,
  type RevisitAgentIds,
  type RevisitCueUserPrompt,
  type RevisitMessage,
  type RevisitSessionPageState,
} from '@/lib/revisit/session';
import type {
  RevisitExamBlueprint,
  RevisitGateDecision,
  RevisitJudgeReport,
  RevisitPageReport,
} from '@/lib/revisit/types';
import type { DirectorState, StatelessChatRequest } from '@/lib/types/chat';
import type { Scene, Stage as StageModel } from '@/lib/types/stage';
import { loadStageData } from '@/lib/utils/stage-storage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { Participant } from '@/lib/types/roundtable';
import { USER_AVATAR } from '@/lib/types/roundtable';

interface LoadedClassroom {
  stage: StageModel;
  scenes: Scene[];
}

type LoadState = 'loading' | 'ready' | 'error';
type SkeletonLoadState = 'idle' | 'generating' | 'ready' | 'error';

export default function RevisitChallengePage() {
  const params = useParams();
  const router = useRouter();
  const classroomId = params?.id as string;
  const { t } = useI18n();
  const reverseChallengeEnabled = useSettingsStore((s) => s.reverseChallengeEnabled);
  const stableSuccessesRequired = useSettingsStore((s) => s.stableSuccessesRequired);
  const forgettingSpeedMultiplier = useSettingsStore((s) => s.forgettingSpeedMultiplier);
  const demoGateSkipEnabled = useSettingsStore((s) => s.demoGateSkipEnabled);
  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);
  const agentsRecord = useAgentRegistry((s) => s.agents);

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadRetryKey, setLoadRetryKey] = useState(0);
  const [classroom, setClassroom] = useState<LoadedClassroom | null>(null);
  const [blueprint, setBlueprint] = useState<RevisitExamBlueprint | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageStates, setPageStates] = useState<RevisitSessionPageState[]>([]);
  const [messages, setMessages] = useState<RevisitMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [judging, setJudging] = useState(false);
  const [report, setReport] = useState<RevisitJudgeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [directorState, setDirectorState] = useState<DirectorState | undefined>();
  const [thinkingState, setThinkingState] = useState<{ stage: string; agentId?: string } | null>(
    null,
  );
  const [attemptId] = useState(() => `revisit-${Date.now()}`);
  const [startedAt] = useState(() => Date.now());
  const [liveSpeech, setLiveSpeech] = useState<string | null>(null);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const [audioIndicatorState, setAudioIndicatorState] = useState<AudioIndicatorState>('idle');
  const [audioAgentId, setAudioAgentId] = useState<string | null>(null);
  const [activeBubbleId, setActiveBubbleId] = useState<string | null>(null);
  const [isCueUser, setIsCueUser] = useState(true);
  const [cueUserPrompt, setCueUserPrompt] = useState<RevisitCueUserPrompt>('teach-page');
  const [generatedSkeletonScenes, setGeneratedSkeletonScenes] = useState<Scene[]>([]);
  const [skeletonLoadState, setSkeletonLoadState] = useState<SkeletonLoadState>('idle');
  const [skeletonRetryKey, setSkeletonRetryKey] = useState(0);
  const transcriptRef = useRef<RevisitMessage[]>([]);
  const openingInjectedRef = useRef(false);
  const openingClearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    transcriptRef.current = messages;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoadState('loading');
        setError(null);
        setClassroom(null);
        setBlueprint(null);
        setGeneratedSkeletonScenes([]);
        setSkeletonLoadState('idle');
        openingInjectedRef.current = false;
        const data = await loadClassroomData(classroomId);
        if (!data) throw new Error('missing classroom');
        const nextBlueprint = await ensureRevisitBlueprint({
          stage: data.stage,
          scenes: data.scenes,
        });
        if (cancelled) return;
        setClassroom(data);
        setBlueprint(nextBlueprint);
        setPageStates(
          nextBlueprint.skeleton.pages.map((_, index) => ({
            pageIndex: index,
            askedProbeIds: [],
            additionalProbeCount: 0,
            rescued: false,
            passed: false,
          })),
        );
        setLoadState('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoadState('error');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [classroomId, loadRetryKey]);

  const pages = blueprint?.skeleton.pages ?? [];
  const currentPage = pages[pageIndex];
  const currentPageState = pageStates[pageIndex];
  const passedCount = pageStates.filter((state) => state.passed).length;
  const allPagesPassed = pages.length > 0 && passedCount === pages.length;
  const allAgents = useMemo(() => Object.values(agentsRecord), [agentsRecord]);
  const revisitAgentIds = useMemo(() => resolveRevisitAgentIds(allAgents), [allAgents]);
  useEffect(() => {
    if (!classroom || !blueprint) return;
    let cancelled = false;
    setGeneratedSkeletonScenes([]);
    setSkeletonLoadState('generating');
    setError(null);

    const modelConfig = getCurrentModelConfig();
    void ensureRevisitSkeletonDeck({
      stage: classroom.stage,
      blueprint,
      sourceScenes: classroom.scenes,
      modelConfig,
      forceRegenerate: skeletonRetryKey > 0,
      onScene: (scene, index) => {
        if (cancelled) return;
        setGeneratedSkeletonScenes((prev) => {
          const next = [...prev];
          next[index] = scene;
          return next;
        });
      },
    })
      .then((deck) => {
        if (cancelled) return;
        setGeneratedSkeletonScenes(deck.scenes);
        setSkeletonLoadState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setSkeletonLoadState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [blueprint, classroom, skeletonRetryKey]);
  const skeletonScenes = generatedSkeletonScenes;
  const currentSkeletonScene = skeletonScenes[pageIndex] ?? null;
  const sceneStatuses = useMemo(
    () => buildRevisitSceneStatuses(skeletonScenes, pageStates, pageIndex, demoGateSkipEnabled),
    [demoGateSkipEnabled, pageIndex, pageStates, skeletonScenes],
  );
  const studentStatusEmoji = getRevisitStudentStatusEmoji(currentPageState, running);
  const cueUserLabelKey = getRevisitCueUserLabelKey(cueUserPrompt);
  const skeletonOutlines = useMemo(
    () => (blueprint ? buildRevisitSkeletonOutlines(blueprint) : []),
    [blueprint],
  );
  useEffect(() => {
    if (!classroom || skeletonOutlines.length === 0) return;
    // Feed the same store fields forward generation feeds, so the classroom's
    // native generation UI (sidebar pending placeholder, generating canvas
    // state, failed-outline retry) renders for the skeleton deck too.
    const denseScenes = skeletonScenes.filter(Boolean);
    const pendingOutlines = skeletonOutlines.slice(denseScenes.length);
    const generating = skeletonLoadState === 'generating' && pendingOutlines.length > 0;
    const failed = skeletonLoadState === 'error' && pendingOutlines.length > 0;
    const currentSceneId =
      skeletonScenes[pageIndex]?.id ??
      (generating || failed ? PENDING_SCENE_ID : (denseScenes[0]?.id ?? null));
    useStageStore.setState({
      stage: classroom.stage,
      scenes: denseScenes,
      currentSceneId,
      chats: [],
      mode: 'playback',
      outlines: skeletonOutlines,
      generatingOutlines: generating || failed ? pendingOutlines : [],
      generationComplete: !generating && !failed,
      generationStatus: generating ? 'generating' : failed ? 'error' : 'completed',
      currentGeneratingOrder: generating ? denseScenes.length : -1,
      failedOutlines: failed && pendingOutlines[0] ? [pendingOutlines[0]] : [],
    });
  }, [classroom, pageIndex, skeletonLoadState, skeletonOutlines, skeletonScenes]);
  const revisitParticipants = useMemo(
    () =>
      buildRevisitParticipants({
        agents: allAgents,
        agentIds: revisitAgentIds,
        teacherName: t('common.you'),
        studentStatusEmoji,
      }),
    [allAgents, revisitAgentIds, studentStatusEmoji, t],
  );
  const transcriptSession = useMemo(
    () =>
      buildRevisitChatSession({
        id: attemptId,
        title: currentPage?.title || t('revisit.challenge.open'),
        messages,
        status: running ? 'active' : report ? 'completed' : 'idle',
      }),
    [attemptId, currentPage?.title, messages, report, running, t],
  );
  const ttsAgents = useMemo(
    () =>
      [revisitAgentIds.assistantAgentId, ...revisitAgentIds.studentAgentIds]
        .map((agentId) => agentsRecord[agentId])
        .filter((agent): agent is AgentConfig => Boolean(agent)),
    [agentsRecord, revisitAgentIds],
  );
  const revisitAgentConfigs = useMemo(() => ttsAgents.map(toStatelessAgentConfig), [ttsAgents]);
  const discussionTTS = useDiscussionTTS({
    enabled: ttsEnabled && !ttsMuted,
    agents: ttsAgents,
    onAudioStateChange: (agentId, state) => {
      setAudioAgentId(agentId);
      setAudioIndicatorState(state);
    },
  });
  useEffect(() => {
    if (openingInjectedRef.current || !classroom || !blueprint || !currentSkeletonScene) return;
    const firstPage = blueprint.skeleton.pages[0];
    const assistantAgent = agentsRecord[revisitAgentIds.assistantAgentId];
    const text = t('revisit.challenge.assistantOpening', {
      stage: classroom.stage.name,
      page: firstPage?.title || classroom.stage.name,
    });
    const openingMessage = createAssistantRevisitMessage({
      text,
      agentId: revisitAgentIds.assistantAgentId,
      agentName: assistantAgent?.name ?? t('revisit.challenge.assistant'),
      agentAvatar: assistantAgent?.avatar,
    });

    openingInjectedRef.current = true;
    setMessages((prev) => {
      const next = prev.length ? prev : [openingMessage];
      transcriptRef.current = next;
      return next;
    });
    setActiveBubbleId(openingMessage.id);
    setLiveSpeech(openingMessage.text);
    setSpeakingAgentId(openingMessage.agentId ?? null);
    setIsCueUser(true);
    discussionTTS.handleSegmentSealed(
      openingMessage.id,
      `${openingMessage.id}:opening`,
      openingMessage.text,
      openingMessage.agentId ?? null,
    );

    const displayMs = Math.min(8000, Math.max(3000, openingMessage.text.length * 110));
    if (openingClearTimerRef.current != null) {
      window.clearTimeout(openingClearTimerRef.current);
    }
    openingClearTimerRef.current = window.setTimeout(() => {
      setLiveSpeech((current) => (current === openingMessage.text ? null : current));
      setSpeakingAgentId((current) => (current === openingMessage.agentId ? null : current));
      setActiveBubbleId((current) => (current === openingMessage.id ? null : current));
    }, displayMs);
  }, [
    agentsRecord,
    blueprint,
    classroom,
    currentSkeletonScene,
    discussionTTS,
    revisitAgentIds.assistantAgentId,
    t,
  ]);
  useEffect(() => {
    return () => {
      if (openingClearTimerRef.current != null) {
        window.clearTimeout(openingClearTimerRef.current);
      }
    };
  }, []);

  const updatePageState = useCallback((index: number, update: Partial<RevisitSessionPageState>) => {
    setPageStates((prev) =>
      prev.map((state, stateIndex) => (stateIndex === index ? { ...state, ...update } : state)),
    );
  }, []);

  const navigatePage = useCallback(
    (targetIndex: number) => {
      if (!canNavigateRevisitPage(pageStates, pageIndex, targetIndex, demoGateSkipEnabled)) return;
      if (targetIndex !== pageIndex) {
        setCueUserPrompt((current) => reduceRevisitCueUserPrompt(current, 'enter-page'));
      }
      setPageIndex(targetIndex);
    },
    [demoGateSkipEnabled, pageIndex, pageStates],
  );
  const navigateScene = useCallback(
    (sceneId: string) => {
      const targetIndex = skeletonScenes.findIndex((scene) => scene.id === sceneId);
      if (targetIndex >= 0) navigatePage(targetIndex);
    },
    [navigatePage, skeletonScenes],
  );
  useEffect(() => {
    if (report || running || judging || !currentPageState) return;
    setIsCueUser(!currentPageState.passed);
  }, [currentPageState, judging, report, running]);
  useEffect(() => {
    setCueUserPrompt((current) => reduceRevisitCueUserPrompt(current, 'enter-page'));
  }, [pageIndex]);

  const applyGate = useCallback(
    (gate: RevisitGateDecision | null) => {
      if (!currentPageState || !currentPage) return;
      const decision =
        gate ??
        ({
          status:
            currentPageState.additionalProbeCount >= REVISIT_PAGE_PROBE_CAP ? 'rescue' : 'probe',
          pageIndex,
          reason: '',
        } satisfies RevisitGateDecision);

      if (decision.status === 'pass') {
        updatePageState(pageIndex, { passed: true });
        return;
      }

      if (decision.status === 'rescue') {
        updatePageState(pageIndex, { rescued: true });
        return;
      }

      const nextProbeId =
        decision.nextProbeId ||
        blueprint?.concepts
          .flatMap((concept) => concept.probes)
          .find(
            (probe) =>
              (probe.pageIndex == null || probe.pageIndex === pageIndex) &&
              !currentPageState.askedProbeIds.includes(probe.id),
          )?.id;

      updatePageState(pageIndex, {
        additionalProbeCount: Math.min(
          REVISIT_PAGE_PROBE_CAP,
          currentPageState.additionalProbeCount + 1,
        ),
        askedProbeIds: nextProbeId
          ? Array.from(new Set([...currentPageState.askedProbeIds, nextProbeId]))
          : currentPageState.askedProbeIds,
      });
    },
    [blueprint, currentPage, currentPageState, pageIndex, updatePageState],
  );

  async function submitTurn(rawText: string) {
    const text = rawText.trim();
    if (
      !text ||
      !classroom ||
      !blueprint ||
      !currentPageState ||
      !currentSkeletonScene ||
      running ||
      judging ||
      report
    ) {
      return;
    }

    const teacherMessage = createTeacherRevisitMessage(text);
    const nextMessages = [...transcriptRef.current, teacherMessage];
    let loopMessages = nextMessages;
    setMessages(nextMessages);
    setLiveSpeech(null);
    setSpeakingAgentId(null);
    setActiveBubbleId(null);
    setThinkingState(null);
    setIsCueUser(false);
    setCueUserPrompt((current) => reduceRevisitCueUserPrompt(current, 'teacher-submit'));
    discussionTTS.cleanup();

    if (demoGateSkipEnabled) {
      updatePageState(pageIndex, { passed: true });
    }

    setRunning(true);
    try {
      const modelConfig = getCurrentModelConfig();
      const request = createRevisitChatRequest({
        stage: classroom.stage,
        scenes: skeletonScenes,
        blueprint,
        messages: nextMessages,
        pageState: currentPageState,
        latestTeacherText: text,
        elapsedMinutes: (Date.now() - startedAt) / 60_000,
        directorState,
        model: modelConfig.modelString,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        providerType: modelConfig.providerType,
        serviceTier: modelConfig.serviceTier,
        agentIds: revisitAgentIds,
        agentConfigs: revisitAgentConfigs,
      });

      const loopResult = await runRevisitAgentLoop({
        request: {
          ...request,
          ...(modelConfig.thinkingConfig ? { thinkingConfig: modelConfig.thinkingConfig } : {}),
        },
        agentIds: revisitAgentIds,
        getStoreState: () => ({
          stage: classroom.stage,
          scenes: skeletonScenes,
          currentSceneId: skeletonScenes[pageIndex]?.id ?? skeletonScenes[0]?.id ?? null,
          mode: 'playback',
          whiteboardOpen: false,
        }),
        getMessages: () => revisitMessagesToUiMessages(loopMessages),
        callbacks: {
          onAgentMessageStart: (message) => {
            setActiveBubbleId(message.id);
            loopMessages = [...loopMessages, message];
            setMessages(loopMessages);
          },
          onAgentMessageText: (messageId, text) => {
            loopMessages = loopMessages.map((message) =>
              message.id === messageId ? { ...message, text } : message,
            );
            setMessages(loopMessages);
          },
          onAgentMessageEnd: (messageId) => {
            loopMessages = loopMessages.filter(
              (message) => message.id !== messageId || message.text.trim().length > 0,
            );
            setMessages(loopMessages);
            setActiveBubbleId((current) => (current === messageId ? null : current));
          },
          onLiveSpeech: (text, agentId) => {
            setLiveSpeech(text);
            setSpeakingAgentId(agentId);
          },
          onSpeechProgress: () => {},
          onThinking: setThinkingState,
          onCueUser: () => {
            setIsCueUser(true);
            setCueUserPrompt((current) => reduceRevisitCueUserPrompt(current, 'agent-cued-user'));
            setActiveBubbleId(null);
          },
          onGate: applyGate,
          onError: (message) => {
            setError(message);
          },
          onSegmentSealed: (messageId, partId, text, agentId) => {
            if (text.trim() && agentId) {
              discussionTTS.handleSegmentSealed(messageId, partId, text, agentId);
            }
          },
          shouldHoldAfterReveal: discussionTTS.shouldHold,
        },
      });
      setDirectorState(loopResult.outcome.directorState);
    } catch (err) {
      toast.error(t('revisit.challenge.chatFailed'));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinkingState(null);
      setRunning(false);
    }
  }

  async function finishChallenge() {
    if (!classroom || !blueprint || judging || transcriptRef.current.length === 0) return;
    setJudging(true);
    try {
      const pageReports = buildPageReports(blueprint, pageStates);
      const nextReport = await submitRevisitAttempt({
        attemptId,
        stage: classroom.stage,
        blueprint,
        transcript: transcriptRef.current,
        pageReports,
        stableSuccessesRequired,
        forgettingSpeedMultiplier,
      });
      setReport(nextReport);
    } catch (err) {
      toast.error(t('revisit.challenge.judgeFailed'));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setJudging(false);
    }
  }

  useEffect(() => {
    if (!allPagesPassed || report || judging || running) return;
    void finishChallenge();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finishChallenge reads current refs/state and is guarded above.
  }, [allPagesPassed, judging, report, running]);

  if (!reverseChallengeEnabled) {
    return <CenteredState title={t('revisit.challenge.disabled')} onBack={() => router.back()} />;
  }

  if (loadState === 'loading') {
    return <CenteredState title={t('revisit.challenge.loading')} loading />;
  }

  if (loadState === 'error' || !classroom || !blueprint || !currentPage) {
    return (
      <CenteredState
        title={t('revisit.challenge.loadFailed')}
        detail={error ?? undefined}
        onBack={() => router.push('/')}
        onRetry={() => setLoadRetryKey((key) => key + 1)}
      />
    );
  }

  // Forward-generation choreography, beat for beat: the pre-classroom
  // interstitial (GeneratingProgress, same component) runs until the FIRST
  // skeleton page exists; only then does the classroom mount, with the
  // remaining pages arriving through the store-driven sidebar placeholders.
  if (!skeletonScenes[0]) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md space-y-4">
          <GeneratingProgress
            outlineReady
            firstPageReady={false}
            statusMessage={t('revisit.challenge.skeletonPreparing')}
            error={
              skeletonLoadState === 'error'
                ? (error ?? t('revisit.challenge.skeletonFailed'))
                : null
            }
          />
          {skeletonLoadState === 'error' ? (
            <div className="flex justify-center gap-3">
              <Button variant="outline" onClick={() => router.push('/')}>
                {t('common.back')}
              </Button>
              <Button onClick={() => setSkeletonRetryKey((key) => key + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const canGoPrev = pageIndex > 0;
  const canGoNext =
    pageIndex < pages.length - 1 &&
    Boolean(skeletonScenes[pageIndex + 1]) &&
    canNavigateRevisitPage(pageStates, pageIndex, pageIndex + 1, demoGateSkipEnabled);
  const canvasOverlay = report ? (
    <div className="absolute inset-0 z-[130] overflow-auto bg-background/95 p-6 backdrop-blur">
      <ReportView report={report} />
    </div>
  ) : (
    <>
      {currentPageState?.passed ? (
        <div className="absolute left-4 top-4 z-[120]">
          <Badge className="gap-1 bg-emerald-600 text-white">
            <CheckCircle2 className="size-3.5" />
            {t('revisit.challenge.gate.pass')}
          </Badge>
        </div>
      ) : null}
    </>
  );

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="flex h-screen flex-col overflow-hidden">
          <ClassroomStage
            onRetryOutline={async () => {
              setSkeletonRetryKey((key) => key + 1);
            }}
            revisitConfig={{
              participants: revisitParticipants,
              canvasOverlay,
              currentSpeech: liveSpeech,
              engineMode: running ? 'live' : 'idle',
              isStreaming: running,
              speakingAgentId,
              audioIndicatorState,
              audioAgentId,
              thinkingState,
              isCueUser,
              cueUserLabel: cueUserLabelKey ? t(cueUserLabelKey) : undefined,
              transcriptSession,
              transcriptActiveBubbleId: activeBubbleId,
              onMessageSend: submitTurn,
              onPrevScene: () => navigatePage(pageIndex - 1),
              onNextScene: () => navigatePage(pageIndex + 1),
              onSceneSelect: navigateScene,
              canGoPrev,
              canGoNext,
              sceneStatuses,
            }}
          />
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}

function buildRevisitParticipants(args: {
  agents: AgentConfig[];
  agentIds: RevisitAgentIds;
  teacherName: string;
  studentStatusEmoji: string;
}): Participant[] {
  const byId = new Map(args.agents.map((agent) => [agent.id, agent]));
  const agentIds = Array.from(
    new Set([...args.agentIds.studentAgentIds, args.agentIds.assistantAgentId]),
  );
  return [
    {
      id: 'user-1',
      name: args.teacherName,
      role: 'teacher',
      avatar: USER_AVATAR,
      isOnline: true,
    },
    ...agentIds
      .map((agentId) => byId.get(agentId))
      .filter((agent): agent is AgentConfig => Boolean(agent))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: 'student' as const,
        avatar: agent.avatar,
        isOnline: true,
        statusEmoji:
          agent.id === args.agentIds.assistantAgentId
            ? args.studentStatusEmoji === '🤔'
              ? '🛟'
              : undefined
            : args.studentStatusEmoji,
      })),
  ];
}

function toStatelessAgentConfig(
  agent: AgentConfig,
): NonNullable<StatelessChatRequest['config']['agentConfigs']>[number] {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    persona: agent.persona,
    avatar: agent.avatar,
    color: agent.color,
    allowedActions: agent.allowedActions,
    priority: agent.priority,
    isGenerated: agent.isGenerated,
    boundStageId: agent.boundStageId,
  };
}

async function loadClassroomData(classroomId: string): Promise<LoadedClassroom | null> {
  const local = await loadStageData(classroomId);
  if (local) return { stage: local.stage, scenes: local.scenes };

  const response = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
  if (!response.ok) return null;
  const json = (await response.json()) as {
    success?: boolean;
    classroom?: LoadedClassroom;
  };
  return json.success && json.classroom ? json.classroom : null;
}

function buildPageReports(
  blueprint: RevisitExamBlueprint,
  pageStates: RevisitSessionPageState[],
): RevisitPageReport[] {
  return blueprint.skeleton.pages.map((page, index) => ({
    pageId: page.id,
    pageIndex: index,
    passed: Boolean(pageStates[index]?.passed),
    probeCount: pageStates[index]?.additionalProbeCount ?? 0,
    conceptIds: page.conceptIds,
    notes: pageStates[index]?.rescued ? 'assistant-rescue' : undefined,
  }));
}

function CenteredState({
  title,
  detail,
  loading,
  onBack,
  onRetry,
}: {
  title: string;
  detail?: string;
  loading?: boolean;
  onBack?: () => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-center">
      <div className="space-y-4">
        <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-muted">
          {loading ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <GraduationCap className="size-5" />
          )}
        </div>
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {detail ? <p className="mt-2 max-w-md text-sm text-muted-foreground">{detail}</p> : null}
        </div>
        <div className="flex justify-center gap-2">
          {onBack ? (
            <Button onClick={onBack} variant="outline">
              <ArrowLeft />
              {t('common.back')}
            </Button>
          ) : null}
          {onRetry ? <Button onClick={onRetry}>{t('common.retry')}</Button> : null}
        </div>
      </div>
    </main>
  );
}

function ReportView({ report }: { report: RevisitJudgeReport }) {
  const { t } = useI18n();
  const dimensions = Object.entries(report.dimensions);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-lg border bg-background p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">
              {t('revisit.challenge.report')}
            </p>
            <h2 className="mt-1 text-2xl font-semibold">{Math.round(report.q * 100)}%</h2>
          </div>
          <Badge variant={report.q >= 0.75 ? 'default' : 'secondary'}>
            {report.q >= 0.75
              ? t('revisit.challenge.reportStrong')
              : t('revisit.challenge.reportNeedsWork')}
          </Badge>
        </div>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">{report.summary}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {dimensions.map(([dimension, value]) => (
          <div key={dimension} className="rounded-lg border bg-background p-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{t(`revisit.challenge.dimensions.${dimension}`)}</span>
              <span className="font-semibold">{Math.round(value * 100)}%</span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.round(value * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border bg-background p-4">
        <h3 className="text-sm font-semibold">{t('revisit.challenge.errors')}</h3>
        {report.errors.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('revisit.challenge.noErrors')}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {report.errors.map((error) => (
              <div key={error.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                {error.description}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
