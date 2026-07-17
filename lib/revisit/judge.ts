import type {
  ConceptEvidence,
  RevisitDimension,
  RevisitDimensionScores,
  RevisitFactualError,
  RevisitJudgeReport,
  RevisitPageReport,
  RevisitReportCitation,
  RevisitReportFinding,
} from '@/lib/revisit/types';
import type { RevisitMessage } from '@/lib/revisit/session';

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

interface RawReportCitation {
  kind?: unknown;
  sourceId?: unknown;
}

interface RawReportFinding {
  title?: unknown;
  feedback?: unknown;
  dimension?: unknown;
  conceptIds?: unknown;
  citations?: unknown;
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
  strengths?: RawReportFinding[];
  improvements?: RawReportFinding[];
}

interface NormalizeJudgeReportOptions {
  expectedConceptIds?: string[];
  transcript?: RevisitMessage[];
  pageReports?: RevisitPageReport[];
}

const REQUIRED_DIMENSIONS: RevisitDimension[] = [
  'clarity',
  'doubtResolution',
  'transfer',
  'errorCorrection',
];

function assertDimensionScores(
  raw: Partial<Record<RevisitDimension, unknown>> | undefined,
  label: string,
): void {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} is missing dimension scores`);
  for (const dimension of REQUIRED_DIMENSIONS) {
    const value = raw[dimension];
    if (value === null || value === '' || !Number.isFinite(Number(value))) {
      throw new Error(`${label} is missing ${dimension}`);
    }
  }
}

function stableId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(2, '0')}`;
}

function normalizeTranscriptExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function normalizeFindings(
  rawFindings: RawReportFinding[] | undefined,
  category: 'strength' | 'improvement',
  attemptId: string,
  options: NormalizeJudgeReportOptions,
): RevisitReportFinding[] {
  if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
    throw new Error(`Judge report is missing ${category}s`);
  }

  const expectedConceptIds = new Set(options.expectedConceptIds ?? []);
  const transcriptById = new Map(
    (options.transcript ?? []).map((message) => [message.id, message] as const),
  );
  const pageReportById = new Map(
    (options.pageReports ?? []).map((pageReport) => [pageReport.pageId, pageReport] as const),
  );

  return rawFindings
    .map((finding, findingIndex) => {
      const title = typeof finding.title === 'string' ? finding.title.trim() : '';
      const feedback = typeof finding.feedback === 'string' ? finding.feedback.trim() : '';
      if (!title) throw new Error(`Judge report ${category} ${findingIndex + 1} is missing title`);
      if (!feedback) {
        throw new Error(`Judge report ${category} ${findingIndex + 1} is missing feedback`);
      }
      if (
        typeof finding.dimension !== 'string' ||
        !REQUIRED_DIMENSIONS.includes(finding.dimension as RevisitDimension)
      ) {
        throw new Error(`Judge report ${category} ${findingIndex + 1} has unknown dimension`);
      }

      const conceptIds = Array.isArray(finding.conceptIds)
        ? finding.conceptIds
            .map((conceptId) => (typeof conceptId === 'string' ? conceptId.trim() : ''))
            .filter(Boolean)
        : [];
      if (conceptIds.length === 0) {
        throw new Error(`Judge report ${category} ${findingIndex + 1} is missing concept ids`);
      }
      for (const conceptId of conceptIds) {
        if (!expectedConceptIds.has(conceptId)) {
          throw new Error(`Judge report ${category} references unknown concept ${conceptId}`);
        }
      }

      const rawCitations = Array.isArray(finding.citations)
        ? (finding.citations as RawReportCitation[])
        : [];
      if (rawCitations.length === 0) {
        throw new Error(`Judge report ${category} ${findingIndex + 1} is missing citations`);
      }
      const citations: RevisitReportCitation[] = rawCitations.map((citation) => {
        const sourceId = typeof citation.sourceId === 'string' ? citation.sourceId.trim() : '';
        if (!sourceId) {
          throw new Error(`Judge report ${category} citation is missing source id`);
        }
        if (citation.kind === 'transcript') {
          const message = transcriptById.get(sourceId);
          if (!message) {
            throw new Error(`Judge report ${category} references unknown transcript ${sourceId}`);
          }
          return {
            kind: 'transcript',
            sourceId,
            excerpt: normalizeTranscriptExcerpt(message.text),
          };
        }
        if (citation.kind === 'pageReport') {
          const pageReport = pageReportById.get(sourceId);
          if (!pageReport) {
            throw new Error(`Judge report ${category} references unknown page report ${sourceId}`);
          }
          return {
            kind: 'pageReport',
            sourceId,
            pageId: pageReport.pageId,
            pageIndex: pageReport.pageIndex,
            passed: pageReport.passed,
            probeCount: pageReport.probeCount,
            conceptIds: [...pageReport.conceptIds],
            notes: pageReport.notes,
          };
        }
        throw new Error(`Judge report ${category} citation has unknown kind`);
      });

      return {
        id: stableId(`${attemptId}:${category}`, findingIndex),
        title,
        feedback,
        dimension: finding.dimension as RevisitDimension,
        conceptIds: [...new Set(conceptIds)],
        citations: citations.slice(0, 2),
      };
    })
    .slice(0, 3);
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

export function normalizeJudgeReport(
  raw: RawJudgeReport,
  options: NormalizeJudgeReportOptions = {},
): RevisitJudgeReport {
  if (!String(raw.summary || '').trim()) throw new Error('Judge report is missing summary');
  assertDimensionScores(raw.dimensions, 'Judge report');
  if (!Array.isArray(raw.conceptScores) || raw.conceptScores.length === 0) {
    throw new Error('Judge report is missing concept scores');
  }

  const expectedConceptIds = new Set(options.expectedConceptIds ?? []);
  const seenConceptIds = new Set<string>();
  for (const [index, score] of raw.conceptScores.entries()) {
    const conceptId = typeof score.conceptId === 'string' ? score.conceptId.trim() : '';
    if (!conceptId) throw new Error(`Judge concept score ${index + 1} is missing concept id`);
    if (seenConceptIds.has(conceptId)) {
      throw new Error(`Judge report has duplicate concept evidence for ${conceptId}`);
    }
    if (expectedConceptIds.size > 0 && !expectedConceptIds.has(conceptId)) {
      throw new Error(`Judge report references unknown concept ${conceptId}`);
    }
    assertDimensionScores(score.scores, `Judge concept score ${conceptId}`);
    seenConceptIds.add(conceptId);
  }
  for (const expectedConceptId of expectedConceptIds) {
    if (!seenConceptIds.has(expectedConceptId)) {
      throw new Error(`Judge report is missing concept evidence for ${expectedConceptId}`);
    }
  }
  for (const error of raw.errors ?? []) {
    if (
      typeof error.conceptId === 'string' &&
      expectedConceptIds.size > 0 &&
      !expectedConceptIds.has(error.conceptId)
    ) {
      throw new Error(`Judge report error references unknown concept ${error.conceptId}`);
    }
  }

  const attemptId = String(raw.attemptId || `attempt-${Date.now()}`);
  const stageId = String(raw.stageId || '');
  const completedAt =
    typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt)
      ? raw.completedAt
      : Date.now();
  const errors = normalizeErrors(raw.errors);
  const overall = computeJudgeQ(raw.dimensions || {}, errors);
  const conceptScores = Array.isArray(raw.conceptScores) ? raw.conceptScores : [];
  const strengths = normalizeFindings(raw.strengths, 'strength', attemptId, options);
  const improvements = normalizeFindings(raw.improvements, 'improvement', attemptId, options);

  const evidence: ConceptEvidence[] = conceptScores
    .filter((score) => typeof score.conceptId === 'string' && score.conceptId.length > 0)
    .map((score, index) => {
      const conceptErrors = errors.filter((error) => error.conceptId === score.conceptId);
      const conceptQ = computeJudgeQ(score.scores || {}, conceptErrors);
      return {
        id: stableId(`${attemptId}:evidence`, index),
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
    pageReports: (options.pageReports ?? []).map((pageReport) => ({
      ...pageReport,
      conceptIds: [...pageReport.conceptIds],
    })),
    findingsVersion: 1,
    strengths,
    improvements,
  };
}
