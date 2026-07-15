import { describe, expect, it } from 'vitest';

import {
  getRevisitAttemptCardSummary,
  getRevisitAttemptAction,
  getRevisitHistoryCardInteraction,
  shouldJudgeRevisitAttempt,
  selectDefaultRevisitAttempt,
  shouldWarnLowBenefitRevisit,
} from '@/lib/revisit/history';
import type { RevisitAttempt } from '@/lib/revisit/types';

function attempt(
  sequence: number,
  status: RevisitAttempt['status'],
  overrides: Partial<RevisitAttempt> = {},
): RevisitAttempt {
  return {
    attemptId: `attempt-${sequence}`,
    stageId: 'stage-1',
    sequence,
    status,
    sourceScenes: [],
    scenes: [],
    createdAt: sequence,
    updatedAt: sequence,
    ...overrides,
  };
}

describe('Reverse history policy', () => {
  it('selects the only unfinished attempt before the latest completed one', () => {
    const selected = selectDefaultRevisitAttempt([
      attempt(1, 'completed'),
      attempt(2, 'preparing'),
      attempt(3, 'completed'),
    ]);
    expect(selected?.sequence).toBe(2);
  });

  it('judges only the first formal completion and never a completed replay', () => {
    expect(shouldJudgeRevisitAttempt(attempt(1, 'ready'))).toBe(true);
    expect(shouldJudgeRevisitAttempt(attempt(1, 'completed'))).toBe(false);
  });

  it('maps durable preparation state to the fixed user actions', () => {
    expect(getRevisitAttemptAction(attempt(1, 'preparing'))).toBe('prepare');
    expect(getRevisitAttemptAction(attempt(1, 'ready', { scenes: [{} as never] }))).toBe('enter');
    expect(getRevisitAttemptAction(attempt(1, 'completed', { reportOnly: true }))).toBe('none');
    expect(
      getRevisitAttemptAction(
        attempt(1, 'completed', {
          sourceStage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 1 },
          blueprint: { skeleton: { pages: [] } } as never,
          scenes: [{} as never],
        }),
      ),
    ).toBe('replay');
  });

  it('selects on hover and uses click for the challenge action', () => {
    expect(
      getRevisitHistoryCardInteraction(attempt(1, 'ready', { scenes: [{} as never] })),
    ).toEqual({ hover: 'select', click: 'enter' });
    expect(getRevisitHistoryCardInteraction(attempt(1, 'completed', { reportOnly: true }))).toEqual(
      { hover: 'select', click: 'none' },
    );
  });

  it('keeps generation sequence order even when an older Reverse was updated later', () => {
    const selected = selectDefaultRevisitAttempt([
      attempt(1, 'completed', { updatedAt: 300 }),
      attempt(2, 'completed', { updatedAt: 200 }),
    ]);

    expect(selected?.sequence).toBe(2);
  });

  it('builds a homepage-style card summary from generated Reverse pages', () => {
    const previewSlide = {
      elements: [],
      viewportSize: 1000,
      viewportRatio: 0.5625,
    };
    const summary = getRevisitAttemptCardSummary(
      attempt(2, 'preparing', {
        blueprint: {
          skeleton: { pages: [{}, {}, {}, {}] },
        } as never,
        scenes: [
          null,
          { content: { type: 'quiz' } } as never,
          { content: { type: 'slide', canvas: previewSlide } } as never,
        ],
      }),
    );

    expect(summary.pageCount).toBe(4);
    expect(summary.readyPageCount).toBe(2);
    expect(summary.previewSlide).toBe(previewSlide);
  });

  it('uses report pages as the card count for a legacy report-only Reverse', () => {
    const summary = getRevisitAttemptCardSummary(attempt(1, 'completed', { reportOnly: true }), {
      pageReports: [{}, {}, {}],
    } as never);

    expect(summary.pageCount).toBe(3);
    expect(summary.readyPageCount).toBe(0);
    expect(summary.previewSlide).toBeUndefined();
  });

  it('warns at exactly 80% only when a new challenge can be created', () => {
    expect(
      shouldWarnLowBenefitRevisit({
        recall: 0.799,
        hasUnfinishedAttempt: false,
        hasPendingAssessment: false,
      }),
    ).toBe(false);
    expect(
      shouldWarnLowBenefitRevisit({
        recall: 0.8,
        hasUnfinishedAttempt: false,
        hasPendingAssessment: false,
      }),
    ).toBe(true);
    expect(
      shouldWarnLowBenefitRevisit({
        recall: 0.95,
        hasUnfinishedAttempt: true,
        hasPendingAssessment: false,
      }),
    ).toBe(false);
    expect(
      shouldWarnLowBenefitRevisit({
        recall: null,
        hasUnfinishedAttempt: false,
        hasPendingAssessment: false,
      }),
    ).toBe(false);
    expect(
      shouldWarnLowBenefitRevisit({
        recall: 0.95,
        hasUnfinishedAttempt: false,
        hasPendingAssessment: true,
      }),
    ).toBe(false);
  });
});
