import {
  summarizeScenes,
  type CompleteSummary,
  type AnswerReader,
} from '@/lib/classroom/complete-summary';
import { getSuggestedReviewAt } from '@/lib/revisit/memory';
import { buildLessonSourceHash } from '@/lib/revisit/source';
import type {
  LessonMemorySummary,
  LessonConcept,
  LessonProgress,
  RevisitAttempt,
  RevisitJudgeReport,
  StudyArtifact,
  UserConceptState,
} from '@/lib/revisit/types';
import type { Scene } from '@/lib/types/stage';
import type { StageListItem } from '@/lib/utils/stage-storage';

export interface RevisitPanelSummary {
  stageId: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  memorySummary: LessonMemorySummary;
  suggestedReviewAt: number | null;
  quiz: CompleteSummary['quiz'];
  latestReport?: RevisitJudgeReport;
  reports: RevisitJudgeReport[];
  attempts: RevisitAttempt[];
  artifacts: Array<{ artifact: StudyArtifact; stale: boolean }>;
  pendingAssessmentCount: number;
}

export function buildRevisitPanelSummary(args: {
  classroom: StageListItem;
  scenes: Scene[];
  progress?: LessonProgress;
  memorySummary: LessonMemorySummary;
  conceptStates: UserConceptState[];
  pendingConcepts?: LessonConcept[];
  latestReport?: RevisitJudgeReport;
  reports?: RevisitJudgeReport[];
  attempts?: RevisitAttempt[];
  studyArtifacts?: StudyArtifact[];
  now: number;
  stableSuccessesRequired: number;
  readAnswers: AnswerReader;
}): RevisitPanelSummary {
  const completeSummary = summarizeScenes(args.scenes, args.readAnswers);
  const lessonSourceHash = buildLessonSourceHash(args.classroom, args.scenes);
  return {
    stageId: args.classroom.id,
    title: args.classroom.name,
    startedAt: args.classroom.createdAt,
    updatedAt: args.classroom.updatedAt,
    completedAt: args.progress?.completedAt,
    memorySummary: args.memorySummary,
    suggestedReviewAt: getSuggestedReviewAt({
      completedAt: args.progress?.completedAt,
      now: args.now,
      states: args.conceptStates,
      unassessedConcepts: args.pendingConcepts,
      stableSuccessesRequired: args.stableSuccessesRequired,
    }),
    quiz: completeSummary.quiz,
    latestReport: args.latestReport,
    reports: args.reports ?? (args.latestReport ? [args.latestReport] : []),
    attempts: (args.attempts ?? []).sort((a, b) => b.sequence - a.sequence),
    artifacts: (args.studyArtifacts ?? []).map((artifact) => ({
      artifact,
      stale: artifact.lessonSourceHash !== lessonSourceHash,
    })),
    pendingAssessmentCount: args.pendingConcepts?.length ?? 0,
  };
}
