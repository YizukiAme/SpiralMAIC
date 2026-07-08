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
import { ensureRevisitBlueprint, submitRevisitAttempt } from '@/lib/revisit/client';
import {
  canNavigateRevisitPage,
  createRevisitChatRequest,
  createTeacherRevisitMessage,
  REVISIT_PAGE_PROBE_CAP,
  resolveRevisitAgentIds,
  roleForRevisitAgent,
  type RevisitAgentIds,
  type RevisitMessage,
  type RevisitSessionPageState,
} from '@/lib/revisit/session';
import { buildRevisitSkeletonScenes } from '@/lib/revisit/slides';
import type {
  RevisitExamBlueprint,
  RevisitGateDecision,
  RevisitJudgeReport,
  RevisitPageReport,
} from '@/lib/revisit/types';
import type { StatelessEvent, DirectorState } from '@/lib/types/chat';
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
  const [attemptId] = useState(() => `revisit-${Date.now()}`);
  const [startedAt] = useState(() => Date.now());
  const [lastGate, setLastGate] = useState<RevisitGateDecision | null>(null);
  const [liveSpeech, setLiveSpeech] = useState<string | null>(null);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const [audioIndicatorState, setAudioIndicatorState] = useState<AudioIndicatorState>('idle');
  const [audioAgentId, setAudioAgentId] = useState<string | null>(null);
  const transcriptRef = useRef<RevisitMessage[]>([]);

  useEffect(() => {
    transcriptRef.current = messages;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoadState('loading');
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
  }, [classroomId]);

  const pages = blueprint?.skeleton.pages ?? [];
  const currentPage = pages[pageIndex];
  const currentPageState = pageStates[pageIndex];
  const passedCount = pageStates.filter((state) => state.passed).length;
  const allPagesPassed = pages.length > 0 && passedCount === pages.length;
  const progressLabel = t('revisit.challenge.progress', {
    current: pages.length ? pageIndex + 1 : 0,
    total: pages.length,
  });
  const allAgents = useMemo(() => Object.values(agentsRecord), [agentsRecord]);
  const revisitAgentIds = useMemo(() => resolveRevisitAgentIds(allAgents), [allAgents]);
  const skeletonScenes = useMemo(
    () =>
      classroom && blueprint
        ? buildRevisitSkeletonScenes({ stage: classroom.stage, blueprint })
        : [],
    [blueprint, classroom],
  );
  const currentSkeletonScene = skeletonScenes[pageIndex] ?? null;
  useEffect(() => {
    if (!classroom || skeletonScenes.length === 0) return;
    const currentSceneId = skeletonScenes[pageIndex]?.id ?? skeletonScenes[0]?.id ?? null;
    useStageStore.setState({
      stage: classroom.stage,
      scenes: skeletonScenes,
      currentSceneId,
      chats: [],
      mode: 'playback',
      generatingOutlines: [],
      outlines: [],
      generationComplete: true,
      generationStatus: 'idle',
      currentGeneratingOrder: -1,
      failedOutlines: [],
    });
  }, [classroom, pageIndex, skeletonScenes]);
  const revisitParticipants = useMemo(
    () =>
      buildRevisitParticipants({
        agents: allAgents,
        agentIds: revisitAgentIds,
        teacherName: t('common.you'),
      }),
    [allAgents, revisitAgentIds, t],
  );
  const ttsAgents = useMemo(
    () =>
      [revisitAgentIds.assistantAgentId, ...revisitAgentIds.studentAgentIds]
        .map((agentId) => agentsRecord[agentId])
        .filter((agent): agent is AgentConfig => Boolean(agent)),
    [agentsRecord, revisitAgentIds],
  );
  const discussionTTS = useDiscussionTTS({
    enabled: ttsEnabled && !ttsMuted,
    agents: ttsAgents,
    onAudioStateChange: (agentId, state) => {
      setAudioAgentId(agentId);
      setAudioIndicatorState(state);
    },
  });

  const updatePageState = useCallback((index: number, update: Partial<RevisitSessionPageState>) => {
    setPageStates((prev) =>
      prev.map((state, stateIndex) => (stateIndex === index ? { ...state, ...update } : state)),
    );
  }, []);

  const navigatePage = useCallback(
    (targetIndex: number) => {
      setPageIndex((prev) =>
        canNavigateRevisitPage(pageStates, prev, targetIndex, demoGateSkipEnabled)
          ? targetIndex
          : prev,
      );
    },
    [demoGateSkipEnabled, pageStates],
  );
  const navigateScene = useCallback(
    (sceneId: string) => {
      const targetIndex = skeletonScenes.findIndex((scene) => scene.id === sceneId);
      if (targetIndex >= 0) navigatePage(targetIndex);
    },
    [navigatePage, skeletonScenes],
  );

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

      setLastGate(decision);

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
    if (!text || !classroom || !blueprint || !currentPageState || running || judging || report) {
      return;
    }

    const teacherMessage = createTeacherRevisitMessage(text);
    const nextMessages = [...transcriptRef.current, teacherMessage];
    setMessages(nextMessages);
    setLiveSpeech(null);
    setSpeakingAgentId(null);
    discussionTTS.cleanup();

    if (demoGateSkipEnabled) {
      updatePageState(pageIndex, { passed: true });
      setLastGate({
        status: 'pass',
        pageIndex,
        reason: 'demo-skip',
        confidence: 1,
      });
      return;
    }

    setRunning(true);
    try {
      const modelConfig = getCurrentModelConfig();
      const request = createRevisitChatRequest({
        stage: classroom.stage,
        scenes: classroom.scenes,
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
        agentIds: revisitAgentIds,
      });

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          ...(modelConfig.thinkingConfig ? { thinkingConfig: modelConfig.thinkingConfig } : {}),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await readChatStream(response, revisitAgentIds);
    } catch (err) {
      toast.error(t('revisit.challenge.chatFailed'));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpeakingAgentId(null);
      setRunning(false);
    }
  }

  async function readChatStream(response: Response, agentIds: RevisitAgentIds) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing stream');
    const decoder = new TextDecoder();
    let buffer = '';
    let gate: RevisitGateDecision | null = null;
    const agentTextByMessageId: Record<string, string> = {};
    const agentIdByMessageId: Record<string, string> = {};

    const processEvent = (event: StatelessEvent) => {
      if (event.type === 'agent_start') {
        const nextMessage: RevisitMessage = {
          id: event.data.messageId,
          role: roleForRevisitAgent(event.data.agentId, agentIds),
          agentId: event.data.agentId,
          agentName: event.data.agentName,
          text: '',
          createdAt: Date.now(),
        };
        agentTextByMessageId[event.data.messageId] = '';
        agentIdByMessageId[event.data.messageId] = event.data.agentId;
        setSpeakingAgentId(event.data.agentId);
        setLiveSpeech('');
        setMessages((prev) => [...prev, nextMessage]);
      } else if (event.type === 'text_delta' && event.data.messageId) {
        agentTextByMessageId[event.data.messageId] =
          (agentTextByMessageId[event.data.messageId] || '') + event.data.content;
        setLiveSpeech((prev) => `${prev ?? ''}${event.data.content}`);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === event.data.messageId
              ? { ...message, text: message.text + event.data.content }
              : message,
          ),
        );
      } else if (event.type === 'agent_end') {
        const text = agentTextByMessageId[event.data.messageId]?.trim();
        const agentId = agentIdByMessageId[event.data.messageId];
        if (text && agentId) {
          discussionTTS.handleSegmentSealed(
            event.data.messageId,
            `${event.data.messageId}:revisit`,
            text,
            agentId,
          );
        }
      } else if (event.type === 'revisit_gate') {
        gate = event.data;
      } else if (event.type === 'done') {
        setDirectorState(event.data.directorState);
      } else if (event.type === 'error') {
        throw new Error(event.data.message);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trimStart())
          .join('\n');
        if (!data) continue;
        processEvent(JSON.parse(data) as StatelessEvent);
      }
    }
    applyGate(gate);
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

  if (!reverseChallengeEnabled) {
    return <CenteredState title={t('revisit.challenge.disabled')} onBack={() => router.back()} />;
  }

  if (loadState === 'loading') {
    return <CenteredState title={t('revisit.challenge.loading')} loading />;
  }

  if (loadState === 'error' || !classroom || !blueprint || !currentPage || !currentSkeletonScene) {
    return (
      <CenteredState
        title={t('revisit.challenge.loadFailed')}
        detail={error ?? undefined}
        onBack={() => router.push('/')}
      />
    );
  }

  const canGoPrev = pageIndex > 0;
  const canGoNext =
    pageIndex < pages.length - 1 &&
    canNavigateRevisitPage(pageStates, pageIndex, pageIndex + 1, demoGateSkipEnabled);
  const headerSlot = (
    <div className="flex items-center gap-2">
      <Badge variant="secondary" className="hidden sm:inline-flex">
        {progressLabel}
      </Badge>
      <Badge variant="secondary">
        {t('revisit.challenge.passed', { count: passedCount, total: pages.length })}
      </Badge>
      {lastGate ? (
        <Badge variant={lastGate.status === 'pass' ? 'default' : 'secondary'}>
          {t(`revisit.challenge.gate.${lastGate.status}`)}
        </Badge>
      ) : null}
      <Button
        onClick={finishChallenge}
        disabled={judging || running || messages.length === 0 || !allPagesPassed}
        size="sm"
      >
        {judging ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
        {t('revisit.challenge.finish')}
      </Button>
    </div>
  );
  const canvasOverlay = report ? (
    <div className="absolute inset-0 z-[130] overflow-auto bg-background/95 p-6 backdrop-blur">
      <ReportView report={report} />
    </div>
  ) : currentPageState?.passed ? (
    <div className="absolute left-4 top-4 z-[120]">
      <Badge className="gap-1 bg-emerald-600 text-white">
        <CheckCircle2 className="size-3.5" />
        {t('revisit.challenge.gate.pass')}
      </Badge>
    </div>
  ) : null;

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="flex h-screen flex-col overflow-hidden">
          <ClassroomStage
            revisitConfig={{
              participants: revisitParticipants,
              headerSlot,
              canvasOverlay,
              currentSpeech: liveSpeech,
              engineMode: running ? 'live' : 'idle',
              isStreaming: running,
              speakingAgentId,
              audioIndicatorState,
              audioAgentId,
              thinkingState: running && !speakingAgentId ? { stage: 'director' } : null,
              onMessageSend: submitTurn,
              onPrevScene: () => navigatePage(pageIndex - 1),
              onNextScene: () => navigatePage(pageIndex + 1),
              onSceneSelect: navigateScene,
              canGoPrev,
              canGoNext,
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
      })),
  ];
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
}: {
  title: string;
  detail?: string;
  loading?: boolean;
  onBack?: () => void;
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
        {onBack ? (
          <Button onClick={onBack} variant="outline">
            <ArrowLeft />
            {t('common.back')}
          </Button>
        ) : null}
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
