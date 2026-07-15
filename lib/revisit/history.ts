import { LOW_BENEFIT_RECALL_THRESHOLD } from '@/lib/revisit/memory';
import type { RevisitAttempt, RevisitJudgeReport } from '@/lib/revisit/types';
import type { Slide } from '@openmaic/dsl';

export type RevisitAttemptAction = 'prepare' | 'enter' | 'replay' | 'none';

export interface RevisitHistoryCardInteraction {
  hover: 'select';
  click: RevisitAttemptAction;
}

export function getRevisitHistoryCardInteraction(
  attempt: RevisitAttempt,
): RevisitHistoryCardInteraction {
  return {
    hover: 'select',
    click: getRevisitAttemptAction(attempt),
  };
}

export interface RevisitAttemptCardSummary {
  pageCount: number;
  readyPageCount: number;
  previewSlide?: Slide;
}

export function getRevisitAttemptCardSummary(
  attempt: RevisitAttempt,
  report?: RevisitJudgeReport,
): RevisitAttemptCardSummary {
  const previewScene = attempt.scenes.find((scene) => scene?.content.type === 'slide');
  const previewSlide =
    previewScene?.content.type === 'slide' ? previewScene.content.canvas : undefined;

  return {
    pageCount: Math.max(
      attempt.blueprint?.skeleton.pages.length ?? 0,
      attempt.scenes.length,
      report?.pageReports.length ?? 0,
    ),
    readyPageCount: attempt.scenes.filter((scene) => scene !== null).length,
    previewSlide,
  };
}

export function selectDefaultRevisitAttempt(
  attempts: RevisitAttempt[],
): RevisitAttempt | undefined {
  const unfinished = attempts.find((attempt) => attempt.status !== 'completed');
  if (unfinished) return unfinished;
  return [...attempts].sort((a, b) => b.sequence - a.sequence)[0];
}

export function isRevisitAttemptReplayable(attempt: RevisitAttempt): boolean {
  return Boolean(
    attempt.status === 'completed' &&
    !attempt.reportOnly &&
    attempt.sourceStage &&
    attempt.blueprint &&
    attempt.scenes[0],
  );
}

export function getRevisitAttemptAction(attempt: RevisitAttempt): RevisitAttemptAction {
  if (attempt.status === 'completed')
    return isRevisitAttemptReplayable(attempt) ? 'replay' : 'none';
  if (attempt.status === 'ready' && attempt.scenes[0]) return 'enter';
  return 'prepare';
}

export function shouldJudgeRevisitAttempt(attempt: RevisitAttempt): boolean {
  return attempt.status !== 'completed';
}

export function shouldWarnLowBenefitRevisit(args: {
  recall: number | null;
  hasUnfinishedAttempt: boolean;
  hasPendingAssessment: boolean;
}): boolean {
  return (
    !args.hasUnfinishedAttempt &&
    !args.hasPendingAssessment &&
    args.recall !== null &&
    args.recall >= LOW_BENEFIT_RECALL_THRESHOLD
  );
}
