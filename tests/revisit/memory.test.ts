import { describe, expect, it } from 'vitest';

import {
  applyEvidenceToConceptState,
  computeConceptRecall,
  computeLessonMemory,
  createInitialConceptStates,
  updateHalfLifeDays,
} from '@/lib/revisit/memory';
import type { RevisitExamBlueprint, UserConceptState } from '@/lib/revisit/types';

const DAY = 24 * 60 * 60 * 1000;

function state(overrides: Partial<UserConceptState> = {}): UserConceptState {
  return {
    stageId: 'stage-1',
    conceptId: 'concept-1',
    label: 'Straw man fallacy',
    hDays: 4,
    learnedAt: Date.UTC(2026, 6, 1),
    lastRetrievalAt: Date.UTC(2026, 6, 1),
    evidenceCount: 0,
    successChallengeDates: [],
    createdAt: Date.UTC(2026, 6, 1),
    updatedAt: Date.UTC(2026, 6, 1),
    ...overrides,
  };
}

function blueprint(): RevisitExamBlueprint {
  return {
    id: 'bp-1',
    stageId: 'stage-1',
    generatedAt: Date.UTC(2026, 6, 1),
    language: 'en-US',
    sourceHash: 'hash',
    concepts: [
      {
        id: 'concept-1',
        label: 'Straw man fallacy',
        summary: 'Misrepresenting an argument before attacking it.',
        anchors: {
          clarity: ['Can define the fallacy in plain language.'],
          doubtResolution: ['Can answer why it is different from disagreement.'],
          transfer: ['Can identify it in a new example.'],
          errorCorrection: ['Can correct a fake example.'],
        },
        probes: [],
      },
    ],
    skeleton: {
      pages: [
        {
          id: 'page-1',
          title: 'Recognize the real claim',
          summary: 'Explain how the original claim differs from the distorted claim.',
          conceptIds: ['concept-1'],
          cues: ['Original claim', 'Distorted claim', 'Why the attack misses'],
        },
      ],
    },
  };
}

describe('SpiralMAIC memory decay', () => {
  it('computes concept recall with PRD half-life formula and accelerated clock multiplier', () => {
    const learned = Date.UTC(2026, 6, 1);
    const fourDaysLater = learned + 4 * DAY;
    const twoCalendarDaysLater = learned + 2 * DAY;

    expect(computeConceptRecall(state({ hDays: 4, lastRetrievalAt: learned }), fourDaysLater)).toBe(
      0.5,
    );
    expect(
      computeConceptRecall(state({ hDays: 4, lastRetrievalAt: learned }), twoCalendarDaysLater, 2),
    ).toBe(0.5);
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

  it('updates half-life in log domain against predicted recall with spacing gains', () => {
    const effortfulSuccess = updateHalfLifeDays({ currentHDays: 4, q: 0.9, retrievability: 0.25 });
    const easySuccess = updateHalfLifeDays({ currentHDays: 4, q: 0.9, retrievability: 0.9 });
    const longGapPass = updateHalfLifeDays({ currentHDays: 4, q: 0.5, retrievability: 0.05 });
    const poorRefresh = updateHalfLifeDays({ currentHDays: 4, q: 0.2, retrievability: 0.5 });

    expect(effortfulSuccess).toBeGreaterThan(easySuccess);
    expect(easySuccess).toBe(4);
    expect(longGapPass).toBeGreaterThan(7.9);
    expect(poorRefresh).toBeLessThan(4);
    expect(updateHalfLifeDays({ currentHDays: 3, q: 0.8, retrievability: 0.5 })).toBeCloseTo(
      4.3,
      4,
    );
    expect(updateHalfLifeDays({ currentHDays: 3, q: 0.4, retrievability: 0.5 })).toBeCloseTo(
      2.6608,
      4,
    );
    expect(updateHalfLifeDays({ currentHDays: 7, q: 0.85, retrievability: 0.25 })).toBeCloseTo(
      16.2146,
      4,
    );
    expect(updateHalfLifeDays({ currentHDays: 500, q: 0.98, retrievability: 0.1 })).toBe(180);
    expect(updateHalfLifeDays({ currentHDays: 0.2, q: 0.05, retrievability: 0.9 })).toBe(1);
  });

  it('creates initial concept states and applies successful spaced evidence toward stability', () => {
    const learnedAt = Date.UTC(2026, 6, 1);
    const [initial] = createInitialConceptStates(blueprint(), learnedAt);

    expect(initial).toMatchObject({
      stageId: 'stage-1',
      conceptId: 'concept-1',
      hDays: 4,
      lastRetrievalAt: learnedAt,
    });

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
});
