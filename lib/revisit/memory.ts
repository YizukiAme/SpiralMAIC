import type {
  ConceptEvidence,
  LessonMemorySummary,
  RevisitExamBlueprint,
  UserConceptState,
} from '@/lib/revisit/types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const INITIAL_HALF_LIFE_DAYS = 4;
export const MIN_HALF_LIFE_DAYS = 1;
export const MAX_HALF_LIFE_DAYS = 180;
export const REVIEW_RECALL_THRESHOLD = 0.55;
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

function daysBetween(fromMs: number, toMs: number, multiplier = 1): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, ((toMs - fromMs) / DAY_MS) * Math.max(0, multiplier));
}

export function toDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function computeConceptRecall(
  state: Pick<UserConceptState, 'hDays' | 'lastRetrievalAt'>,
  now: number,
  forgettingSpeedMultiplier = 1,
): number {
  const hDays = clamp(state.hDays, MIN_HALF_LIFE_DAYS, MAX_HALF_LIFE_DAYS);
  const deltaDays = daysBetween(state.lastRetrievalAt, now, forgettingSpeedMultiplier);
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
    forgettingSpeedMultiplier?: number;
    stableSuccessesRequired?: number;
  } = {},
): LessonMemorySummary {
  const learnedStates = states.filter((state) => Number.isFinite(state.learnedAt));
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
  const recalls = learnedStates.map((state) =>
    computeConceptRecall(state, now, options.forgettingSpeedMultiplier ?? 1),
  );
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

  const positiveEvidence = Math.max(quality - recall, 0);
  const negativeEvidence = Math.max(recall - quality, 0);
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
  if (state.stableAt) return true;
  const uniqueDates = new Set(state.successChallengeDates);
  return state.hDays > STABLE_HALF_LIFE_DAYS && uniqueDates.size >= stableSuccessesRequired;
}

export function createInitialConceptStates(
  blueprint: RevisitExamBlueprint,
  learnedAt: number,
): UserConceptState[] {
  return blueprint.concepts.map((concept) => ({
    stageId: blueprint.stageId,
    conceptId: concept.id,
    label: concept.label,
    hDays: INITIAL_HALF_LIFE_DAYS,
    learnedAt,
    lastRetrievalAt: learnedAt,
    evidenceCount: 0,
    successChallengeDates: [],
    createdAt: learnedAt,
    updatedAt: learnedAt,
  }));
}

export function applyEvidenceToConceptState(
  state: UserConceptState,
  evidence: ConceptEvidence,
  options: {
    now?: number;
    stableSuccessesRequired?: number;
    forgettingSpeedMultiplier?: number;
  } = {},
): UserConceptState {
  const now = options.now ?? evidence.timestamp;
  const retrievability = computeConceptRecall(state, now, options.forgettingSpeedMultiplier ?? 1);
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
  }

  return next;
}
