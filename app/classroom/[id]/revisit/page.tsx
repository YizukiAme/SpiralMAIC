'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, FileChartColumn, GraduationCap, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Stage as ClassroomStage } from '@/components/stage';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import { isAbortError } from '@/lib/generation/generation-retry';
import { createLogger } from '@/lib/logger';
import { submitRevisitAttempt } from '@/lib/revisit/client';
import {
  getRevisitAttempt,
  importLegacyRevisitAttemptSnapshot,
  saveRevisitAttemptSource,
  upsertRevisitAttemptScene,
} from '@/lib/revisit/attempt-store';
import { runRevisitAgentLoop } from '@/lib/revisit/chat-loop';
import { buildRevisitSkeletonOutlines, generateRevisitSkeletonScene } from '@/lib/revisit/slides';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import {
  applyRevisitGateToPageStates,
  buildRevisitSceneStatuses,
  buildRevisitChatSession,
  buildRevisitOpeningContext,
  canNavigateRevisitPage,
  compactRevisitDirectorState,
  createAssistantRevisitMessage,
  createRevisitChatRequest,
  createTeacherRevisitMessage,
  getLastUnlockedRevisitPageIndex,
  getRevisitCueUserLabelKey,
  getRevisitParticipantStatusBadge,
  REVISIT_PAGE_PROBE_CAP,
  reduceRevisitCueUserPrompt,
  revisitMessagesToUiMessages,
  resolveRevisitAgentIds,
  selectPageProbes,
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
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { loadStageData } from '@/lib/utils/stage-storage';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { Participant } from '@/lib/types/roundtable';
import { USER_AVATAR } from '@/lib/types/roundtable';
import { RevisitDemoBadge } from '@/components/revisit/demo-badge';
import { parseRevisitScope, serializeRevisitScope } from '@/lib/revisit/scope';
import { getRevisitNow } from '@/lib/revisit/clock';
import {
  hydrateSpiralAgentRegistry,
  resolveAttemptSpiralAgentRoster,
} from '@/lib/revisit/spiral-agents';
import {
  REVISIT_COMPLETION_PAGE_ID,
  REVISIT_REPORT_PAGE_ID,
  resolveRevisitChallengeView,
} from '@/lib/revisit/challenge-navigation';

interface LoadedClassroom {
  stage: StageModel;
  scenes: Scene[];
}

type LoadState = 'loading' | 'ready' | 'error';
type SkeletonLoadState = 'idle' | 'generating' | 'ready' | 'error';
type RevisitTailView = 'completion' | 'report' | null;

const log = createLogger('RevisitChallenge');
const EMPTY_REVISIT_AGENT_IDS: RevisitAgentIds = {
  studentAgentId: '',
  studentAgentIds: [],
  assistantAgentId: '',
};

export default function RevisitChallengePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const classroomId = params?.id as string;
  const attemptId = searchParams.get('attempt') ?? '';
  const scopeParam = searchParams.get('scope');
  const revisitScope = useMemo(() => parseRevisitScope(scopeParam), [scopeParam]);
  const { locale, t } = useI18n();
  const reverseChallengeEnabled = useSettingsStore((s) => s.reverseChallengeEnabled);
  const stableSuccessesRequired = useSettingsStore((s) => s.stableSuccessesRequired);
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
  const [tailView, setTailView] = useState<RevisitTailView>(null);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [replayMode, setReplayMode] = useState(false);
  const [replayComplete, setReplayComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directorStatesByPage, setDirectorStatesByPage] = useState<Record<number, DirectorState>>(
    {},
  );
  const [thinkingState, setThinkingState] = useState<{ stage: string; agentId?: string } | null>(
    null,
  );
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [liveSpeech, setLiveSpeech] = useState<string | null>(null);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const [audioIndicatorState, setAudioIndicatorState] = useState<AudioIndicatorState>('idle');
  const [audioAgentId, setAudioAgentId] = useState<string | null>(null);
  const [activeBubbleId, setActiveBubbleId] = useState<string | null>(null);
  const [isCueUser, setIsCueUser] = useState(true);
  const [cueUserPrompt, setCueUserPrompt] = useState<RevisitCueUserPrompt>('teach-page');
  const [teacherSpeaking, setTeacherSpeaking] = useState(false);
  const [awaitingStudentStatusUpdate, setAwaitingStudentStatusUpdate] = useState(false);
  const [generatedSkeletonScenes, setGeneratedSkeletonScenes] = useState<Scene[]>([]);
  const [skeletonLoadState, setSkeletonLoadState] = useState<SkeletonLoadState>('idle');
  const [skeletonRetryKey, setSkeletonRetryKey] = useState(0);
  const [failedSkeletonPageIndex, setFailedSkeletonPageIndex] = useState<number | null>(null);
  const transcriptRef = useRef<RevisitMessage[]>([]);
  const failedSkeletonPageIndexRef = useRef<number | null>(null);
  const failedPageReturnIndexRef = useRef<number | null>(null);
  const turnAbortControllerRef = useRef<AbortController | null>(null);
  const judgeAbortControllerRef = useRef<AbortController | null>(null);
  const openingInjectedRef = useRef(false);
  const openingClearTimerRef = useRef<number | null>(null);
  const missingGateFallbackCountsRef = useRef<Record<number, number>>({});

  useEffect(() => {
    transcriptRef.current = messages;
  }, [messages]);

  useEffect(
    () => () => {
      const stageStore = useStageStore.getState();
      if (
        stageStore.persistenceScope === 'transient-revisit' &&
        stageStore.stage?.id === classroomId
      ) {
        stageStore.clearStore();
      }
    },
    [classroomId],
  );

  useEffect(() => {
    if (!reverseChallengeEnabled) {
      router.replace('/');
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        setLoadState('loading');
        setError(null);
        setClassroom(null);
        setBlueprint(null);
        setGeneratedSkeletonScenes([]);
        setSkeletonLoadState('idle');
        setFailedSkeletonPageIndex(null);
        failedSkeletonPageIndexRef.current = null;
        failedPageReturnIndexRef.current = null;
        setDirectorStatesByPage({});
        missingGateFallbackCountsRef.current = {};
        openingInjectedRef.current = false;
        if (!attemptId) throw new Error('missing revisit attempt');
        let snapshot =
          (await getRevisitAttempt(attemptId, revisitScope)) ??
          (await importLegacyRevisitAttemptSnapshot(attemptId, revisitScope));
        if (!snapshot || snapshot.stageId !== classroomId) {
          throw new Error('prepared revisit attempt not found');
        }
        if ((!snapshot.sourceStage || snapshot.sourceScenes.length === 0) && !snapshot.reportOnly) {
          const currentSource = await loadStageData(classroomId);
          if (currentSource) {
            snapshot = await saveRevisitAttemptSource(
              snapshot.attemptId,
              currentSource.stage,
              currentSource.scenes,
              await getRevisitNow(revisitScope),
              revisitScope,
            );
          }
        }
        if (!snapshot.sourceStage || snapshot.sourceScenes.length === 0 || !snapshot.blueprint) {
          throw new Error('this historical challenge only contains a report');
        }
        const spiralAgents = resolveAttemptSpiralAgentRoster(snapshot.sourceStage, snapshot.status);
        if (!spiralAgents) {
          if (snapshot.status !== 'completed') {
            router.replace(
              `/generation-preview?attempt=${encodeURIComponent(snapshot.attemptId)}&scope=${encodeURIComponent(
                serializeRevisitScope(revisitScope),
              )}&run=1`,
            );
            return;
          }
          throw new Error('this historical challenge does not contain its agent roster');
        }
        const data = {
          stage: { ...snapshot.sourceStage, spiralAgentConfigs: spiralAgents },
          scenes: snapshot.sourceScenes,
        };
        await hydrateStageAgentsForRevisit(data.stage);
        if (cancelled) return;
        setClassroom(data);
        setBlueprint(snapshot.blueprint);
        const seededScenes: Scene[] = [];
        snapshot.scenes.forEach((scene, index) => {
          if (scene) seededScenes[index] = scene;
        });
        setGeneratedSkeletonScenes(seededScenes);
        const initialPageStates = snapshot.blueprint.skeleton.pages.map((_, index) => ({
          pageIndex: index,
          askedProbeIds: [],
          additionalProbeCount: 0,
          rescued: false,
          passed: false,
          studentStates: {},
        }));
        setPageStates(initialPageStates);
        setPageIndex(0);
        setMessages([]);
        transcriptRef.current = [];
        setStartedAt(Date.now());
        setReport(null);
        setTailView(null);
        setJudgeError(null);
        setReplayMode(snapshot.status === 'completed');
        setReplayComplete(false);
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
  }, [attemptId, classroomId, loadRetryKey, reverseChallengeEnabled, revisitScope, router]);

  const pages = blueprint?.skeleton.pages ?? [];
  const currentPage = pages[pageIndex];
  const currentPageState = pageStates[pageIndex];
  const passedCount = pageStates.filter((state) => state.passed).length;
  const allPagesPassed = pages.length > 0 && passedCount === pages.length;
  const reportAvailable = Boolean(report || replayComplete);
  const revisitTailPages = useMemo(
    () => [
      {
        id: REVISIT_COMPLETION_PAGE_ID,
        title: t('stage.courseComplete'),
        kind: 'completion' as const,
        locked: !allPagesPassed,
        busy: judging,
      },
      ...(reportAvailable
        ? [
            {
              id: REVISIT_REPORT_PAGE_ID,
              title: report ? t('revisit.challenge.report') : t('revisit.challenge.replayComplete'),
              kind: 'report' as const,
            },
          ]
        : []),
    ],
    [allPagesPassed, judging, report, reportAvailable, t],
  );
  const spiralAgentConfigs = classroom?.stage.spiralAgentConfigs ?? [];
  const revisitAgentIds = useMemo(
    () => resolveRevisitAgentIds(spiralAgentConfigs) ?? EMPTY_REVISIT_AGENT_IDS,
    [spiralAgentConfigs],
  );
  const allAgents = useMemo(
    () =>
      [revisitAgentIds.assistantAgentId, ...revisitAgentIds.studentAgentIds]
        .map((agentId) => agentsRecord[agentId])
        .filter((agent): agent is AgentConfig => Boolean(agent)),
    [agentsRecord, revisitAgentIds],
  );
  useEffect(() => {
    if (!reverseChallengeEnabled || !classroom || !blueprint || !attemptId) return;
    let cancelled = false;
    const controller = new AbortController();
    const existingScenes = generatedSkeletonScenes;
    const missingIndexes = blueprint.skeleton.pages
      .map((_, index) => index)
      .filter((index) => !existingScenes[index]);
    if (missingIndexes.length === 0) {
      failedSkeletonPageIndexRef.current = null;
      failedPageReturnIndexRef.current = null;
      setFailedSkeletonPageIndex(null);
      setSkeletonLoadState('ready');
      return;
    }

    setSkeletonLoadState('generating');
    setError(null);

    const modelConfig = getCurrentModelConfig();
    let activePageIndex = missingIndexes[0] ?? null;
    void (async () => {
      for (const index of missingIndexes) {
        activePageIndex = index;
        const scene = await generateRevisitSkeletonScene({
          stage: classroom.stage,
          blueprint,
          sourceScenes: classroom.scenes,
          modelConfig,
          pageIndex: index,
          signal: controller.signal,
        });
        if (cancelled) return;
        await upsertRevisitAttemptScene({
          attemptId,
          scene,
          index,
          scope: revisitScope,
          now: await getRevisitNow(revisitScope),
        });
        setGeneratedSkeletonScenes((prev) => {
          const next = [...prev];
          next[index] = scene;
          return next;
        });
        if (failedSkeletonPageIndexRef.current === index) {
          failedSkeletonPageIndexRef.current = null;
          setFailedSkeletonPageIndex(null);
          const returnIndex = failedPageReturnIndexRef.current;
          failedPageReturnIndexRef.current = null;
          if (returnIndex != null) setPageIndex(returnIndex);
        }
      }
    })()
      .then(() => {
        if (cancelled) return;
        setSkeletonLoadState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        failedSkeletonPageIndexRef.current = activePageIndex;
        setFailedSkeletonPageIndex(activePageIndex);
        setError(err instanceof Error ? err.message : String(err));
        setSkeletonLoadState('error');
      });

    return () => {
      cancelled = true;
      controller.abort(new DOMException('Revisit classroom generation stopped', 'AbortError'));
    };
  }, [
    attemptId,
    blueprint,
    classroom,
    generatedSkeletonScenes,
    reverseChallengeEnabled,
    revisitScope,
    skeletonRetryKey,
  ]);
  const skeletonScenes = generatedSkeletonScenes;
  const currentSkeletonScene = skeletonScenes[pageIndex] ?? null;
  const sceneStatuses = useMemo(
    () => buildRevisitSceneStatuses(skeletonScenes, pageStates, pageIndex, demoGateSkipEnabled),
    [demoGateSkipEnabled, pageIndex, pageStates, skeletonScenes],
  );
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
      tailView === 'report'
        ? REVISIT_REPORT_PAGE_ID
        : tailView === 'completion'
          ? REVISIT_COMPLETION_PAGE_ID
          : (skeletonScenes[pageIndex]?.id ??
            (generating || failed ? PENDING_SCENE_ID : (denseScenes[0]?.id ?? null)));
    useStageStore.setState({
      stage: classroom.stage,
      persistenceScope: 'transient-revisit',
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
  }, [classroom, pageIndex, skeletonLoadState, skeletonOutlines, skeletonScenes, tailView]);
  const revisitParticipants = useMemo(
    () =>
      buildRevisitParticipants({
        agents: allAgents,
        agentIds: revisitAgentIds,
        teacherName: t('common.you'),
        pageState: currentPageState,
        teacherSpeaking,
        awaitingStudentStatusUpdate,
        t,
      }),
    [allAgents, awaitingStudentStatusUpdate, currentPageState, revisitAgentIds, teacherSpeaking, t],
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
  const handleExit = useCallback(() => {
    turnAbortControllerRef.current?.abort(new DOMException('Challenge closed', 'AbortError'));
    judgeAbortControllerRef.current?.abort(new DOMException('Challenge closed', 'AbortError'));
    discussionTTS.cleanup();
    router.push('/');
  }, [discussionTTS, router]);
  useEffect(() => {
    if (openingInjectedRef.current || !classroom || !blueprint || !currentSkeletonScene) return;
    if (transcriptRef.current.length > 0) {
      openingInjectedRef.current = true;
      return;
    }
    const firstPage = blueprint.skeleton.pages[0];
    const assistantAgent = agentsRecord[revisitAgentIds.assistantAgentId];
    const openingContext = buildRevisitOpeningContext({
      blueprint,
      sourceScenes: classroom.scenes,
      locale,
    });
    const overview =
      openingContext.brief ??
      t('revisit.challenge.assistantOpeningFallback', {
        stage: classroom.stage.name,
        topics: openingContext.topics || classroom.stage.name,
      });
    const text = t('revisit.challenge.assistantOpening', {
      overview,
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
    locale,
    revisitAgentIds.assistantAgentId,
    t,
  ]);
  useEffect(() => {
    return () => {
      turnAbortControllerRef.current?.abort(
        new DOMException('Revisit classroom closed', 'AbortError'),
      );
      judgeAbortControllerRef.current?.abort(
        new DOMException('Revisit classroom closed', 'AbortError'),
      );
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
      if (
        !canNavigateRevisitPage(
          pageStates,
          pageIndex,
          targetIndex,
          demoGateSkipEnabled,
          failedSkeletonPageIndex,
        )
      )
        return;
      if (pageIndex === failedSkeletonPageIndex && targetIndex !== failedSkeletonPageIndex) {
        failedPageReturnIndexRef.current = null;
      }
      if (targetIndex !== pageIndex) {
        setCueUserPrompt((current) => reduceRevisitCueUserPrompt(current, 'enter-page'));
      }
      setTailView(null);
      setPageIndex(targetIndex);
      const targetScene = skeletonScenes[targetIndex];
      if (targetScene) useStageStore.getState().setCurrentSceneId(targetScene.id);
    },
    [demoGateSkipEnabled, failedSkeletonPageIndex, pageIndex, pageStates, skeletonScenes],
  );
  const navigateFailedOutline = useCallback(
    (outlineId: string) => {
      const targetIndex = skeletonOutlines.findIndex((outline) => outline.id === outlineId);
      if (targetIndex < 0 || targetIndex !== failedSkeletonPageIndex) return;
      failedPageReturnIndexRef.current = getLastUnlockedRevisitPageIndex(
        pageStates,
        skeletonScenes,
        demoGateSkipEnabled,
      );
      setPageIndex(targetIndex);
    },
    [demoGateSkipEnabled, failedSkeletonPageIndex, pageStates, skeletonOutlines, skeletonScenes],
  );
  const navigateScene = useCallback(
    (sceneId: string) => {
      const destination = resolveRevisitChallengeView({
        sceneId,
        sceneIds: skeletonScenes.map((scene) => scene.id),
        allPagesPassed,
        reportAvailable,
      });
      if (!destination) return;
      if (destination.kind === 'scene') {
        navigatePage(destination.pageIndex);
        return;
      }
      if (destination.kind === 'completion') {
        setPageIndex(Math.max(0, pages.length - 1));
      }
      setTailView(destination.kind);
      useStageStore.getState().setCurrentSceneId(sceneId);
    },
    [allPagesPassed, navigatePage, pages.length, reportAvailable, skeletonScenes],
  );
  useEffect(() => {
    if (tailView || report || running || judging || !currentPageState) return;
    setIsCueUser(!currentPageState.passed);
  }, [currentPageState, judging, report, running, tailView]);
  useEffect(() => {
    setCueUserPrompt((current) => reduceRevisitCueUserPrompt(current, 'enter-page'));
  }, [pageIndex]);

  const applyGate = useCallback(
    (gate: RevisitGateDecision | null, studentMessagesSinceTeacherTurn: RevisitMessage[] = []) => {
      if (!blueprint?.skeleton.pages[pageIndex]) return;
      if (demoGateSkipEnabled) {
        updatePageState(pageIndex, { passed: true });
        setAwaitingStudentStatusUpdate(false);
        return;
      }
      if (!gate) {
        const fallbackCount = (missingGateFallbackCountsRef.current[pageIndex] ?? 0) + 1;
        missingGateFallbackCountsRef.current[pageIndex] = fallbackCount;
        const fallbackMode =
          (pageStates[pageIndex]?.additionalProbeCount ?? 0) >= REVISIT_PAGE_PROBE_CAP
            ? 'rescue'
            : 'probe';
        log.warn('[RevisitGate] Missing gate; applying page fallback', {
          pageIndex,
          count: fallbackCount,
          fallbackMode,
        });
      }
      const candidateProbeIds = selectPageProbes(blueprint, pageIndex).map((probe) => probe.id);
      setPageStates((prev) =>
        applyRevisitGateToPageStates({
          pageStates: prev,
          pageIndex,
          gate,
          activeStudentAgentIds: revisitAgentIds.studentAgentIds,
          studentMessagesSinceTeacherTurn,
          candidateProbeIds,
        }),
      );
      setAwaitingStudentStatusUpdate(false);
    },
    [
      blueprint,
      demoGateSkipEnabled,
      pageIndex,
      pageStates,
      revisitAgentIds.studentAgentIds,
      updatePageState,
    ],
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
      report ||
      replayComplete
    ) {
      return;
    }

    const teacherMessage = createTeacherRevisitMessage(text);
    const nextMessages = [...transcriptRef.current, teacherMessage];
    let loopMessages = nextMessages;
    let gateAppliedThisTeacherTurn = false;
    transcriptRef.current = nextMessages;
    setMessages(nextMessages);
    setLiveSpeech(null);
    setSpeakingAgentId(null);
    setActiveBubbleId(null);
    setThinkingState(null);
    setIsCueUser(false);
    setCueUserPrompt((current) => reduceRevisitCueUserPrompt(current, 'teacher-submit'));
    setTeacherSpeaking(false);
    setAwaitingStudentStatusUpdate(true);
    discussionTTS.cleanup();

    if (demoGateSkipEnabled) {
      updatePageState(pageIndex, { passed: true });
    }

    setRunning(true);
    turnAbortControllerRef.current?.abort(
      new DOMException('Superseded revisit teacher turn', 'AbortError'),
    );
    const turnController = new AbortController();
    turnAbortControllerRef.current = turnController;
    try {
      const modelConfig = getCurrentModelConfig();
      const request = createRevisitChatRequest({
        attemptId,
        stage: classroom.stage,
        scenes: skeletonScenes,
        blueprint,
        messages: nextMessages,
        pageState: currentPageState,
        latestTeacherText: text,
        elapsedMinutes: (Date.now() - startedAt) / 60_000,
        directorState: directorStatesByPage[pageIndex],
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
        signal: turnController.signal,
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
            transcriptRef.current = loopMessages;
            setMessages(loopMessages);
          },
          onAgentMessageText: (messageId, text) => {
            loopMessages = loopMessages.map((message) =>
              message.id === messageId ? { ...message, text } : message,
            );
            transcriptRef.current = loopMessages;
            setMessages(loopMessages);
          },
          onAgentMessageEnd: (messageId) => {
            loopMessages = loopMessages.filter(
              (message) => message.id !== messageId || message.text.trim().length > 0,
            );
            transcriptRef.current = loopMessages;
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
            setAwaitingStudentStatusUpdate(false);
          },
          onGate: (gate) => {
            applyGate(gate, loopMessages.slice(nextMessages.length));
            gateAppliedThisTeacherTurn = true;
          },
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
      if (!gateAppliedThisTeacherTurn) {
        applyGate(loopResult.gate, loopMessages.slice(nextMessages.length));
        gateAppliedThisTeacherTurn = true;
      }
      if (loopResult.outcome.directorState) {
        const compactedDirectorState = compactRevisitDirectorState(
          loopResult.outcome.directorState,
        );
        setDirectorStatesByPage((previous) => ({
          ...previous,
          [pageIndex]: compactedDirectorState,
        }));
      }
    } catch (err) {
      if (!isAbortError(err)) {
        toast.error(t('revisit.challenge.chatFailed'));
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (turnAbortControllerRef.current === turnController) {
        turnAbortControllerRef.current = null;
      }
      setThinkingState(null);
      setRunning(false);
      setAwaitingStudentStatusUpdate(false);
    }
  }

  async function finishChallenge() {
    if (
      tailView !== 'completion' ||
      !classroom ||
      !blueprint ||
      judging ||
      transcriptRef.current.length === 0
    )
      return;
    if (replayMode) {
      setReplayComplete(true);
      setTailView('report');
      useStageStore.getState().setCurrentSceneId(REVISIT_REPORT_PAGE_ID);
      return;
    }
    setJudgeError(null);
    setJudging(true);
    const toastId = toast.loading(t('revisit.challenge.generatingReport'));
    judgeAbortControllerRef.current?.abort(
      new DOMException('Superseded revisit judgment', 'AbortError'),
    );
    const judgeController = new AbortController();
    judgeAbortControllerRef.current = judgeController;
    try {
      const pageReports = buildPageReports(blueprint, pageStates);
      const completedAt = await getRevisitNow(revisitScope);
      const nextReport = await submitRevisitAttempt({
        attemptId,
        stage: classroom.stage,
        blueprint,
        transcript: transcriptRef.current,
        pageReports,
        stableSuccessesRequired,
        scope: revisitScope,
        completedAt,
        signal: judgeController.signal,
      });
      setReport(nextReport);
      setTailView('report');
      useStageStore.getState().setCurrentSceneId(REVISIT_REPORT_PAGE_ID);
      toast.success(t('revisit.challenge.reportReady'), { id: toastId });
    } catch (err) {
      if (!isAbortError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t('revisit.challenge.judgeFailed'), { id: toastId });
        setJudgeError(message);
      }
    } finally {
      if (judgeAbortControllerRef.current === judgeController) {
        judgeAbortControllerRef.current = null;
      }
      setJudging(false);
      if (judgeController.signal.aborted) toast.dismiss(toastId);
    }
  }

  if (!reverseChallengeEnabled) {
    return <CenteredState title={t('revisit.challenge.disabled')} onBack={handleExit} />;
  }

  if (loadState === 'loading') {
    return <CenteredState title={t('revisit.challenge.loading')} loading />;
  }

  if (loadState === 'error' || !classroom || !blueprint || !currentPage) {
    return (
      <CenteredState
        title={t('revisit.challenge.loadFailed')}
        detail={error ?? undefined}
        onBack={handleExit}
        onRetry={() => setLoadRetryKey((key) => key + 1)}
      />
    );
  }

  if (!skeletonScenes[0]) {
    return (
      <CenteredState
        title={t('revisit.challenge.loadFailed')}
        detail={error ?? t('revisit.challenge.skeletonFailed')}
        onBack={handleExit}
        onRetry={() => setLoadRetryKey((key) => key + 1)}
      />
    );
  }

  const canGoPrev = tailView ? true : pageIndex > 0;
  const canGoNext =
    tailView === 'completion'
      ? reportAvailable
      : tailView === 'report'
        ? false
        : pageIndex < pages.length - 1
          ? Boolean(skeletonScenes[pageIndex + 1]) &&
            canNavigateRevisitPage(pageStates, pageIndex, pageIndex + 1, demoGateSkipEnabled)
          : allPagesPassed;
  const canvasOverlay =
    tailView === 'report' && report ? (
      <div className="absolute inset-0 z-[130] overflow-auto bg-background p-6">
        <ReportView report={report} />
      </div>
    ) : tailView === 'report' && replayComplete ? (
      <div className="absolute inset-0 z-[130] flex items-center justify-center bg-background/95 p-6 backdrop-blur">
        <div className="max-w-md text-center">
          <CheckCircle2 className="mx-auto size-10 text-emerald-600" />
          <h2 className="mt-4 text-xl font-semibold">{t('revisit.challenge.replayComplete')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('revisit.challenge.replayNotCounted')}
          </p>
          <Button className="mt-5" onClick={handleExit}>
            {t('common.back')}
          </Button>
        </div>
      </div>
    ) : tailView === 'completion' ? (
      <ChallengeCompletionActions
        judging={judging}
        judgeError={judgeError}
        replayMode={replayMode}
        onComplete={finishChallenge}
      />
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
          <RevisitDemoBadge
            scope={revisitScope}
            className="absolute right-4 top-2 z-[200] border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          />
          {replayMode ? (
            <div className="absolute left-1/2 top-2 z-[200] -translate-x-1/2">
              <Badge variant="secondary">{t('revisit.challenge.replayNotCounted')}</Badge>
            </div>
          ) : null}
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
              onExit: handleExit,
              onMessageSend: submitTurn,
              onUserSpeechStateChange: setTeacherSpeaking,
              onPrevScene: () => {
                if (tailView === 'report') {
                  navigateScene(REVISIT_COMPLETION_PAGE_ID);
                } else if (tailView === 'completion') {
                  navigatePage(Math.max(0, pages.length - 1));
                } else {
                  navigatePage(pageIndex - 1);
                }
              },
              onNextScene: () => {
                if (tailView === 'completion' && reportAvailable) {
                  navigateScene(REVISIT_REPORT_PAGE_ID);
                } else if (!tailView && pageIndex === pages.length - 1 && allPagesPassed) {
                  navigateScene(REVISIT_COMPLETION_PAGE_ID);
                } else {
                  navigatePage(pageIndex + 1);
                }
              },
              onSceneSelect: navigateScene,
              onFailedOutlineSelect: navigateFailedOutline,
              canGoPrev,
              canGoNext,
              sceneStatuses,
              tailPages: revisitTailPages,
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
  pageState: RevisitSessionPageState | undefined;
  teacherSpeaking: boolean;
  awaitingStudentStatusUpdate: boolean;
  t: ReturnType<typeof useI18n>['t'];
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
      .map((agent) => {
        const status = getRevisitParticipantStatusBadge({
          pageState: args.pageState,
          agentId: agent.id,
          assistant: agent.id === args.agentIds.assistantAgentId,
          teacherSpeaking: args.teacherSpeaking,
          awaitingStudentStatusUpdate: args.awaitingStudentStatusUpdate,
        });
        return {
          id: agent.id,
          name: agent.name,
          role: 'student' as const,
          avatar: agent.avatar,
          isOnline: true,
          statusEmoji: status?.emoji,
          statusLabel: status ? args.t(status.labelKey) : undefined,
        };
      }),
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

async function hydrateStageAgentsForRevisit(stage: StageModel): Promise<void> {
  if (!stage.spiralAgentConfigs) throw new Error('Spiral agent roster is missing');
  hydrateSpiralAgentRegistry(stage.id, stage.spiralAgentConfigs);
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

function ChallengeCompletionActions({
  judging,
  judgeError,
  replayMode,
  onComplete,
}: {
  judging: boolean;
  judgeError: string | null;
  replayMode: boolean;
  onComplete: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="pointer-events-none absolute inset-0 z-[130] flex items-end justify-center p-8 sm:p-12">
      <div className="pointer-events-auto w-full max-w-md rounded-lg border border-border/70 bg-background/92 p-5 text-center shadow-xl backdrop-blur-xl">
        <div className="mx-auto grid size-10 place-items-center rounded-md bg-primary/10 text-primary">
          {judging ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <FileChartColumn className="size-5" />
          )}
        </div>
        <h2 className="mt-3 text-lg font-semibold">
          {judging
            ? t('revisit.challenge.generatingReport')
            : t('revisit.challenge.readyToComplete')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {judging
            ? t('revisit.challenge.generatingReportDescription')
            : replayMode
              ? t('revisit.challenge.replayNotCounted')
              : t('revisit.challenge.completeDescription')}
        </p>
        {judgeError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {t('revisit.challenge.judgeFailed')}
          </p>
        ) : null}
        <Button className="mt-4 w-full" onClick={onComplete} disabled={judging}>
          {judging ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          {judgeError ? t('revisit.challenge.retryReport') : t('revisit.challenge.complete')}
        </Button>
      </div>
    </div>
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
