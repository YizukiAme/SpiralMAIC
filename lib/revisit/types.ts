export type RevisitDimension = 'clarity' | 'doubtResolution' | 'transfer' | 'errorCorrection';

export type RevisitDimensionScores = Record<RevisitDimension, number>;

export type RevisitProbeKind = 'confusion' | 'misconception' | 'transfer' | 'correction';

export interface RevisitProbe {
  id: string;
  conceptId: string;
  pageIndex?: number;
  kind: RevisitProbeKind;
  prompt: string;
  expectedAnswer?: string;
  expectedCorrection?: string;
}

export interface RevisitConcept {
  id: string;
  label: string;
  summary: string;
  anchors: Record<RevisitDimension, string[]>;
  probes: RevisitProbe[];
}

export interface RevisitSkeletonPage {
  id: string;
  title: string;
  summary: string;
  conceptIds: string[];
  cues: string[];
}

export interface RevisitSkeleton {
  pages: RevisitSkeletonPage[];
}

export interface RevisitExamBlueprint {
  id: string;
  stageId: string;
  generatedAt: number;
  language: string;
  sourceHash: string;
  concepts: RevisitConcept[];
  skeleton: RevisitSkeleton;
  raw?: unknown;
}

export interface UserConceptState {
  stageId: string;
  conceptId: string;
  label: string;
  hDays: number;
  learnedAt: number;
  lastRetrievalAt: number;
  evidenceCount: number;
  successChallengeDates: string[];
  createdAt: number;
  updatedAt: number;
  stableAt?: number;
}

export interface RevisitFactualError {
  id: string;
  conceptId?: string;
  description: string;
  corrected: boolean;
  severity: 'minor' | 'major' | 'critical';
}

export interface ConceptEvidence {
  id: string;
  attemptId: string;
  stageId: string;
  conceptId: string;
  source: 'teach_back' | 'qa' | 'generation' | 'review';
  scores: RevisitDimensionScores;
  q: number;
  qRaw: number;
  polarity: 'positive' | 'negative' | 'mixed';
  timestamp: number;
  pageIndex?: number;
  notes?: string;
  errors: RevisitFactualError[];
}

export interface RevisitPageReport {
  pageId: string;
  pageIndex: number;
  passed: boolean;
  probeCount: number;
  conceptIds: string[];
  notes?: string;
}

export interface RevisitJudgeReport {
  attemptId: string;
  stageId: string;
  completedAt: number;
  summary: string;
  dimensions: RevisitDimensionScores;
  qRaw: number;
  q: number;
  errors: RevisitFactualError[];
  evidence: ConceptEvidence[];
  pageReports: RevisitPageReport[];
}

export type RevisitGateStatus = 'pass' | 'probe' | 'rescue' | 'fail';

export interface RevisitGateDecision {
  status: RevisitGateStatus;
  pageIndex: number;
  reason: string;
  nextProbeId?: string;
  confidence?: number;
}

export interface RevisitSettings {
  reverseChallengeEnabled: boolean;
  stableSuccessesRequired: number;
  forgettingSpeedMultiplier: number;
  demoAcceleratedClockEnabled: boolean;
  demoGateSkipEnabled: boolean;
}

export interface LessonMemorySummary {
  status: 'unlearned' | 'fresh' | 'review' | 'stable';
  recall: number | null;
  meanRecall: number | null;
  minRecall: number | null;
  color: string;
  badge?: 'stable';
}
