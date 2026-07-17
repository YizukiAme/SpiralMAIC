'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  CalendarCheck,
  CheckCircle2,
  Clock,
  Clock3,
  FlaskConical,
  Library,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { StudyStudio } from '@/components/revisit/studio';
import { RevisitReport } from '@/components/revisit/revisit-report';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  clearRevisitDemoData,
  listRevisitDemoSessionContents,
  type RevisitDemoSessionContents,
} from '@/lib/revisit/db';
import {
  advanceRevisitDemoClock,
  restoreRealRevisitClock,
  startRevisitDemoClock,
} from '@/lib/revisit/clock';
import {
  getRevisitAttemptCardSummary,
  getRevisitAttemptAction,
  getRevisitHistoryCardInteraction,
  isRevisitAttemptReplayable,
  selectDefaultRevisitAttempt,
  shouldWarnLowBenefitRevisit,
} from '@/lib/revisit/history';
import type { RevisitPanelSection } from '@/lib/revisit/home-surface';
import type { RevisitPanelSummary } from '@/lib/revisit/panel-summary';
import { demoRevisitScope, type RevisitDataScope } from '@/lib/revisit/scope';
import type { RevisitAttempt, RevisitJudgeReport, StudyArtifact } from '@/lib/revisit/types';
import type { StageListItem } from '@/lib/utils/stage-storage';
import { cn } from '@/lib/utils';
import { RevisitDemoBadge } from '@/components/revisit/demo-badge';
import { useArtifactGenerationStore } from '@/lib/store/artifact-generation';
import { useSettingsStore } from '@/lib/store/settings';

const REVISIT_CLOCK_STEPS = [1, 6, 24, 72, 168] as const;

interface RevisitReviewPanelProps {
  open: boolean;
  activeSection: RevisitPanelSection;
  onActiveSectionChange: (section: RevisitPanelSection) => void;
  onOpenChange: (open: boolean) => void;
  classroom: StageListItem | null;
  summary: RevisitPanelSummary | null;
  loading: boolean;
  error: string | null;
  canStart: boolean;
  dataScope: RevisitDataScope;
  onOpenClassroom: (stageId: string) => void;
  onStart: (classroom: StageListItem) => void | Promise<void>;
  onOpenAttempt: (attempt: RevisitAttempt, scope: RevisitDataScope) => void;
  onConfigureProvider: () => void;
  onOpenArtifact: (
    artifact: StudyArtifact,
    scope: RevisitDataScope,
    returnSection: RevisitPanelSection,
  ) => void;
  onClearDemoData: () => void;
  onRefresh: () => void | Promise<void>;
  formatDateTime: (timestamp: number) => string;
  formatSuggestedReview: (timestamp: number | null) => string;
}

export function RevisitReviewPanel({
  open,
  activeSection,
  onActiveSectionChange,
  onOpenChange,
  classroom,
  summary,
  loading,
  error,
  canStart,
  dataScope,
  onOpenClassroom,
  onStart,
  onOpenAttempt,
  onConfigureProvider,
  onOpenArtifact,
  onClearDemoData,
  onRefresh,
  formatDateTime,
  formatSuggestedReview,
}: RevisitReviewPanelProps) {
  const { t } = useI18n();
  const lessonCompleted = Boolean(summary?.completedAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[85vh] w-[min(960px,calc(100vw-24px))] max-w-none overflow-hidden border-border/60 bg-gradient-to-b from-slate-50/95 to-slate-100/95 p-0 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:from-slate-950/95 dark:to-slate-900/95">
        <DialogTitle className="sr-only">{t('revisit.panel.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('revisit.panel.description')}</DialogDescription>
        <Tabs
          value={activeSection}
          onValueChange={(value) => onActiveSectionChange(value as RevisitPanelSection)}
          // flex-row needs ! — the Tabs base class sets flex-col via a
          // data-[orientation] selector whose specificity beats md:flex-row
          className="flex h-full min-h-0 md:flex-row!"
        >
          <aside className="hidden w-52 shrink-0 border-r border-border/60 bg-white/45 p-4 backdrop-blur-xl md:block dark:border-white/10 dark:bg-slate-950/35">
            <p className="mb-4 truncate px-2 text-sm font-semibold">
              {classroom?.name ?? 'Spiral'}
            </p>
            <nav className="space-y-1">
              <SidebarButton
                active={activeSection === 'challenge'}
                icon={<BrainCircuit />}
                label={t('revisit.tabs.challenge')}
                onClick={() => onActiveSectionChange('challenge')}
              />
              <SidebarButton
                active={activeSection === 'materials'}
                icon={<Library />}
                label={t('revisit.tabs.materials')}
                onClick={() => onActiveSectionChange('materials')}
              />
              <SidebarButton
                active={activeSection === 'demo'}
                icon={<FlaskConical />}
                label={t('revisit.tabs.demo')}
                onClick={() => onActiveSectionChange('demo')}
              />
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="shrink-0 border-b border-border/60 bg-white/45 px-4 py-4 pr-12 backdrop-blur-xl sm:px-6 dark:border-white/10 dark:bg-slate-900/45">
              <div className="md:hidden">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-base font-semibold">
                    {classroom?.name ?? 'Spiral'}
                  </p>
                  <RevisitDemoBadge
                    scope={dataScope}
                    className="max-w-24 shrink-0 truncate border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  />
                </div>
                <TabsList className="mt-3 grid w-full grid-cols-3">
                  <TabsTrigger value="challenge" className="min-w-0 gap-1 px-1 text-[11px]">
                    <BrainCircuit />
                    <span className="truncate">{t('revisit.tabs.challenge')}</span>
                  </TabsTrigger>
                  <TabsTrigger value="materials" className="min-w-0 gap-1 px-1 text-[11px]">
                    <Library />
                    <span className="truncate">{t('revisit.tabs.materials')}</span>
                  </TabsTrigger>
                  <TabsTrigger value="demo" className="min-w-0 gap-1 px-1 text-[11px]">
                    <FlaskConical />
                    <span className="truncate">{t('revisit.tabs.demo')}</span>
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="hidden items-start justify-between gap-4 md:flex">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">
                    {activeSection === 'challenge'
                      ? t('revisit.tabs.challenge')
                      : activeSection === 'materials'
                        ? t('revisit.studio.title')
                        : t('revisit.demo.title')}
                  </h2>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {activeSection === 'challenge'
                      ? t('revisit.panel.title')
                      : activeSection === 'materials'
                        ? t('revisit.studio.subtitle')
                        : t('revisit.demo.subtitle')}
                  </p>
                </div>
                <RevisitDemoBadge scope={dataScope} />
              </div>
            </header>

            {error ? (
              <div className="mx-4 mt-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-6">
                {error}
              </div>
            ) : null}

            <TabsContent value="challenge" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              {loading && !summary ? (
                <PanelLoadingState />
              ) : summary ? (
                <ReverseChallengeHistory
                  classroom={classroom}
                  summary={summary}
                  loading={loading}
                  error={error}
                  canStart={canStart}
                  dataScope={dataScope}
                  onOpenClassroom={onOpenClassroom}
                  onStart={onStart}
                  onOpenAttempt={onOpenAttempt}
                  onConfigureProvider={onConfigureProvider}
                  formatDateTime={formatDateTime}
                  formatSuggestedReview={formatSuggestedReview}
                />
              ) : null}
            </TabsContent>

            <TabsContent value="materials" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              {loading && !summary ? (
                <PanelLoadingState />
              ) : (
                <StudyStudio
                  classroom={classroom}
                  artifacts={summary?.artifacts ?? []}
                  lessonCompleted={lessonCompleted}
                  canGenerate={canStart}
                  disabled={Boolean(error)}
                  dataScope={dataScope}
                  onOpenClassroom={onOpenClassroom}
                  onConfigureProvider={onConfigureProvider}
                  onOpenArtifact={(artifact) => onOpenArtifact(artifact, dataScope, 'materials')}
                  onRefresh={onRefresh}
                  formatDateTime={formatDateTime}
                />
              )}
            </TabsContent>

            <TabsContent value="demo" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              <DemoBox
                active={activeSection === 'demo'}
                classroom={classroom}
                onOpenAttempt={onOpenAttempt}
                onOpenArtifact={(artifact, scope) => onOpenArtifact(artifact, scope, 'demo')}
                onClear={onClearDemoData}
                formatDateTime={formatDateTime}
              />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ReverseChallengeHistory({
  classroom,
  summary,
  loading,
  error,
  canStart,
  dataScope,
  onOpenClassroom,
  onStart,
  onOpenAttempt,
  onConfigureProvider,
  formatDateTime,
  formatSuggestedReview,
}: {
  classroom: StageListItem | null;
  summary: RevisitPanelSummary;
  loading: boolean;
  error: string | null;
  canStart: boolean;
  dataScope: RevisitDataScope;
  onOpenClassroom: (stageId: string) => void;
  onStart: (classroom: StageListItem) => void | Promise<void>;
  onOpenAttempt: (attempt: RevisitAttempt, scope: RevisitDataScope) => void;
  onConfigureProvider: () => void;
  formatDateTime: (timestamp: number) => string;
  formatSuggestedReview: (timestamp: number | null) => string;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lowBenefitOpen, setLowBenefitOpen] = useState(false);
  const attempts = summary.attempts;
  const unfinished = attempts.find((attempt) => attempt.status !== 'completed');
  const defaultAttempt = useMemo(() => selectDefaultRevisitAttempt(attempts), [attempts]);
  const selected = attempts.find((attempt) => attempt.attemptId === selectedId) ?? defaultAttempt;
  const report = selected
    ? summary.reports.find((item) => item.attemptId === selected.attemptId)
    : undefined;
  const memory = summary.memorySummary;
  const recallPercent = memory.recall == null ? null : Math.round(memory.recall * 100);
  const lessonCompleted = Boolean(summary.completedAt);

  const requestNew = () => {
    if (!classroom) return;
    if (!lessonCompleted) {
      onOpenClassroom(classroom.id);
      return;
    }
    if (!canStart) {
      onConfigureProvider();
      return;
    }
    if (
      shouldWarnLowBenefitRevisit({
        recall: memory.recall,
        hasUnfinishedAttempt: Boolean(unfinished),
        hasPendingAssessment: summary.pendingAssessmentCount > 0,
      })
    ) {
      setLowBenefitOpen(true);
      return;
    }
    void onStart(classroom);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2.5 border-b pb-5 sm:grid-cols-2 xl:grid-cols-3">
        <SummaryMetric
          label={t('revisit.panel.currentMemory')}
          value={recallPercent == null ? t('revisit.panel.none') : `${recallPercent}%`}
          icon={<BrainCircuit />}
          accent={memory.color}
        />
        <SummaryMetric
          label={t('revisit.panel.suggestedReview')}
          value={formatSuggestedReview(summary.suggestedReviewAt)}
          icon={<Clock />}
        />
        <SummaryMetric
          label={t('revisit.panel.pendingAssessment')}
          value={String(summary.pendingAssessmentCount)}
          icon={<CalendarCheck />}
        />
        <SummaryMetric
          label={t('revisit.panel.createdAt')}
          value={formatDateTime(summary.startedAt)}
          icon={<Clock />}
        />
        <SummaryMetric
          label={t('revisit.panel.completedAt')}
          value={
            summary.completedAt
              ? formatDateTime(summary.completedAt)
              : t('revisit.panel.notRecorded')
          }
          icon={<CalendarCheck />}
        />
        <SummaryMetric
          label={t('revisit.panel.quizAccuracy')}
          value={
            summary.quiz
              ? `${summary.quiz.correct}/${summary.quiz.total} · ${summary.quiz.pct}%`
              : t('revisit.panel.noQuiz')
          }
          icon={<CheckCircle2 />}
        />
      </div>

      <div className="grid min-h-[360px] gap-5 md:grid-cols-[minmax(250px,0.9fr)_minmax(0,1.25fr)]">
        <section className="border-b pb-4 md:border-r md:border-b-0 md:pr-4 md:pb-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t('revisit.history.title')}</h3>
            <Badge variant="secondary">{attempts.length}</Badge>
          </div>
          <div className="space-y-4">
            {attempts.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
                {t('revisit.history.empty')}
              </p>
            ) : (
              attempts.map((attempt) => {
                const attemptReport = summary.reports.find(
                  (item) => item.attemptId === attempt.attemptId,
                );
                return (
                  <ReverseHistoryCard
                    key={attempt.attemptId}
                    attempt={attempt}
                    report={attemptReport}
                    selected={selected?.attemptId === attempt.attemptId}
                    disabled={loading || Boolean(error)}
                    onSelect={() => setSelectedId(attempt.attemptId)}
                    onAction={() => onOpenAttempt(attempt, dataScope)}
                    formatDateTime={formatDateTime}
                  />
                );
              })
            )}
          </div>

          {!unfinished ? (
            <Button
              className="mt-3 w-full"
              disabled={loading || Boolean(error)}
              onClick={requestNew}
            >
              <BrainCircuit />
              {!lessonCompleted
                ? t('revisit.panel.completeCourseFirst')
                : canStart
                  ? t('revisit.history.generateNew')
                  : t('home.configureProvider')}
            </Button>
          ) : null}
        </section>

        <section className="min-w-0">
          {selected ? (
            <AttemptDetails attempt={selected} report={report} formatDateTime={formatDateTime} />
          ) : (
            <div className="flex min-h-[280px] items-center justify-center border-y text-center">
              <div>
                <BrainCircuit className="mx-auto size-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">{t('revisit.history.empty')}</p>
              </div>
            </div>
          )}
        </section>
      </div>

      <AlertDialog open={lowBenefitOpen} onOpenChange={setLowBenefitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('revisit.lowBenefit.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('revisit.lowBenefit.description', {
                percent: recallPercent ?? 0,
                date: formatSuggestedReview(summary.suggestedReviewAt),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel>{t('revisit.lowBenefit.later')}</AlertDialogCancel>
            <Button
              onClick={() => {
                setLowBenefitOpen(false);
                if (classroom) void onStart(classroom);
              }}
            >
              {t('revisit.lowBenefit.generateAnyway')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ReverseHistoryCard({
  attempt,
  report,
  selected,
  disabled,
  onSelect,
  onAction,
  formatDateTime,
}: {
  attempt: RevisitAttempt;
  report?: RevisitJudgeReport;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onAction: () => void;
  formatDateTime: (timestamp: number) => string;
}) {
  const { t } = useI18n();
  const { click } = getRevisitHistoryCardInteraction(attempt);
  const { pageCount, readyPageCount, previewSlide } = getRevisitAttemptCardSummary(attempt, report);
  const pageLabel =
    attempt.status !== 'completed' && readyPageCount < pageCount
      ? `${readyPageCount}/${pageCount}`
      : String(pageCount);
  const selectCard = () => onSelect();
  const openCard = () => {
    onSelect();
    if (click !== 'none' && !disabled) onAction();
  };

  return (
    <article
      className="group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-muted-foreground/35 focus-visible:ring-offset-2"
      role="button"
      tabIndex={0}
      aria-label={`Reverse ${attempt.sequence}`}
      aria-pressed={selected}
      aria-disabled={click !== 'none' && disabled}
      onMouseEnter={selectCard}
      onFocus={selectCard}
      onClick={openCard}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openCard();
        }
      }}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-slate-100 transition-transform duration-200 group-hover:scale-[1.02] dark:bg-slate-800/80">
        {previewSlide ? (
          <SlideThumbnail
            slide={previewSlide}
            viewportRatio={previewSlide.viewportRatio ?? 0.5625}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-background/70 shadow-sm">
              <BrainCircuit className="size-6 opacity-55" />
            </div>
          </div>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-2 px-1">
        <span className="inline-flex max-w-[65%] shrink-0 items-center rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
          <span className="truncate">
            {pageLabel} {t('classroom.slides')} ·{' '}
            {formatDateTime(attempt.completedAt ?? attempt.createdAt)}
          </span>
        </span>
        <p className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground/90">
          Reverse {attempt.sequence}
        </p>
      </div>
    </article>
  );
}

function AttemptDetails({
  attempt,
  report,
  formatDateTime,
}: {
  attempt: RevisitAttempt;
  report?: RevisitJudgeReport;
  formatDateTime: (timestamp: number) => string;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <div className="border-b pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">Reverse {attempt.sequence}</h3>
            <Badge variant={attempt.status === 'completed' ? 'default' : 'secondary'}>
              {attempt.status === 'completed'
                ? t('revisit.history.completed')
                : t('revisit.history.unfinished')}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDateTime(attempt.completedAt ?? attempt.createdAt)} ·{' '}
            {getAttemptSecondaryLabel(attempt, t)}
          </p>
        </div>
      </div>

      {attempt.preparationError ? (
        <div className="flex gap-2 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {attempt.preparationError}
        </div>
      ) : null}

      {report ? (
        <RevisitReport
          report={report}
          density="compact"
          conceptLabelsById={Object.fromEntries(
            (attempt.blueprint?.concepts ?? []).map((concept) => [concept.id, concept.label]),
          )}
        />
      ) : (
        <div className="rounded-md border border-dashed px-4 py-10 text-center">
          {attempt.status === 'completed' ? (
            <CheckCircle2 className="mx-auto size-7 text-muted-foreground" />
          ) : (
            <Clock className="mx-auto size-7 text-muted-foreground" />
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            {attempt.status === 'completed'
              ? t('revisit.report.unavailable')
              : t('revisit.history.awaitingCompletion')}
          </p>
        </div>
      )}
    </div>
  );
}

function DemoBox({
  active,
  classroom,
  onOpenAttempt,
  onOpenArtifact,
  onClear,
  formatDateTime,
}: {
  active: boolean;
  classroom: StageListItem | null;
  onOpenAttempt: (attempt: RevisitAttempt, scope: RevisitDataScope) => void;
  onOpenArtifact: (artifact: StudyArtifact, scope: RevisitDataScope) => void;
  onClear: () => void;
  formatDateTime: (timestamp: number) => string;
}) {
  const { t } = useI18n();
  const [contents, setContents] = useState<RevisitDemoSessionContents[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const artifactJobs = useArtifactGenerationStore((state) => state.jobs);
  const cancelArtifactJob = useArtifactGenerationStore((state) => state.cancel);
  const activeDemoSessionByStage = useSettingsStore(
    (state) => state.activeRevisitDemoSessionByStage,
  );
  const offsetHoursByStage = useSettingsStore(
    (state) => state.revisitVirtualClockOffsetHoursByStage,
  );
  const setActiveDemoSession = useSettingsStore((state) => state.setActiveRevisitDemoSession);
  const setOffsetHours = useSettingsStore((state) => state.setRevisitVirtualClockOffsetHours);
  const stageId = classroom?.id;
  const activeDemoSessionId = stageId ? activeDemoSessionByStage[stageId] : undefined;
  const offsetHours = stageId ? (offsetHoursByStage[stageId] ?? 0) : 0;

  const refresh = useCallback(async () => {
    if (!stageId) {
      setContents([]);
      return;
    }
    setLoading(true);
    try {
      setContents(await listRevisitDemoSessionContents(stageId));
    } finally {
      setLoading(false);
    }
  }, [stageId]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const advanceClock = async (hours: number) => {
    if (!stageId) return;
    setClockBusy(true);
    setClockError(null);
    try {
      const session = activeDemoSessionId
        ? await advanceRevisitDemoClock(activeDemoSessionId, hours)
        : await startRevisitDemoClock({ stageId });
      const advanced = activeDemoSessionId
        ? session
        : await advanceRevisitDemoClock(session.id, hours);
      setActiveDemoSession(stageId, advanced.id);
      setOffsetHours(stageId, advanced.offsetHours);
      await refresh();
    } catch (error) {
      setClockError(error instanceof Error ? error.message : String(error));
    } finally {
      setClockBusy(false);
    }
  };

  const restoreClock = async () => {
    if (!stageId || !activeDemoSessionId) return;
    setClockBusy(true);
    setClockError(null);
    try {
      await restoreRealRevisitClock(activeDemoSessionId);
      setActiveDemoSession(stageId, null);
      await refresh();
    } catch (error) {
      setClockError(error instanceof Error ? error.message : String(error));
    } finally {
      setClockBusy(false);
    }
  };

  const simulatedAt = new Date(Date.now() + offsetHours * 60 * 60 * 1000);

  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-lg border bg-muted/15 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Clock3 className="size-4" />
              {t('settings.revisit.virtualClock')}
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('settings.revisit.virtualClockDetail')}
            </p>
          </div>
          {clockBusy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>
        <div className="rounded-md bg-muted/45 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('settings.revisit.simulatedTime')}</p>
          <p className="mt-1 text-sm font-medium tabular-nums">
            {activeDemoSessionId ? simulatedAt.toLocaleString() : t('settings.revisit.realTime')}
          </p>
          {activeDemoSessionId ? (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('settings.revisit.demoOffset', { hours: offsetHours })}
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {REVISIT_CLOCK_STEPS.map((hours) => (
            <Button
              key={hours}
              type="button"
              variant="outline"
              size="sm"
              disabled={!stageId || clockBusy || offsetHours >= 168}
              onClick={() => void advanceClock(hours)}
            >
              +{hours < 24 ? `${hours}h` : `${hours / 24}d`}
            </Button>
          ))}
        </div>
        {activeDemoSessionId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={clockBusy}
            onClick={() => void restoreClock()}
          >
            <RotateCcw />
            {t('settings.revisit.restoreRealTime')}
          </Button>
        ) : null}
        {clockError ? <p className="text-xs text-destructive">{clockError}</p> : null}
      </section>

      <div className="flex items-center justify-between gap-3 border-b pb-4">
        <div>
          <h3 className="text-sm font-semibold">{t('revisit.demo.batches')}</h3>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('revisit.demo.batches')}
            onClick={() => void refresh()}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
          {contents.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setClearOpen(true)}>
              <Trash2 />
              {t('revisit.demo.clear')}
            </Button>
          ) : null}
        </div>
      </div>

      {contents.length === 0 && !loading ? (
        <div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
          <FlaskConical className="mx-auto mb-3 size-7" />
          {t('revisit.demo.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {contents.map((content) => {
            const scope = demoRevisitScope(content.session.id);
            return (
              <section key={content.session.id} className="rounded-md border">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold">
                        {t('revisit.demo.batchName', {
                          date: formatDateTime(content.session.createdAt),
                        })}
                      </h4>
                      <Badge
                        variant={content.session.status === 'active' ? 'default' : 'secondary'}
                      >
                        {t(`revisit.demo.${content.session.status}`)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      +{content.session.offsetHours}h ·{' '}
                      {formatDateTime(content.session.simulatedAt ?? content.session.updatedAt)}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('revisit.demo.counts', {
                      attempts: content.attempts.length,
                      reports: content.reports.length,
                      artifacts: content.artifacts.length,
                      practice: content.practiceCount,
                    })}
                  </p>
                </header>
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">Reverse</p>
                    <div className="space-y-1">
                      {content.attempts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('revisit.panel.none')}</p>
                      ) : (
                        content.attempts.slice(0, 6).map((attempt) => (
                          <button
                            key={attempt.attemptId}
                            type="button"
                            disabled={getRevisitAttemptAction(attempt) === 'none'}
                            className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-default disabled:opacity-60"
                            onClick={() => onOpenAttempt(attempt, scope)}
                          >
                            <span>Reverse {attempt.sequence}</span>
                            <span className="text-xs text-muted-foreground">
                              {attempt.status === 'completed'
                                ? t('revisit.history.completed')
                                : t('revisit.history.unfinished')}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">
                      {t('revisit.tabs.materials')}
                    </p>
                    <div className="space-y-1">
                      {content.artifacts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t('revisit.panel.none')}</p>
                      ) : (
                        content.artifacts.slice(0, 6).map((artifact) => (
                          <button
                            key={artifact.id}
                            type="button"
                            className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-muted"
                            onClick={() => onOpenArtifact(artifact, scope)}
                          >
                            <span className="truncate">{artifact.title}</span>
                            <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                              v{artifact.version}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                  {content.reports.length > 0 ? (
                    <div className="border-t pt-3 md:col-span-2">
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">
                        {t('revisit.challenge.report')}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {content.reports.slice(0, 4).map((report) => (
                          <div
                            key={report.attemptId}
                            className="flex gap-3 border-l-2 border-primary/30 pl-3"
                          >
                            <span className="shrink-0 text-sm font-semibold tabular-nums">
                              {Math.round(report.q * 100)}%
                            </span>
                            <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                              {report.summary}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {content.practice.length > 0 ? (
                    <div className="border-t pt-3 md:col-span-2">
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">
                        {t('revisit.studio.groups.practice.title')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {content.practice.slice(0, 6).map((practice) => {
                          const artifact = content.artifacts.find(
                            (item) => item.id === practice.artifactId,
                          );
                          return (
                            <Badge key={practice.artifactId} variant="secondary">
                              {artifact?.title ?? practice.kind} ·{' '}
                              {practice.completedAt
                                ? t('revisit.history.completed')
                                : t('revisit.history.unfinished')}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('revisit.demo.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('revisit.demo.clearDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (!stageId) return;
                const sessionScopes = new Set(
                  contents.map((content) => `demo:${content.session.id}`),
                );
                for (const job of artifactJobs) {
                  if (
                    job.scope &&
                    sessionScopes.has(job.scope) &&
                    (job.status === 'queued' || job.status === 'generating')
                  ) {
                    cancelArtifactJob(job.id);
                  }
                }
                void clearRevisitDemoData(stageId).then(() => {
                  setClearOpen(false);
                  setContents([]);
                  onClear();
                });
              }}
            >
              {t('revisit.demo.clear')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function getAttemptSecondaryLabel(
  attempt: RevisitAttempt,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (attempt.reportOnly) return t('revisit.history.reportOnly');
  if (attempt.preparationError) return t('revisit.history.preparationFailed');
  if (attempt.status === 'preparing') return t('revisit.history.preparing');
  if (attempt.status === 'ready') return t('revisit.history.ready');
  return isRevisitAttemptReplayable(attempt)
    ? t('revisit.history.replayable')
    : t('revisit.history.reportOnly');
}

function SidebarButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted',
      )}
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function PanelLoadingState() {
  return (
    <div className="grid gap-3">
      <div className="h-16 animate-pulse rounded-md bg-muted/60" />
      <div className="h-64 animate-pulse rounded-md bg-muted/40" />
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-md border border-border/60 bg-background/55 px-3.5 py-3 shadow-sm shadow-slate-950/5 backdrop-blur-sm dark:bg-slate-900/35 dark:shadow-black/10">
      <span
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: accent ?? 'var(--muted-foreground)' }}
        aria-hidden="true"
      />
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/70 text-muted-foreground [&_svg]:size-4"
          style={accent ? { color: accent } : undefined}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-base font-semibold leading-tight text-foreground/90">{value}</p>
        </div>
      </div>
    </div>
  );
}
