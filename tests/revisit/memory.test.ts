import { describe, expect, it } from 'vitest';

import {
  applyEvidenceToConceptState,
  computeLessonMemoryFromCompletion,
  computeConceptRecall,
  computeLessonMemory,
  createConceptStateFromEvidence,
  filterJudgedConceptStates,
  getSuggestedReviewAt,
  toDateKey,
  updateHalfLifeDays,
} from '@/lib/revisit/memory';
import type { UserConceptState } from '@/lib/revisit/types';

const DAY = 24 * 60 * 60 * 1000;

function state(overrides: Partial<UserConceptState> = {}): UserConceptState {
  return {
    stageId: 'stage-1',
    conceptId: 'concept-1',
    label: 'Straw man fallacy',
    hDays: 4,
    learnedAt: Date.UTC(2026, 6, 1),
    lastRetrievalAt: Date.UTC(2026, 6, 1),
    evidenceCount: 1,
    successChallengeDates: [],
    createdAt: Date.UTC(2026, 6, 1),
    updatedAt: Date.UTC(2026, 6, 1),
    ...overrides,
  };
}

describe('SpiralMAIC memory decay', () => {
  it('computes concept recall from elapsed system-clock time with the PRD half-life formula', () => {
    const learned = Date.UTC(2026, 6, 1);
    const fourDaysLater = learned + 4 * DAY;

    expect(computeConceptRecall(state({ hDays: 4, lastRetrievalAt: learned }), fourDaysLater)).toBe(
      0.5,
    );
  });

  it('summarizes lessons as unlearned gray, weighted recall, review zone, and stable badge', () => {
    expect(computeLessonMemory([], Date.UTC(2026, 6, 4))).toMatchObject({
      status: 'unlearned',
      color: expect.stringMatching(/oklch|#[0-9a-f]/i),
    });

    const now = Date.UTC(2026, 6, 5);
    const states = [
      state({ conceptId: 'a', hDays: 4, lastRetrievalAt: now - 4 * DAY }),
      state({ conceptId: 'b', hDays: 2, lastRetrievalAt: now - 4 * DAY }),
    ];
    const memory = computeLessonMemory(states, now);

    expect(memory.recall).toBeCloseTo(0.3375, 4);
    expect(memory.status).toBe('review');
    expect(memory.badge).toBeUndefined();

    const stable = computeLessonMemory(
      [
        state({
          hDays: 130,
          successChallengeDates: ['2026-07-01', '2026-07-03'],
        }),
      ],
      now,
      { stableSuccessesRequired: 2 },
    );
    expect(stable.status).toBe('stable');
    expect(stable.badge).toBe('stable');
  });

  it('uses completed lessons as fresh course-level memory before concept states exist', () => {
    const completedAt = Date.UTC(2026, 6, 1);
    const fresh = computeLessonMemoryFromCompletion(completedAt, completedAt);
    expect(fresh).toMatchObject({
      status: 'fresh',
      recall: 1,
      meanRecall: 1,
      minRecall: 1,
    });

    const fourDaysLater = completedAt + 4 * DAY;
    const review = computeLessonMemoryFromCompletion(completedAt, fourDaysLater);
    expect(review.status).toBe('review');
    expect(review.recall).toBe(0.5);
  });

  it('suggests review when recall crosses the review threshold', () => {
    const completedAt = Date.UTC(2026, 6, 1);
    const suggested = getSuggestedReviewAt({
      completedAt,
      now: completedAt,
      states: [],
    });

    expect(suggested).toBeGreaterThan(completedAt + 3 * DAY);
    expect(suggested).toBeLessThan(completedAt + 4 * DAY);

    const overdue = getSuggestedReviewAt({
      completedAt,
      now: completedAt + 4 * DAY,
      states: [],
    });
    expect(overdue).toBe(completedAt + 4 * DAY);
  });

  it('updates half-life in log domain against predicted recall with spacing gains', () => {
    const effortfulSuccess = updateHalfLifeDays({ currentHDays: 4, q: 0.9, retrievability: 0.25 });
    const easySuccess = updateHalfLifeDays({ currentHDays: 4, q: 0.9, retrievability: 0.9 });
    const longGapFailure = updateHalfLifeDays({ currentHDays: 4, q: 0.5, retrievability: 0.05 });
    const poorRefresh = updateHalfLifeDays({ currentHDays: 4, q: 0.2, retrievability: 0.5 });

    expect(effortfulSuccess).toBeGreaterThan(easySuccess);
    expect(easySuccess).toBe(4);
    expect(longGapFailure).toBeLessThan(4);
    expect(poorRefresh).toBeLessThan(4);
    expect(updateHalfLifeDays({ currentHDays: 3, q: 0.8, retrievability: 0.5 })).toBeCloseTo(
      4.3,
      4,
    );
    expect(updateHalfLifeDays({ currentHDays: 3, q: 0.4, retrievability: 0.5 })).toBeLessThan(3);
    expect(updateHalfLifeDays({ currentHDays: 7, q: 0.85, retrievability: 0.25 })).toBeCloseTo(
      16.2146,
      4,
    );
    expect(updateHalfLifeDays({ currentHDays: 500, q: 0.98, retrievability: 0.1 })).toBe(180);
    expect(updateHalfLifeDays({ currentHDays: 0.2, q: 0.05, retrievability: 0.9 })).toBe(1);
  });

  it('applies successful spaced evidence toward stability', () => {
    const first = applyEvidenceToConceptState(
      state({
        hDays: 130,
        lastRetrievalAt: Date.UTC(2026, 0, 1),
        successChallengeDates: [],
      }),
      {
        id: 'e1',
        attemptId: 'a1',
        stageId: 'stage-1',
        conceptId: 'concept-1',
        source: 'teach_back',
        scores: { clarity: 0.9, doubtResolution: 0.9, transfer: 0.9, errorCorrection: 0.9 },
        q: 0.9,
        qRaw: 0.9,
        polarity: 'positive',
        timestamp: Date.UTC(2026, 6, 2),
        errors: [],
      },
      { now: Date.UTC(2026, 6, 2), stableSuccessesRequired: 2 },
    );
    expect(first.successChallengeDates).toEqual(['2026-07-02']);
    expect(first.stableAt).toBeUndefined();

    const second = applyEvidenceToConceptState(
      {
        ...first,
        lastRetrievalAt: Date.UTC(2026, 0, 1),
      },
      {
        id: 'e2',
        attemptId: 'a2',
        stageId: 'stage-1',
        conceptId: 'concept-1',
        source: 'teach_back',
        scores: { clarity: 0.9, doubtResolution: 0.9, transfer: 0.9, errorCorrection: 0.9 },
        q: 0.9,
        qRaw: 0.9,
        polarity: 'positive',
        timestamp: Date.UTC(2026, 6, 4),
        errors: [],
      },
    );
    expect(second.successChallengeDates).toContain('2026-07-04');
    expect(second.stableAt).toBe(Date.UTC(2026, 6, 4));
  });

  it('ignores legacy concept shells that have never received judged evidence', () => {
    const legacyShell = state({ evidenceCount: 0 });
    const judged = state({ conceptId: 'concept-2', evidenceCount: 1 });

    expect(filterJudgedConceptStates([legacyShell, judged])).toEqual([judged]);
    expect(computeLessonMemory([legacyShell], Date.UTC(2026, 6, 4))).toMatchObject({
      status: 'unlearned',
      recall: null,
    });
  });

  it('downgrades a previously stable concept after poor retrieval evidence', () => {
    const stable = state({
      hDays: 130,
      stableAt: Date.UTC(2026, 6, 1),
      successChallengeDates: ['2026-06-28', '2026-07-01'],
      lastRetrievalAt: Date.UTC(2026, 6, 1),
    });
    const timestamp = Date.UTC(2026, 6, 2);
    const downgraded = applyEvidenceToConceptState(stable, {
      id: 'poor-evidence',
      attemptId: 'attempt-poor',
      stageId: 'stage-1',
      conceptId: 'concept-1',
      source: 'teach_back',
      scores: { clarity: 0.1, doubtResolution: 0.1, transfer: 0.1, errorCorrection: 0.1 },
      q: 0.1,
      qRaw: 0.1,
      polarity: 'negative',
      timestamp,
      errors: [
        {
          id: 'error-1',
          conceptId: 'concept-1',
          description: 'Incorrect explanation',
          corrected: false,
          severity: 'major',
        },
      ],
    });

    expect(downgraded.hDays).toBeLessThan(120);
    expect(downgraded.stableAt).toBeUndefined();
    expect(computeLessonMemory([downgraded], timestamp).status).not.toBe('stable');
  });

  it('downgrades stable memory after a failed retrieval even when predicted recall was low', () => {
    const stable = state({
      hDays: 130,
      stableAt: Date.UTC(2026, 6, 1),
      successChallengeDates: ['2026-06-28', '2026-07-01'],
      lastRetrievalAt: Date.UTC(2025, 11, 14),
    });
    const timestamp = Date.UTC(2026, 6, 2);
    const downgraded = applyEvidenceToConceptState(stable, {
      id: 'late-failed-evidence',
      attemptId: 'attempt-late-failure',
      stageId: 'stage-1',
      conceptId: 'concept-1',
      source: 'teach_back',
      scores: { clarity: 0.4, doubtResolution: 0.4, transfer: 0.4, errorCorrection: 0.4 },
      q: 0.4,
      qRaw: 0.4,
      polarity: 'negative',
      timestamp,
      errors: [],
    });

    expect(downgraded.hDays).toBeLessThan(130);
    expect(downgraded.stableAt).toBeUndefined();
    expect(computeLessonMemory([downgraded], timestamp).status).not.toBe('stable');
  });

  it('finds the real review threshold on the system-clock timeline', () => {
    const now = Date.UTC(2026, 6, 1);
    const slowState = state({ hDays: 180, lastRetrievalAt: now });
    const suggested = getSuggestedReviewAt({
      now,
      states: [slowState],
    });

    expect(suggested).not.toBeNull();
    expect((suggested! - now) / DAY).toBeGreaterThan(150);
    expect(computeConceptRecall(slowState, suggested!)).toBeCloseTo(0.55, 3);
  });

  it('uses a learned but unassessed concept to pull the suggested review date earlier', () => {
    const now = Date.UTC(2026, 6, 1);
    const suggested = getSuggestedReviewAt({
      now,
      states: [state({ hDays: 180, lastRetrievalAt: now })],
      unassessedConcepts: [{ learnedAt: now }],
    });

    expect(suggested).not.toBeNull();
    expect((suggested! - now) / DAY).toBeCloseTo(-4 * Math.log2(0.55), 4);
  });

  it('counts spaced successes by the learner calendar day instead of UTC day', () => {
    const justAfterMidnight = Date.UTC(2026, 6, 9, 16, 30);
    const lateThatEvening = Date.UTC(2026, 6, 10, 15, 30);

    expect(toDateKey(justAfterMidnight, 'Asia/Shanghai')).toBe('2026-07-10');
    expect(toDateKey(lateThatEvening, 'Asia/Shanghai')).toBe('2026-07-10');
  });

  it('starts first judged concept evidence from lesson completion rather than challenge entry', () => {
    const completedAt = Date.UTC(2026, 6, 1);
    const challengedAt = completedAt + 8 * DAY;
    const evidence = {
      id: 'attempt-1:evidence-01',
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      conceptId: 'concept-1',
      source: 'teach_back' as const,
      scores: { clarity: 0.8, doubtResolution: 0.8, transfer: 0.8, errorCorrection: 0.8 },
      q: 0.8,
      qRaw: 0.8,
      polarity: 'positive' as const,
      timestamp: challengedAt,
      errors: [],
    };
    const initial = createConceptStateFromEvidence(evidence, {
      label: 'Straw man fallacy',
      learnedAt: completedAt,
    });
    const updated = applyEvidenceToConceptState(initial, evidence);

    expect(initial.lastRetrievalAt).toBe(completedAt);
    expect(updated.hDays).toBeGreaterThan(4);
    expect(updated.lastRetrievalAt).toBe(challengedAt);
  });
});
