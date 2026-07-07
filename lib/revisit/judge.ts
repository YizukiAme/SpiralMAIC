import type {
  ConceptEvidence,
  RevisitDimension,
  RevisitDimensionScores,
  RevisitFactualError,
  RevisitJudgeReport,
  RevisitPageReport,
} from '@/lib/revisit/types';

const DIMENSION_WEIGHTS: Record<RevisitDimension, number> = {
  clarity: 0.25,
  doubtResolution: 0.2,
  transfer: 0.3,
  errorCorrection: 0.25,
};

const DEFAULT_UNCORRECTED_ERROR_DEDUCTION = 0.15;

function clamp(value: number, min = 0.05, max = 0.98): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeScore(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1) return Math.min(1, numeric / 100);
  return Math.min(1, Math.max(0, numeric));
}

export function normalizeDimensionScores(raw: Partial<Record<RevisitDimension, unknown>>) {
  return {
    clarity: normalizeScore(raw.clarity),
    doubtResolution: normalizeScore(raw.doubtResolution),
    transfer: normalizeScore(raw.transfer),
    errorCorrection: normalizeScore(raw.errorCorrection),
  } satisfies RevisitDimensionScores;
}

export function computeJudgeQ(
  scores: Partial<Record<RevisitDimension, unknown>>,
  errors: RevisitFactualError[] = [],
  options: { uncorrectedErrorDeduction?: number } = {},
): {
  scores: RevisitDimensionScores;
  qRaw: number;
  q: number;
  uncorrectedErrorCount: number;
} {
  const normalized = normalizeDimensionScores(scores);
  const qRaw = (Object.keys(DIMENSION_WEIGHTS) as RevisitDimension[]).reduce(
    (sum, key) => sum + DIMENSION_WEIGHTS[key] * normalized[key],
    0,
  );
  const uncorrectedErrorCount = errors.filter((error) => !error.corrected).length;
  const deduction =
    uncorrectedErrorCount *
    (options.uncorrectedErrorDeduction ?? DEFAULT_UNCORRECTED_ERROR_DEDUCTION);

  return {
    scores: normalized,
    qRaw,
    q: clamp(qRaw - deduction),
    uncorrectedErrorCount,
  };
}

interface RawConceptScore {
  conceptId?: unknown;
  scores?: Partial<Record<RevisitDimension, unknown>>;
  pageIndex?: unknown;
  notes?: unknown;
}

interface RawJudgeReport {
  attemptId?: unknown;
  stageId?: unknown;
  completedAt?: unknown;
  summary?: unknown;
  dimensions?: Partial<Record<RevisitDimension, unknown>>;
  conceptScores?: RawConceptScore[];
  errors?: Array<Partial<RevisitFactualError>>;
  pageReports?: Array<Partial<RevisitPageReport>>;
}

function stableId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(2, '0')}`;
}

function normalizeErrors(rawErrors: RawJudgeReport['errors'] = []): RevisitFactualError[] {
  return rawErrors.map((error, index) => ({
    id: typeof error.id === 'string' && error.id ? error.id : stableId('err', index),
    conceptId: typeof error.conceptId === 'string' ? error.conceptId : undefined,
    description: String(error.description || ''),
    corrected: Boolean(error.corrected),
    severity:
      error.severity === 'critical' || error.severity === 'major' || error.severity === 'minor'
        ? error.severity
        : 'major',
  }));
}

function polarityForQ(q: number): ConceptEvidence['polarity'] {
  if (q >= 0.75) return 'positive';
  if (q < 0.45) return 'negative';
  return 'mixed';
}

export function normalizeJudgeReport(raw: RawJudgeReport): RevisitJudgeReport {
  const attemptId = String(raw.attemptId || `attempt-${Date.now()}`);
  const stageId = String(raw.stageId || '');
  const completedAt =
    typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt)
      ? raw.completedAt
      : Date.now();
  const errors = normalizeErrors(raw.errors);
  const overall = computeJudgeQ(raw.dimensions || {}, errors);
  const conceptScores = Array.isArray(raw.conceptScores) ? raw.conceptScores : [];

  const evidence: ConceptEvidence[] = conceptScores
    .filter((score) => typeof score.conceptId === 'string' && score.conceptId.length > 0)
    .map((score, index) => {
      const conceptErrors = errors.filter((error) => error.conceptId === score.conceptId);
      const conceptQ = computeJudgeQ(score.scores || {}, conceptErrors);
      return {
        id: stableId('evidence', index),
        attemptId,
        stageId,
        conceptId: score.conceptId as string,
        source: 'teach_back',
        scores: conceptQ.scores,
        q: conceptQ.q,
        qRaw: conceptQ.qRaw,
        polarity: polarityForQ(conceptQ.q),
        timestamp: completedAt,
        pageIndex:
          typeof score.pageIndex === 'number' && Number.isFinite(score.pageIndex)
            ? score.pageIndex
            : undefined,
        notes: typeof score.notes === 'string' ? score.notes : undefined,
        errors: conceptErrors,
      };
    });

  return {
    attemptId,
    stageId,
    completedAt,
    summary: String(raw.summary || ''),
    dimensions: overall.scores,
    qRaw: overall.qRaw,
    q: overall.q,
    errors,
    evidence,
    pageReports: Array.isArray(raw.pageReports) ? (raw.pageReports as RevisitPageReport[]) : [],
  };
}
