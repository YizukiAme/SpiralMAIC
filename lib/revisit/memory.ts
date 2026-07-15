import type { ConceptEvidence, LessonMemorySummary, UserConceptState } from '@/lib/revisit/types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const INITIAL_HALF_LIFE_DAYS = 4;
export const MIN_HALF_LIFE_DAYS = 1;
export const MAX_HALF_LIFE_DAYS = 180;
export const REVIEW_RECALL_THRESHOLD = 0.55;
export const LOW_BENEFIT_RECALL_THRESHOLD = 0.8;
export const STABLE_HALF_LIFE_DAYS = 120;
export const DEFAULT_STABLE_SUCCESSES_REQUIRED = 2;
export const SUCCESS_Q_THRESHOLD = 0.75;

export interface HalfLifeUpdateOptions {
  currentHDays: number;
  q: number;
  retrievability: number;
  etaPlus?: number;
  etaMinus?: number;
  lambda?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function daysBetween(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, (toMs - fromMs) / DAY_MS);
}

export function toDateKey(
  timestamp: number,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function computeConceptRecall(
  state: Pick<UserConceptState, 'hDays' | 'lastRetrievalAt'>,
  now: number,
): number {
  const hDays = clamp(state.hDays, MIN_HALF_LIFE_DAYS, MAX_HALF_LIFE_DAYS);
  const deltaDays = daysBetween(state.lastRetrievalAt, now);
  return Number(Math.pow(2, -deltaDays / hDays).toFixed(12));
}

export function computeLessonRecall(recalls: number[]): {
  recall: number;
  meanRecall: number;
  minRecall: number;
} {
  const meanRecall = recalls.reduce((sum, recall) => sum + recall, 0) / recalls.length;
  const minRecall = Math.min(...recalls);
  return {
    recall: 0.7 * meanRecall + 0.3 * minRecall,
    meanRecall,
    minRecall,
  };
}

export function revisitColorForRecall(recall: number | null, stable = false): string {
  if (stable) return '#64748b';
  if (recall === null) return '#94a3b8';

  const clamped = clamp(recall, 0, 1);
  const hue = 4 + (142 - 4) * clamped;
  const saturation = 72;
  const lightness = 46 - 8 * (1 - clamped);
  return `hsl(${Math.round(hue)} ${saturation}% ${Math.round(lightness)}%)`;
}

export function computeLessonMemory(
  states: UserConceptState[],
  now: number,
  options: {
    stableSuccessesRequired?: number;
  } = {},
): LessonMemorySummary {
  const learnedStates = filterJudgedConceptStates(states).filter((state) =>
    Number.isFinite(state.learnedAt),
  );
  if (learnedStates.length === 0) {
    return {
      status: 'unlearned',
      recall: null,
      meanRecall: null,
      minRecall: null,
      color: revisitColorForRecall(null),
    };
  }

  const stableSuccessesRequired =
    options.stableSuccessesRequired ?? DEFAULT_STABLE_SUCCESSES_REQUIRED;
  const allStable = learnedStates.every((state) => isStableState(state, stableSuccessesRequired));
  const recalls = learnedStates.map((state) => computeConceptRecall(state, now));
  const { recall, meanRecall, minRecall } = computeLessonRecall(recalls);

  if (allStable) {
    return {
      status: 'stable',
      recall,
      meanRecall,
      minRecall,
      color: revisitColorForRecall(recall, true),
      badge: 'stable',
    };
  }

  return {
    status: recall < REVIEW_RECALL_THRESHOLD ? 'review' : 'fresh',
    recall,
    meanRecall,
    minRecall,
    color: revisitColorForRecall(recall),
  };
}

export function computeLessonMemoryFromCompletion(
  completedAt: number,
  now: number,
): LessonMemorySummary {
  const recall = computeConceptRecall(
    { hDays: INITIAL_HALF_LIFE_DAYS, lastRetrievalAt: completedAt },
    now,
  );
  return {
    status: recall < REVIEW_RECALL_THRESHOLD ? 'review' : 'fresh',
    recall,
    meanRecall: recall,
    minRecall: recall,
    color: revisitColorForRecall(recall),
  };
}

export function getSuggestedReviewAt(args: {
  completedAt?: number;
  now: number;
  states: UserConceptState[];
  stableSuccessesRequired?: number;
  unassessedConcepts?: Array<{ learnedAt?: number }>;
}): number | null {
  const unassessedReviewAt = (args.unassessedConcepts ?? []).reduce<number | null>(
    (earliest, concept) => {
      if (!Number.isFinite(concept.learnedAt)) return earliest;
      const thresholdAt =
        concept.learnedAt! - INITIAL_HALF_LIFE_DAYS * Math.log2(REVIEW_RECALL_THRESHOLD) * DAY_MS;
      const candidate = thresholdAt <= args.now ? args.now : thresholdAt;
      return earliest === null ? candidate : Math.min(earliest, candidate);
    },
    null,
  );
  const withUnassessed = (judgedReviewAt: number | null) => {
    if (judgedReviewAt === null) return unassessedReviewAt;
    if (unassessedReviewAt === null) return judgedReviewAt;
    return Math.min(judgedReviewAt, unassessedReviewAt);
  };
  const judgedStates = filterJudgedConceptStates(args.states);
  if (judgedStates.length === 0) {
    if (!Number.isFinite(args.completedAt)) return unassessedReviewAt;
    const current = computeLessonMemoryFromCompletion(args.completedAt!, args.now);
    if (current.status === 'review') return withUnassessed(args.now);
    const daysToThreshold = -INITIAL_HALF_LIFE_DAYS * Math.log2(REVIEW_RECALL_THRESHOLD);
    const thresholdAt = args.completedAt! + daysToThreshold * DAY_MS;
    return withUnassessed(thresholdAt <= args.now ? args.now : thresholdAt);
  }

  const current = computeLessonMemory(judgedStates, args.now, {
    stableSuccessesRequired: args.stableSuccessesRequired,
  });
  if (current.status === 'review') return withUnassessed(args.now);
  if (current.status === 'stable') return unassessedReviewAt;
  let lo = args.now;
  let hi = args.now + MAX_HALF_LIFE_DAYS * DAY_MS;
  for (let i = 0; i < 32; i += 1) {
    const mid = lo + (hi - lo) / 2;
    const memory = computeLessonMemory(judgedStates, mid, {
      stableSuccessesRequired: args.stableSuccessesRequired,
    });
    if ((memory.recall ?? 0) < REVIEW_RECALL_THRESHOLD) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return withUnassessed(hi);
}

export function updateHalfLifeDays({
  currentHDays,
  q,
  retrievability,
  etaPlus = 0.8,
  etaMinus = 1.2,
  lambda = 1,
}: HalfLifeUpdateOptions): number {
  const current = clamp(currentHDays, MIN_HALF_LIFE_DAYS, MAX_HALF_LIFE_DAYS);
  const quality = clamp(q, 0.05, 0.98);
  const recall = clamp(retrievability, 0, 1);

  const successfulRetrieval = quality >= SUCCESS_Q_THRESHOLD;
  const positiveEvidence = successfulRetrieval ? Math.max(quality - recall, 0) : 0;
  const negativeEvidence = successfulRetrieval
    ? Math.max(recall - quality, 0)
    : Math.max(recall - quality, SUCCESS_Q_THRESHOLD - quality);
  const deltaLog =
    etaPlus * positiveEvidence * (1 + lambda * (1 - recall)) - etaMinus * negativeEvidence;

  return clamp(
    Number((current * Math.exp(deltaLog)).toFixed(6)),
    MIN_HALF_LIFE_DAYS,
    MAX_HALF_LIFE_DAYS,
  );
}

export function isStableState(
  state: Pick<UserConceptState, 'hDays' | 'successChallengeDates' | 'stableAt'>,
  stableSuccessesRequired = DEFAULT_STABLE_SUCCESSES_REQUIRED,
): boolean {
  const uniqueDates = new Set(state.successChallengeDates);
  return state.hDays > STABLE_HALF_LIFE_DAYS && uniqueDates.size >= stableSuccessesRequired;
}

export function filterJudgedConceptStates(states: UserConceptState[]): UserConceptState[] {
  return states.filter((state) => state.evidenceCount > 0);
}

export function createConceptStateFromEvidence(
  evidence: ConceptEvidence,
  options: { label?: string; learnedAt?: number } = {},
): UserConceptState {
  const learnedAt =
    Number.isFinite(options.learnedAt) && options.learnedAt! <= evidence.timestamp
      ? options.learnedAt!
      : evidence.timestamp;
  return {
    stageId: evidence.stageId,
    conceptId: evidence.conceptId,
    label: options.label || evidence.conceptId,
    hDays: INITIAL_HALF_LIFE_DAYS,
    learnedAt,
    lastRetrievalAt: learnedAt,
    evidenceCount: 0,
    successChallengeDates: [],
    createdAt: learnedAt,
    updatedAt: learnedAt,
  };
}

export function applyEvidenceToConceptState(
  state: UserConceptState,
  evidence: ConceptEvidence,
  options: {
    now?: number;
    stableSuccessesRequired?: number;
  } = {},
): UserConceptState {
  const now = options.now ?? evidence.timestamp;
  const retrievability = computeConceptRecall(state, now);
  const nextHDays = updateHalfLifeDays({
    currentHDays: state.hDays,
    q: evidence.q,
    retrievability,
  });
  const successChallengeDates =
    evidence.q >= SUCCESS_Q_THRESHOLD
      ? Array.from(new Set([...state.successChallengeDates, toDateKey(evidence.timestamp)])).sort()
      : state.successChallengeDates;

  const next: UserConceptState = {
    ...state,
    hDays: nextHDays,
    lastRetrievalAt: now,
    evidenceCount: state.evidenceCount + 1,
    successChallengeDates,
    updatedAt: now,
  };

  if (isStableState(next, options.stableSuccessesRequired ?? DEFAULT_STABLE_SUCCESSES_REQUIRED)) {
    next.stableAt = next.stableAt ?? now;
  } else {
    next.stableAt = undefined;
  }

  return next;
}
