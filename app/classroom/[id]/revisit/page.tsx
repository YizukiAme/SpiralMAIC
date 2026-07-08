'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  Loader2,
  Mic,
  Send,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';

import { SpeechButton } from '@/components/audio/speech-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { ensureRevisitBlueprint, submitRevisitAttempt } from '@/lib/revisit/client';
import {
  createRevisitChatRequest,
  createTeacherRevisitMessage,
  REVISIT_ASSISTANT_AGENT_ID,
  REVISIT_PAGE_PROBE_CAP,
  resolveRevisitAgentIds,
  type RevisitMessage,
  type RevisitSessionPageState,
} from '@/lib/revisit/session';
import type {
  RevisitExamBlueprint,
  RevisitGateDecision,
  RevisitJudgeReport,
  RevisitPageReport,
} from '@/lib/revisit/types';
import type { StatelessEvent, DirectorState } from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';
import { loadStageData } from '@/lib/utils/stage-storage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { resolveAgentVoiceOptions } from '@/lib/audio/agent-voice';
import {
  BROWSER_NATIVE_TTS_PROVIDER_ID,
  isTTSProviderEnabled,
} from '@/lib/audio/provider-enablement';

interface LoadedClassroom {
  stage: Stage;
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

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [classroom, setClassroom] = useState<LoadedClassroom | null>(null);
  const [blueprint, setBlueprint] = useState<RevisitExamBlueprint | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageStates, setPageStates] = useState<RevisitSessionPageState[]>([]);
  const [messages, setMessages] = useState<RevisitMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [judging, setJudging] = useState(false);
  const [report, setReport] = useState<RevisitJudgeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [directorState, setDirectorState] = useState<DirectorState | undefined>();
  const [attemptId] = useState(() => `revisit-${Date.now()}`);
  const [startedAt] = useState(() => Date.now());
  const [lastGate, setLastGate] = useState<RevisitGateDecision | null>(null);
  const transcriptRef = useRef<RevisitMessage[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    transcriptRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

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
  const progressLabel = t('revisit.challenge.progress', {
    current: pages.length ? pageIndex + 1 : 0,
    total: pages.length,
  });

  const updatePageState = useCallback((index: number, update: Partial<RevisitSessionPageState>) => {
    setPageStates((prev) =>
      prev.map((state, stateIndex) => (stateIndex === index ? { ...state, ...update } : state)),
    );
  }, []);

  const advancePage = useCallback(() => {
    setPageIndex((prev) => Math.min(prev + 1, Math.max(0, pages.length - 1)));
  }, [pages.length]);

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
        if (pageIndex < pages.length - 1) advancePage();
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
    [
      advancePage,
      blueprint,
      currentPage,
      currentPageState,
      pageIndex,
      pages.length,
      updatePageState,
    ],
  );

  async function submitTurn() {
    const text = draft.trim();
    if (!text || !classroom || !blueprint || !currentPageState || running || judging || report) {
      return;
    }

    const teacherMessage = createTeacherRevisitMessage(text);
    const nextMessages = [...transcriptRef.current, teacherMessage];
    setMessages(nextMessages);
    setDraft('');

    if (demoGateSkipEnabled) {
      updatePageState(pageIndex, { passed: true });
      setLastGate({
        status: 'pass',
        pageIndex,
        reason: 'demo-skip',
        confidence: 1,
      });
      if (pageIndex < pages.length - 1) advancePage();
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
        agentIds: resolveRevisitAgentIds(useAgentRegistry.getState().listAgents()),
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
      await readChatStream(response);
    } catch (err) {
      toast.error(t('revisit.challenge.chatFailed'));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function readChatStream(response: Response) {
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
          role: event.data.agentId === REVISIT_ASSISTANT_AGENT_ID ? 'assistant' : 'student',
          agentId: event.data.agentId,
          agentName: event.data.agentName,
          text: '',
          createdAt: Date.now(),
        };
        agentTextByMessageId[event.data.messageId] = '';
        agentIdByMessageId[event.data.messageId] = event.data.agentId;
        setMessages((prev) => [...prev, nextMessage]);
      } else if (event.type === 'text_delta' && event.data.messageId) {
        agentTextByMessageId[event.data.messageId] =
          (agentTextByMessageId[event.data.messageId] || '') + event.data.content;
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
          void playAgentSpeech(text, agentId);
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

  async function playAgentSpeech(text: string, agentId: string) {
    const settings = useSettingsStore.getState();
    if (!settings.ttsEnabled || settings.ttsMuted || !text.trim()) return;

    if (settings.ttsProviderId === BROWSER_NATIVE_TTS_PROVIDER_ID) {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (classroom?.stage.languageDirective) {
        utterance.lang = classroom.stage.languageDirective;
      }
      utterance.rate = settings.ttsSpeed;
      utterance.volume = settings.ttsVolume;
      window.speechSynthesis.speak(utterance);
      return;
    }

    const providerConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
    if (!isTTSProviderEnabled(settings.ttsProviderId, providerConfig)) return;

    try {
      const agent = useAgentRegistry.getState().getAgent(agentId);
      const providerOptions = await resolveAgentVoiceOptions(agent, {
        providerId: settings.ttsProviderId,
        providerConfig,
        voiceId: settings.ttsVoice,
        language: classroom?.stage.languageDirective,
      });
      const response = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          audioId: `revisit-${Date.now()}`,
          ttsProviderId: settings.ttsProviderId,
          ttsModelId: providerConfig?.modelId,
          ttsVoice: settings.ttsVoice,
          ttsSpeed: settings.ttsSpeed,
          ttsApiKey: providerConfig?.apiKey || undefined,
          ttsBaseUrl: providerConfig?.baseUrl || providerConfig?.customDefaultBaseUrl || undefined,
          ttsProviderOptions: providerOptions,
        }),
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        success?: boolean;
        base64?: string;
        format?: string;
      };
      if (!data.success || !data.base64 || !data.format) return;

      const binary = atob(data.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: `audio/${data.format}` }));
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = blobUrl;
      const audio = new Audio(blobUrl);
      audio.volume = settings.ttsVolume;
      audio.playbackRate = settings.ttsSpeed;
      audioRef.current = audio;
      await audio.play();
    } catch {
      // Voice is helpful, not session-critical.
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
      />
    );
  }

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.back()}
            aria-label={t('common.back')}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{classroom.stage.name}</h1>
            <p className="text-xs text-muted-foreground">{progressLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastGate ? (
            <Badge variant={lastGate.status === 'pass' ? 'default' : 'secondary'}>
              {t(`revisit.challenge.gate.${lastGate.status}`)}
            </Badge>
          ) : null}
          <Button onClick={finishChallenge} disabled={judging || running || messages.length === 0}>
            {judging ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            {t('revisit.challenge.finish')}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,0.9fr)_minmax(0,1.4fr)]">
        <aside className="min-h-0 border-b bg-muted/20 p-4 lg:border-b-0 lg:border-r">
          <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <Badge variant="secondary">
                {t('revisit.challenge.passed', { count: passedCount, total: pages.length })}
              </Badge>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setPageIndex((prev) => Math.max(0, prev - 1))}
                  disabled={pageIndex === 0}
                  aria-label={t('revisit.challenge.previousPage')}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setPageIndex((prev) => Math.min(pages.length - 1, prev + 1))}
                  disabled={pageIndex >= pages.length - 1}
                  aria-label={t('revisit.challenge.nextPage')}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>

            <section className="min-h-0 flex-1 overflow-auto rounded-lg border bg-background p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t('revisit.challenge.skeleton')}
                  </p>
                  <h2 className="mt-1 text-xl font-semibold tracking-normal">
                    {currentPage.title}
                  </h2>
                </div>
                {currentPageState?.passed ? (
                  <CheckCircle2 className="mt-1 size-5 shrink-0 text-emerald-500" />
                ) : null}
              </div>
              <p className="text-sm leading-6 text-muted-foreground">{currentPage.summary}</p>
              <div className="mt-5 space-y-2">
                {currentPage.cues.map((cue, index) => (
                  <div key={`${cue}-${index}`} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                    {cue}
                  </div>
                ))}
              </div>
              <div className="mt-5 grid gap-2">
                {pages.map((page, index) => (
                  <button
                    key={page.id}
                    onClick={() => setPageIndex(index)}
                    className={cn(
                      'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      index === pageIndex ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                    )}
                  >
                    <span className="truncate">{page.title}</span>
                    {pageStates[index]?.passed ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                    ) : null}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto px-4 py-5">
            {report ? (
              <ReportView report={report} />
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <GraduationCap className="mr-2 size-4" />
                {t('revisit.challenge.emptyTranscript')}
              </div>
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                {running ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t('revisit.challenge.thinking')}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {!report ? (
            <div className="border-t bg-background p-4">
              <div className="mx-auto flex max-w-3xl gap-3">
                <div className="relative min-w-0 flex-1">
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={t('revisit.challenge.teacherPlaceholder')}
                    disabled={running || judging}
                    className="min-h-24 resize-none pr-12"
                  />
                  <SpeechButton
                    size="sm"
                    disabled={running || judging}
                    className="absolute bottom-3 left-3"
                    onTranscription={(text) =>
                      setDraft((prev) => `${prev}${prev ? ' ' : ''}${text}`)
                    }
                  />
                  <Mic className="pointer-events-none absolute bottom-4 right-4 size-4 text-muted-foreground/60" />
                </div>
                <Button
                  className="h-24 w-14 shrink-0"
                  size="icon"
                  onClick={submitTurn}
                  disabled={!draft.trim() || running || judging}
                  aria-label={t('revisit.challenge.send')}
                >
                  {running ? <Loader2 className="animate-spin" /> : <Send />}
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
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

function MessageBubble({ message }: { message: RevisitMessage }) {
  const { t } = useI18n();
  const isTeacher = message.role === 'teacher';
  const label = isTeacher
    ? t('revisit.challenge.teacher')
    : message.role === 'assistant'
      ? t('revisit.challenge.assistant')
      : t('revisit.challenge.student');
  const Icon = isTeacher ? UserRound : message.role === 'assistant' ? Bot : GraduationCap;

  return (
    <div className={cn('flex gap-3', isTeacher && 'flex-row-reverse')}>
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg',
          isTeacher ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className={cn('max-w-[78%] space-y-1', isTeacher && 'items-end text-right')}>
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-sm leading-6 shadow-sm',
            isTeacher ? 'bg-primary text-primary-foreground' : 'bg-background',
          )}
        >
          {message.text || '...'}
        </div>
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
