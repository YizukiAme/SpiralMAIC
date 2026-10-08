'use client';

/**
 * The generation preview: a view of the server-side run that generates the
 * course (RFC #1754 §E). The page renders the run's events (steps, the
 * outline as it streams, the outline review, the agent cards) and sends the
 * run its commands (confirm the outline, retry a failed step); the run itself
 * goes on whether or not this page is open. Once the course's first scene is
 * ready, the classroom takes over.
 */
import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, AlertCircle, ArrowLeft, Bot, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { OutlinesEditor } from '@/components/generation/outlines-editor';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import type { SceneOutline } from '@/lib/types/generation';
import { AgentRevealModal } from '@/components/agent/agent-reveal-modal';
import { createLogger } from '@/lib/logger';
import { RunApiError, runApiErrorText } from '@/lib/generation-run-client/api';
import { toast } from 'sonner';
import { runFailureText, type FailureText } from '@/lib/generation-run-client/failure-message';
import { confirmOutline, holdOutline, retryPausedRun } from '@/lib/generation-run-client/commands';
import { nextPreviewPhase, type PreviewPhase } from '@/lib/generation-run-client/outline-review';
import { previewStepIds, previewStepIndex } from '@/lib/generation-run-client/preview-steps';
import { visibleOutlines } from '@/lib/generation-run-client/reducer';
import { useGenerationRun } from '@/lib/generation-run-client/use-generation-run';
import {
  ALL_STEPS,
  getActiveSteps,
  shouldAutoStartRevisitGeneration,
  type GenerationSessionState,
} from './types';
import { ensureRevisitBlueprint, loadRevisitAdaptiveContext } from '@/lib/revisit/client';
import { generateRevisitSkeletonScene } from '@/lib/revisit/slides';
import {
  getRevisitAttempt,
  importLegacyRevisitAttemptSnapshot,
  saveRevisitAttemptBlueprint,
  saveRevisitAttemptSource,
  setRevisitAttemptSpiralAgentGenerationState,
  setRevisitAttemptPreparationError,
  upsertRevisitAttemptScene,
} from '@/lib/revisit/attempt-store';
import { getRevisitNow } from '@/lib/revisit/clock';
import { parseRevisitScope, serializeRevisitScope } from '@/lib/revisit/scope';
import { loadStageData } from '@/lib/utils/stage-storage';
import { RevisitDemoBadge } from '@/components/revisit/demo-badge';
import {
  getSpiralAgentPreparationAction,
  isValidSpiralAgentRoster,
  saveStageSpiralAgents,
} from '@/lib/revisit/spiral-agents';
import { buildAgentProfileRequestBody } from '@/lib/generation/agent-profile-request';
import { buildModelRequestHeaders, getCurrentModelConfig } from '@/lib/utils/model-config';
import type { PersistedAgentConfig } from '@/lib/types/stage';

import { StepVisualizer } from './components/visualizers';

const log = createLogger('GenerationPreview');

/** The learner opened the outline review of this run (kept across a reload of the page). */
function reviewIntentKey(runId: string): string {
  return `generationRunReviewIntent:${runId}`;
}

function readReviewIntent(runId: string): boolean {
  try {
    return sessionStorage.getItem(reviewIntentKey(runId)) === '1';
  } catch {
    return false;
  }
}

function writeReviewIntent(runId: string, intent: boolean): void {
  try {
    if (intent) sessionStorage.setItem(reviewIntentKey(runId), '1');
    else sessionStorage.removeItem(reviewIntentKey(runId));
  } catch {
    /* sessionStorage unavailable: the intent lasts for this page only */
  }
}

function CourseGenerationPreview() {
  const router = useRouter();
  const { t } = useI18n();
  const runId = useSearchParams().get('run');
  const { view, status, caughtUp, refresh } = useGenerationRun(runId);
  const capabilities = useModelCapabilities();

  // Sticky: true once the learner opens the review of a run that waits for
  // it while the outline streams, until they collapse it again (kept across a
  // reload).
  const outlineReviewIntentRef = useRef(false);
  // The phase the outline step is shown in: the progress card or the review editor.
  const [phase, setPhase] = useState<PreviewPhase>('progress');
  const [editedOutlines, setEditedOutlines] = useState<SceneOutline[] | null>(null);
  const [isConfirmingOutlines, setIsConfirmingOutlines] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  // This page's confirmation lost to one made elsewhere: its edits stay shown.
  const [confirmConflict, setConfirmConflict] = useState(false);
  // The seq of a step Retry: the run shows as retrying until a step starts after it.
  const [retrySeq, setRetrySeq] = useState<number | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  // The agent cards were shown and are still being revealed: the classroom
  // waits for them, as generation did.
  const [agentRevealPending, setAgentRevealPending] = useState(false);
  const agentRevealShownRef = useRef(false);
  // Whether this page has caught up with the run yet.
  const attachedRef = useRef(false);
  const reviewOutlineEnabled = useSettingsStore((s) => s.reviewOutlineEnabled);
  const setReviewOutlineEnabled = useSettingsStore((s) => s.setReviewOutlineEnabled);

  useEffect(() => {
    if (runId) outlineReviewIntentRef.current = readReviewIntent(runId);
  }, [runId]);

  const steps = useMemo(() => {
    if (!view) return [];
    const ids = previewStepIds({
      webSearch: !!capabilities.webSearch,
      autoAgents: view.input.agents.mode === 'auto',
    });
    return ids.map((id) => ALL_STEPS.find((step) => step.id === id)!);
  }, [view, capabilities.webSearch]);
  const currentStepIndex = view
    ? previewStepIndex(
        view,
        steps.map((step) => step.id),
      )
    : 0;

  const outlines = view ? visibleOutlines(view) : [];
  const isOutlineStreaming =
    !!view && (view.state === 'preparing' || view.state === 'outlining') && !view.outline;
  // The run confirms its own outline at its deadline unless the learner holds it.
  const outlineCountdown = view?.input.outlineReview === 'countdown';

  const sendConfirm = async (edits: SceneOutline[] | null) => {
    if (!view?.outline) return;
    setIsConfirmingOutlines(true);
    setCommandError(null);
    try {
      await confirmOutline(view, edits ?? undefined);
      outlineReviewIntentRef.current = false;
      writeReviewIntent(view.runId, false);
      setPhase('progress');
      void refresh();
    } catch (error) {
      log.warn('Confirming the outline failed:', error);
      if (error instanceof RunApiError && error.errorCode === 'RUN_STATE_CONFLICT') {
        // Confirmed (or changed) elsewhere: what the learner edited here stays
        // in view, with what happened.
        if (edits) {
          setConfirmConflict(true);
          setPhase('review');
          setCommandError(t('generation.outlineConfirmedElsewhere'));
        }
        await refresh();
      } else if (error instanceof RunApiError) {
        setCommandError(runApiErrorText(error, t));
      } else {
        setCommandError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsConfirmingOutlines(false);
    }
  };
  // A run that waits for its outline shows the review once the outline is
  // ready, in whichever tab or page shows it, until the learner confirms it.
  useEffect(() => {
    if (!view || !caughtUp) return;
    const firstAttach = !attachedRef.current;
    attachedRef.current = true;
    const next = nextPreviewPhase({
      phase,
      state: view.state,
      outlineReview: view.input.outlineReview,
      outlineStreaming: isOutlineStreaming,
      hasOutline: !!view.outline,
      firstAttach,
      reviewIntent: outlineReviewIntentRef.current,
      confirmConflict,
    });
    if (next !== phase) setPhase(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.state, caughtUp]);

  // The generated roster's cards, revealed as generation goes on.
  useEffect(() => {
    if (!view?.generatedAgents || agentRevealShownRef.current) return;
    if (view.input.agents.mode !== 'auto' || view.stageId) return;
    agentRevealShownRef.current = true;
    setAgentRevealPending(true);
    setShowAgentReveal(true);
  }, [view?.generatedAgents, view?.input.agents.mode, view?.stageId]);

  // The first scene is in the course: the classroom takes over.
  // A confirmation that lost to another tab keeps its edits on screen until
  // the learner acknowledges it.
  useEffect(() => {
    if (!view?.stageId || agentRevealPending || confirmConflict) return;
    if (view.state === 'ended') return;
    router.replace(`/classroom/${encodeURIComponent(view.stageId)}`);
  }, [view?.stageId, view?.state, agentRevealPending, confirmConflict, router]);

  // A Retry is queued until a step starts after it (a media item in flight
  // finishes first).
  const retryQueued =
    !!view && retrySeq !== null && view.state !== 'paused' && view.stepStartedSeq <= retrySeq;

  const handleRetry = async () => {
    if (!view || isRetrying) return;
    setIsRetrying(true);
    setCommandError(null);
    try {
      setRetrySeq(await retryPausedRun(view));
      void refresh();
    } catch (error) {
      log.warn('Retrying the run failed:', error);
      if (error instanceof RunApiError && error.errorCode === 'RUN_STATE_CONFLICT') {
        // Retried (or changed) elsewhere.
        toast.info(t('generation.runChangedElsewhere'));
        await refresh();
      } else if (error instanceof RunApiError) {
        setCommandError(runApiErrorText(error, t));
      } else {
        setCommandError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsRetrying(false);
    }
  };

  // Leaving does not stop the run: its course card goes on showing it.
  const goBackToHome = () => {
    router.push('/');
  };

  // Triggered when the user clicks the outline card, mid-stream or on the
  // outline-ready card. A run that would confirm its outline itself is held
  // first: it then waits for the learner's confirmation.
  const handleExpandStreamingOutline = () => {
    if (!view) return;
    outlineReviewIntentRef.current = true;
    writeReviewIntent(view.runId, true);
    setPhase('review');
    if (!outlineCountdown) return;
    void holdOutline(view).catch(async (error) => {
      log.warn('Holding the outline failed:', error);
      if (error instanceof RunApiError && error.errorCode === 'RUN_STATE_CONFLICT') {
        // The run already went on with its outline: the review says so, and
        // its button follows the run.
        setConfirmConflict(true);
        setPhase('review');
        setCommandError(t('generation.outlineAlreadyContinued'));
        await refresh();
      } else if (error instanceof RunApiError) {
        setCommandError(runApiErrorText(error, t));
      } else {
        setCommandError(error instanceof Error ? error.message : String(error));
      }
    });
  };

  // Inverse of expand, while the outline streams: back to the streaming card.
  // Once the outline is ready the run waits for the review, which stays open.
  const handleCollapseEditor = () => {
    if (!view) return;
    outlineReviewIntentRef.current = false;
    writeReviewIntent(view.runId, false);
    setPhase('progress');
  };

  const handleOutlinesChange = (next: SceneOutline[]) => {
    // The editor is read-only while the outline streams.
    if (isOutlineStreaming) return;
    setEditedOutlines(next);
  };

  const handleConfirmOutlines = () => {
    // The outline was confirmed elsewhere: follow the run as it goes.
    if (confirmConflict) {
      setConfirmConflict(false);
      setCommandError(null);
      setPhase('progress');
      return;
    }
    const finalOutlines = editedOutlines ?? outlines;
    if (finalOutlines.length === 0) return;
    void sendConfirm(editedOutlines);
  };

  // The run cannot be read now; the page keeps trying.
  if (status === 'error' && runId) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full">
          <div className="text-center space-y-4">
            <div className="size-8 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mx-auto" />
            <h2 className="text-xl font-semibold">{t('generation.runLoadFailed')}</h2>
            <p className="text-sm text-muted-foreground">{t('generation.runLoadRetrying')}</p>
            <Button variant="outline" onClick={() => router.push('/')} className="w-full">
              <ArrowLeft className="size-4 mr-2" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Still reading the run
  if (status === 'loading' && runId) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <div className="size-8 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </div>
    );
  }

  // No run (or it was discarded)
  if (!view || status === 'missing' || view.state === 'ended') {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full">
          <div className="text-center space-y-4">
            <AlertCircle className="size-12 text-muted-foreground mx-auto" />
            <h2 className="text-xl font-semibold">{t('generation.sessionNotFound')}</h2>
            <p className="text-sm text-muted-foreground">{t('generation.sessionNotFoundDesc')}</p>
            <Button onClick={() => router.push('/')} className="w-full">
              <ArrowLeft className="size-4 mr-2" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const failureSentence = (text: FailureText) => ('key' in text ? t(text.key) : text.text);
  const isReviewingOutlines = phase === 'review';
  // The run confirms its outline itself unless the learner opens the review.
  const isOutlineReady = phase === 'outline-ready';
  const error =
    commandError ??
    (view.state === 'paused' && view.error ? failureSentence(runFailureText(view.error)) : null);
  const paused = view.state === 'paused';
  const statusMessage = view.outlineRetrying
    ? t('generation.outlineRetrying')
    : retryQueued
      ? t('generation.retryingScene')
      : isOutlineReady
        ? t('generation.reviewOutlineAutoContinue')
        : '';
  const webSearchSources = view.researchSources;
  const generatedAgents = view.generatedAgents ?? [];

  const activeStep =
    steps.length > 0 ? steps[Math.min(currentStepIndex, steps.length - 1)] : ALL_STEPS[0];

  if (isReviewingOutlines) {
    const outlineStepIndex = Math.max(
      0,
      steps.findIndex((step) => step.id === 'outline'),
    );
    // Editor source-of-truth: the learner's edit; else the run's outline (the
    // streamed items until it is ready).
    const editorOutlines = editedOutlines ?? outlines;

    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center p-4 relative overflow-hidden">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-4 left-4 z-20"
        >
          <Button variant="ghost" size="sm" onClick={goBackToHome} disabled={isConfirmingOutlines}>
            <ArrowLeft className="size-4 mr-2" />
            {t('generation.backToHome')}
          </Button>
        </motion.div>

        <div className="z-10 w-full max-w-3xl pt-16 pb-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <div className="flex justify-center gap-2">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500',
                    idx < outlineStepIndex
                      ? 'w-1.5 bg-blue-500/30'
                      : idx === outlineStepIndex
                        ? 'w-8 bg-blue-500'
                        : 'w-1.5 bg-muted/50',
                  )}
                />
              ))}
            </div>

            <div className="max-w-2xl space-y-2 text-center mx-auto">
              <h2 className="text-2xl font-bold tracking-tight">
                {t('generation.reviewOutlineTitle')}
              </h2>
              <p className="text-muted-foreground text-sm md:text-base">
                {isOutlineStreaming
                  ? t('generation.reviewOutlineStreamingDesc')
                  : t('generation.reviewOutlineDesc')}
              </p>
            </div>

            {error && (
              <div className="mx-auto max-w-2xl rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
                {error}
              </div>
            )}

            <OutlinesEditor
              outlines={editorOutlines}
              onChange={handleOutlinesChange}
              onConfirm={handleConfirmOutlines}
              onBack={goBackToHome}
              alwaysReview={reviewOutlineEnabled}
              onAlwaysReviewChange={setReviewOutlineEnabled}
              isLoading={isConfirmingOutlines}
              isStreaming={isOutlineStreaming}
              onCollapse={isOutlineStreaming ? handleCollapseEditor : undefined}
            />
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden text-center">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* Back button */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute top-4 left-4 z-20"
      >
        <Button variant="ghost" size="sm" onClick={goBackToHome}>
          <ArrowLeft className="size-4 mr-2" />
          {t('generation.backToHome')}
        </Button>
      </motion.div>

      <div className="z-10 w-full max-w-lg space-y-8 flex flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full"
        >
          <Card className="relative overflow-hidden border-muted/40 shadow-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl min-h-[400px] flex flex-col items-center justify-center p-8 md:p-12">
            {/* Progress Dots */}
            <div className="absolute top-6 left-0 right-0 flex justify-center gap-2">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500',
                    idx < currentStepIndex
                      ? 'w-1.5 bg-blue-500/30'
                      : idx === currentStepIndex
                        ? 'w-8 bg-blue-500'
                        : 'w-1.5 bg-muted/50',
                  )}
                />
              ))}
            </div>

            {/* Central Content */}
            <div className="flex-1 flex flex-col items-center justify-center w-full space-y-8 mt-4">
              {/* Icon / Visualizer Container */}
              <div className="relative size-48 flex items-center justify-center">
                <AnimatePresence mode="popLayout">
                  {error ? (
                    <motion.div
                      key="error"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="size-32 rounded-full bg-red-500/10 flex items-center justify-center border-2 border-red-500/20"
                    >
                      <AlertCircle className="size-16 text-red-500" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={activeStep.id}
                      initial={{ scale: 0.8, opacity: 0, filter: 'blur(10px)' }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                      exit={{ scale: 1.2, opacity: 0, filter: 'blur(10px)' }}
                      transition={{ duration: 0.4 }}
                      className="absolute inset-0 flex items-center justify-center"
                    >
                      <StepVisualizer
                        stepId={activeStep.id}
                        outlines={outlines}
                        webSearchSources={webSearchSources}
                        onExpandOutline={
                          activeStep.id === 'outline' ? handleExpandStreamingOutline : undefined
                        }
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Text Content */}
              <div className="space-y-3 max-w-sm mx-auto">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={error ? 'error' : activeStep.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-2"
                  >
                    <h2 className="text-2xl font-bold tracking-tight">
                      {error ? t('generation.generationFailed') : t(activeStep.title)}
                    </h2>
                    <p className="text-muted-foreground text-base">
                      {error ? error : statusMessage || t(activeStep.description)}
                    </p>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </Card>
        </motion.div>

        {/* Footer Action */}
        <div className="h-16 flex items-center justify-center w-full">
          <AnimatePresence>
            {error ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex w-full max-w-sm gap-3"
              >
                {paused && (
                  <Button
                    size="lg"
                    className="h-12 flex-1"
                    onClick={handleRetry}
                    disabled={isRetrying}
                    data-testid="generation-retry"
                  >
                    <RefreshCw className={cn('size-4 mr-2', isRetrying && 'animate-spin')} />
                    {t('generation.retryScene')}
                  </Button>
                )}
                <Button size="lg" variant="outline" className="h-12 flex-1" onClick={goBackToHome}>
                  {paused ? t('generation.backToHome') : t('generation.goBackAndRetry')}
                </Button>
              </motion.div>
            ) : !isOutlineReady ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 text-sm text-muted-foreground/50 font-medium uppercase tracking-widest"
              >
                <Sparkles className="size-3 animate-pulse" />
                {t('generation.aiWorking')}
                {generatedAgents.length > 0 && !showAgentReveal && (
                  <button
                    onClick={() => setShowAgentReveal(true)}
                    className="ml-2 flex items-center gap-1.5 rounded-full border border-purple-300/30 bg-purple-500/10 px-3 py-1 text-xs font-medium normal-case tracking-normal text-purple-400 transition-colors hover:bg-purple-500/20 hover:text-purple-300"
                  >
                    <Bot className="size-3" />
                    {t('generation.viewAgents')}
                  </button>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Agent Reveal Modal */}
      <AgentRevealModal
        agents={generatedAgents}
        open={showAgentReveal}
        onClose={() => {
          setShowAgentReveal(false);
          setAgentRevealPending(false);
        }}
        onAllRevealed={() => setAgentRevealPending(false)}
      />
    </div>
  );
}

function RevisitGenerationPreview({ attemptId }: { attemptId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const [session, setSession] = useState<GenerationSessionState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [generatedAgents, setGeneratedAgents] = useState<PersistedAgentConfig[]>([]);
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  const hasStartedRef = useRef(false);
  const allowAutoStartRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const agentRevealResolveRef = useRef<(() => void) | null>(null);

  // Reverse challenges recover from their attempt URL. An explicit one-shot
  // run request starts preparation; reopening a bare URL never starts model work.
  useEffect(() => {
    let cancelled = false;
    if (shouldAutoStartRevisitGeneration(searchParams.get('run'))) {
      allowAutoStartRef.current = true;
      const url = new URL(window.location.href);
      url.searchParams.delete('run');
      window.history.replaceState(window.history.state, '', url);
    }
    const scope = parseRevisitScope(searchParams.get('scope'));
    void (async () => {
      try {
        const attempt =
          (await getRevisitAttempt(attemptId, scope)) ??
          (await importLegacyRevisitAttemptSnapshot(attemptId, scope));
        if (cancelled) return;
        if (attempt) {
          setSession({
            sessionId: attempt.attemptId,
            mode: 'revisit',
            requirements: { requirement: `Reverse Challenge: ${attempt.sourceStage?.name ?? ''}` },
            pdfText: '',
            currentStep: 'generating',
            revisit: {
              stageId: attempt.stageId,
              attemptId: attempt.attemptId,
              forceRegenerate: !attempt.blueprint,
              scope: serializeRevisitScope(scope),
              blueprint: attempt.blueprint,
              showSpiralAgentGenerationStep:
                !isValidSpiralAgentRoster(attempt.sourceStage?.spiralAgentConfigs) ||
                attempt.spiralAgentGenerationState !== undefined,
            },
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setSessionLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attemptId, searchParams]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
      agentRevealResolveRef.current?.();
    },
    [],
  );

  const startGeneration = async (initialSession: GenerationSessionState) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;
    let currentSession = initialSession;
    let activeSteps = getActiveSteps(currentSession);
    try {
      if (currentSession.mode === 'revisit') {
        const revisit = currentSession.revisit;
        if (!revisit) throw new Error(t('generation.sessionNotFound'));

        const settings = useSettingsStore.getState();
        if (!settings.reverseChallengeEnabled) {
          router.replace('/');
          return;
        }

        setCurrentStepIndex(0);
        setStatusMessage(t('generation.revisitPreparingPathDesc'));

        const scope = parseRevisitScope(revisit.scope);
        let attempt =
          (await getRevisitAttempt(revisit.attemptId, scope)) ??
          (await importLegacyRevisitAttemptSnapshot(revisit.attemptId, scope));
        throwIfAborted(signal);
        const now = await getRevisitNow(scope);
        if (attempt && (!attempt.sourceStage || attempt.sourceScenes.length === 0)) {
          const currentSource = await loadStageData(attempt.stageId);
          if (currentSource) {
            attempt = await saveRevisitAttemptSource(
              attempt.attemptId,
              currentSource.stage,
              currentSource.scenes,
              now,
              scope,
            );
          }
        }
        if (
          attempt?.sourceStage &&
          !isValidSpiralAgentRoster(attempt.sourceStage.spiralAgentConfigs)
        ) {
          const currentSource = await loadStageData(attempt.stageId);
          if (currentSource && isValidSpiralAgentRoster(currentSource.stage.spiralAgentConfigs)) {
            attempt = await saveRevisitAttemptSource(
              attempt.attemptId,
              {
                ...attempt.sourceStage,
                spiralAgentConfigs: currentSource.stage.spiralAgentConfigs,
              },
              attempt.sourceScenes,
              now,
              scope,
            );
            if (!attempt.spiralAgentGenerationState) {
              attempt = await setRevisitAttemptSpiralAgentGenerationState(
                attempt.attemptId,
                'pending-reveal',
                now,
                scope,
              );
            }
          }
        }
        if (!attempt?.sourceStage || attempt.sourceScenes.length === 0) {
          throw new Error(t('revisit.challenge.loadFailed'));
        }
        const modelConfig = getCurrentModelConfig();
        const adaptiveContext = await loadRevisitAdaptiveContext(revisit.stageId, {
          stableSuccessesRequired: settings.stableSuccessesRequired,
          scope,
          now,
        });
        throwIfAborted(signal);

        const blueprint =
          attempt.blueprint ??
          (await ensureRevisitBlueprint({
            attemptId: revisit.attemptId,
            stage: attempt.sourceStage,
            scenes: attempt.sourceScenes,
            modelConfig,
            forceRegenerate: revisit.forceRegenerate,
            adaptiveContext,
            signal,
            scope,
          }));
        throwIfAborted(signal);
        await saveRevisitAttemptBlueprint(revisit.attemptId, blueprint, now, scope);

        const sessionWithBlueprint: GenerationSessionState = {
          ...currentSession,
          revisit: {
            ...revisit,
            forceRegenerate: false,
            blueprint,
          },
        };
        setSession(sessionWithBlueprint);
        currentSession = sessionWithBlueprint;
        activeSteps = getActiveSteps(currentSession);

        let spiralAgentAction = getSpiralAgentPreparationAction(
          attempt.sourceStage.spiralAgentConfigs,
          attempt.spiralAgentGenerationState,
        );
        if (spiralAgentAction === 'generate') {
          const agentStepIndex = activeSteps.findIndex((step) => step.id === 'agent-generation');
          setCurrentStepIndex(Math.max(0, agentStepIndex));
          setStatusMessage(t('generation.agentGenerationDesc'));

          const response = await fetch('/api/revisit/agent-profiles', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...buildModelRequestHeaders(modelConfig),
            },
            body: JSON.stringify({
              stageId: attempt.stageId,
              ...buildAgentProfileRequestBody({
                mode: 'spiral',
                stageInfo: {
                  name: attempt.sourceStage.name,
                  description: attempt.sourceStage.description,
                },
                sceneOutlines: blueprint.skeleton.pages.map((page) => ({
                  title: page.title,
                  description: [page.summary, ...page.cues].filter(Boolean).join(' — '),
                })),
                languageDirective:
                  attempt.sourceStage.languageDirective ||
                  `Respond in the challenge language: ${blueprint.language}.`,
                availableVoices: [],
              }),
            }),
            signal,
          });
          if (!response.ok) throw new Error('Spiral agent generation failed');
          const data = await response.json();
          const spiralAgents = data.agents as PersistedAgentConfig[] | undefined;
          if (!data.success || !isValidSpiralAgentRoster(spiralAgents)) {
            throw new Error(data.error || 'Spiral agent generation returned an invalid roster');
          }

          await saveStageSpiralAgents(attempt.stageId, spiralAgents, now, scope);
          attempt = await saveRevisitAttemptSource(
            attempt.attemptId,
            {
              ...attempt.sourceStage,
              updatedAt: now,
              spiralAgentConfigs: spiralAgents,
            },
            attempt.sourceScenes,
            now,
            scope,
          );
          attempt = await setRevisitAttemptSpiralAgentGenerationState(
            attempt.attemptId,
            'pending-reveal',
            now,
            scope,
          );
          spiralAgentAction = 'reveal';
        }

        if (spiralAgentAction === 'reveal') {
          const spiralAgents = attempt.sourceStage?.spiralAgentConfigs;
          if (!isValidSpiralAgentRoster(spiralAgents)) {
            throw new Error('Spiral agent roster is missing');
          }
          setGeneratedAgents(spiralAgents);
          setShowAgentReveal(true);
          await new Promise<void>((resolve) => {
            agentRevealResolveRef.current = resolve;
          });
          throwIfAborted(signal);
          attempt = await setRevisitAttemptSpiralAgentGenerationState(
            attempt.attemptId,
            'revealed',
            await getRevisitNow(scope),
            scope,
          );
        }

        setCurrentStepIndex(
          Math.max(
            0,
            activeSteps.findIndex((s) => s.id === 'revisit-page'),
          ),
        );
        setStatusMessage(t('generation.revisitGeneratingPageDesc'));
        if (!attempt.sourceStage) throw new Error(t('revisit.challenge.loadFailed'));

        const firstScene =
          attempt.blueprint?.id === blueprint.id && attempt.scenes[0]
            ? attempt.scenes[0]
            : await generateRevisitSkeletonScene({
                stage: attempt.sourceStage,
                blueprint,
                sourceScenes: attempt.sourceScenes,
                modelConfig,
                pageIndex: 0,
                signal,
              });
        throwIfAborted(signal);

        await upsertRevisitAttemptScene({
          attemptId: revisit.attemptId,
          scene: firstScene,
          index: 0,
          scope,
          now,
        });

        setStatusMessage(t('generation.revisitReadyDesc'));
        router.push(
          `/classroom/${encodeURIComponent(attempt.stageId)}/revisit?attempt=${encodeURIComponent(
            revisit.attemptId,
          )}&scope=${encodeURIComponent(serializeRevisitScope(scope))}`,
        );
        return;
      }
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      const revisit = currentSession.revisit;
      if (revisit) {
        const scope = parseRevisitScope(revisit.scope);
        await setRevisitAttemptPreparationError(
          revisit.attemptId,
          message,
          await getRevisitNow(scope),
          scope,
        );
      }
      setError(message);
    }
  };

  useEffect(() => {
    if (!session || hasStartedRef.current) return;
    hasStartedRef.current = true;
    if (!allowAutoStartRef.current) {
      setError(t('revisit.history.preparing'));
      return;
    }
    void startGeneration(session);
    // Preparation changes the persisted attempt and the session as it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, t]);

  const steps = getActiveSteps(session);
  const activeStep = steps[Math.min(currentStepIndex, steps.length - 1)];
  const scope = parseRevisitScope(session?.revisit?.scope);
  const finishReveal = () => {
    setShowAgentReveal(false);
    agentRevealResolveRef.current?.();
    agentRevealResolveRef.current = null;
  };

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden text-center">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push('/')}
        className="absolute top-4 left-4"
      >
        <ArrowLeft className="size-4 mr-2" />
        {t('generation.backToHome')}
      </Button>
      <RevisitDemoBadge scope={scope} className="absolute top-4 right-4" />
      <Card className="max-w-lg w-full p-8 md:p-12 space-y-8 bg-white/80 dark:bg-slate-900/80">
        {!sessionLoaded ? (
          <div className="size-8 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mx-auto" />
        ) : !session ? (
          <>
            <AlertCircle className="size-12 text-muted-foreground mx-auto" />
            <h2 className="text-xl font-semibold">{t('generation.sessionNotFound')}</h2>
            <p className="text-sm text-muted-foreground">
              {error || t('generation.sessionNotFoundDesc')}
            </p>
          </>
        ) : (
          <>
            <div className="flex justify-center gap-2">
              {steps.map((step, index) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full',
                    index === currentStepIndex ? 'w-8 bg-blue-500' : 'w-1.5 bg-muted',
                  )}
                />
              ))}
            </div>
            <div className="relative size-48 flex items-center justify-center mx-auto">
              {error ? (
                <AlertCircle className="size-16 text-red-500" />
              ) : (
                <StepVisualizer stepId={activeStep.id} />
              )}
            </div>
            <div className="space-y-3">
              <h2 className="text-2xl font-bold">
                {t(error ? 'generation.generationFailed' : activeStep.title)}
              </h2>
              <p className="text-muted-foreground">
                {error || statusMessage || t(activeStep.description)}
              </p>
            </div>
            {error ? (
              <Button variant="outline" onClick={() => router.push('/')}>
                {t('generation.goBackAndRetry')}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                <Sparkles className="inline size-3 mr-2 animate-pulse" />
                {t('generation.aiWorking')}
              </p>
            )}
          </>
        )}
      </Card>
      <AgentRevealModal
        agents={generatedAgents}
        open={showAgentReveal}
        onClose={finishReveal}
        onAllRevealed={finishReveal}
      />
    </div>
  );
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function GenerationPreviewContent() {
  const attemptId = useSearchParams().get('attempt');
  return attemptId ? (
    <RevisitGenerationPreview key={attemptId} attemptId={attemptId} />
  ) : (
    <CourseGenerationPreview />
  );
}

export default function GenerationPreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
          <div className="animate-pulse space-y-4 text-center">
            <div className="h-8 w-48 bg-muted rounded mx-auto" />
            <div className="h-4 w-64 bg-muted rounded mx-auto" />
          </div>
        </div>
      }
    >
      <GenerationPreviewContent />
    </Suspense>
  );
}
