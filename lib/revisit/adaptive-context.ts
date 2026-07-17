import type {
  RevisitAdaptiveContext,
  RevisitDimension,
  RevisitDimensionScores,
  RevisitFactualError,
} from '@/lib/revisit/types';

interface RevisitPromptFinding {
  id: string;
  title: string;
  feedback: string;
  dimension: RevisitDimension;
  conceptIds: string[];
}

interface RevisitPromptReport {
  completedAt: number;
  summary: string;
  dimensions: RevisitDimensionScores;
  q: number;
  errors: RevisitFactualError[];
  findingsAvailable: boolean;
  strengths?: RevisitPromptFinding[];
  improvements?: RevisitPromptFinding[];
}

export interface RevisitAdaptivePromptContext {
  completedChallengeCount: number;
  memorySummary: RevisitAdaptiveContext['memorySummary'];
  conceptStates: RevisitAdaptiveContext['conceptStates'];
  pendingConcepts?: RevisitAdaptiveContext['pendingConcepts'];
  latestReport?: RevisitPromptReport;
}

function projectFinding(finding: {
  id: string;
  title: string;
  feedback: string;
  dimension: RevisitDimension;
  conceptIds: string[];
}): RevisitPromptFinding {
  return {
    id: finding.id,
    title: finding.title,
    feedback: finding.feedback,
    dimension: finding.dimension,
    conceptIds: finding.conceptIds,
  };
}

export function projectRevisitAdaptiveContextForPrompt(
  context: RevisitAdaptiveContext,
): RevisitAdaptivePromptContext {
  const projected: RevisitAdaptivePromptContext = {
    completedChallengeCount: context.completedChallengeCount,
    memorySummary: context.memorySummary,
    conceptStates: context.conceptStates,
    pendingConcepts: context.pendingConcepts,
  };
  const report = context.latestReport;
  if (!report) return projected;

  const latestReport: RevisitPromptReport = {
    completedAt: report.completedAt,
    summary: report.summary,
    dimensions: {
      clarity: report.dimensions.clarity,
      doubtResolution: report.dimensions.doubtResolution,
      transfer: report.dimensions.transfer,
      errorCorrection: report.dimensions.errorCorrection,
    },
    q: report.q,
    errors: report.errors.map((error) => ({
      id: error.id,
      conceptId: error.conceptId,
      description: error.description,
      corrected: error.corrected,
      severity: error.severity,
    })),
    findingsAvailable: report.findingsVersion === 1,
  };

  if (report.findingsVersion === 1) {
    latestReport.strengths = (report.strengths ?? []).map(projectFinding);
    latestReport.improvements = (report.improvements ?? []).map(projectFinding);
  }

  projected.latestReport = latestReport;
  return projected;
}
