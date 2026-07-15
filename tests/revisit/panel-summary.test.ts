import { describe, expect, it } from 'vitest';

import { buildRevisitPanelSummary } from '@/lib/revisit/panel-summary';
import { buildLessonSourceHash } from '@/lib/revisit/source';
import type {
  LessonMemorySummary,
  RevisitJudgeReport,
  UserConceptState,
} from '@/lib/revisit/types';
import type { Scene } from '@/lib/types/stage';
import type { StageListItem } from '@/lib/utils/stage-storage';

const DAY = 24 * 60 * 60 * 1000;

const classroom: StageListItem = {
  id: 'stage-1',
  name: 'Fallacies',
  sceneCount: 2,
  createdAt: Date.UTC(2026, 6, 1),
  updatedAt: Date.UTC(2026, 6, 2),
};

const freshMemory: LessonMemorySummary = {
  status: 'fresh',
  recall: 1,
  meanRecall: 1,
  minRecall: 1,
  color: 'hsl(142 72% 46%)',
};

const quizScene: Scene = {
  id: 'quiz-1',
  stageId: 'stage-1',
  type: 'quiz',
  title: 'Quiz',
  order: 1,
  content: {
    type: 'quiz',
    questions: [
      {
        id: 'q1',
        type: 'single',
        question: 'Which one is correct?',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        answer: ['b'],
        hasAnswer: true,
        points: 1,
      },
    ],
  },
};

const conceptState: UserConceptState = {
  stageId: 'stage-1',
  conceptId: 'c1',
  label: 'Straw man',
  hDays: 4,
  learnedAt: Date.UTC(2026, 6, 1),
  lastRetrievalAt: Date.UTC(2026, 6, 1),
  evidenceCount: 1,
  successChallengeDates: [],
  createdAt: Date.UTC(2026, 6, 1),
  updatedAt: Date.UTC(2026, 6, 1),
};

const latestReport: RevisitJudgeReport = {
  attemptId: 'attempt-2',
  stageId: 'stage-1',
  completedAt: Date.UTC(2026, 6, 3),
  summary: 'Transfer needs work.',
  dimensions: {
    clarity: 0.8,
    doubtResolution: 0.7,
    transfer: 0.45,
    errorCorrection: 0.9,
  },
  q: 0.66,
  qRaw: 0.66,
  errors: [],
  evidence: [],
  pageReports: [],
};

const studyArtifact = {
  id: 'stage-1:faq:v1',
  stageId: 'stage-1',
  kind: 'faq' as const,
  version: 1,
  title: 'Fallacies FAQ',
  stageUpdatedAt: classroom.updatedAt,
  createdAt: 100,
  updatedAt: 100,
  sourceHash: 'hash',
  lessonSourceHash: buildLessonSourceHash(classroom, [quizScene]),
  language: 'en-US',
  options: {
    focusMode: 'balanced' as const,
    selectedSceneIds: [],
    customInstructions: '',
    count: 10,
  },
  content: {
    items: [
      {
        id: 'faq-1',
        question: 'Q',
        answer: 'A',
      },
    ],
  },
};

describe('revisit panel summary', () => {
  it('summarizes progress, quiz score, latest report, and future review time', () => {
    const now = classroom.createdAt;
    const summary = buildRevisitPanelSummary({
      classroom,
      scenes: [quizScene],
      progress: {
        stageId: classroom.id,
        completedAt: now,
        updatedAt: now,
      },
      memorySummary: freshMemory,
      conceptStates: [],
      pendingConcepts: [
        {
          stageId: classroom.id,
          conceptId: 'approach',
          label: 'approach',
          summary: 'Move closer.',
          origin: 'overtime',
          sourceSceneIds: ['overtime-1'],
          introducedAt: now,
          learnedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      latestReport,
      studyArtifacts: [studyArtifact],
      now,
      stableSuccessesRequired: 2,
      readAnswers: () => ({ q1: 'b' }),
    });

    expect(summary.completedAt).toBe(now);
    expect(summary.quiz).toEqual({ correct: 1, total: 1, pct: 100 });
    expect(summary.latestReport?.attemptId).toBe('attempt-2');
    expect(summary.artifacts).toEqual([{ artifact: studyArtifact, stale: false }]);
    expect(summary.pendingAssessmentCount).toBe(1);
    expect(summary.suggestedReviewAt).toBeGreaterThan(now + 3 * DAY);
    expect(summary.suggestedReviewAt).toBeLessThan(now + 4 * DAY);
  });

  it('uses concept states for review timing when challenge evidence exists', () => {
    const now = Date.UTC(2026, 6, 5);
    const summary = buildRevisitPanelSummary({
      classroom,
      scenes: [],
      progress: {
        stageId: classroom.id,
        completedAt: Date.UTC(2026, 6, 4),
        updatedAt: Date.UTC(2026, 6, 4),
      },
      memorySummary: {
        ...freshMemory,
        status: 'review',
        recall: 0.5,
      },
      conceptStates: [conceptState],
      latestReport: undefined,
      now,
      stableSuccessesRequired: 2,
      readAnswers: () => ({}),
    });

    expect(summary.suggestedReviewAt).toBe(now);
  });

  it('keeps artifacts from an older course revision visible and marks them stale', () => {
    const summary = buildRevisitPanelSummary({
      classroom,
      scenes: [],
      memorySummary: freshMemory,
      conceptStates: [],
      studyArtifacts: [{ ...studyArtifact, lessonSourceHash: 'stale-lesson-source' }],
      now: classroom.updatedAt,
      stableSuccessesRequired: 2,
      readAnswers: () => ({}),
    });

    expect(summary.artifacts).toHaveLength(1);
    expect(summary.artifacts[0]).toMatchObject({
      artifact: { id: studyArtifact.id },
      stale: true,
    });
  });
});
