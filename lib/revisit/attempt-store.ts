import { getRevisitDatabase } from '@/lib/revisit/db';
import { formalRevisitCall, shouldUseFormalRevisitServer } from '@/lib/revisit/formal-transport';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';
import type { RevisitAttempt, RevisitExamBlueprint } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const LEGACY_ATTEMPT_KEY_PREFIX = 'revisitAttempt:';

export async function createOrGetRevisitAttempt(args: {
  attemptId: string;
  stage: Stage;
  sourceScenes: Scene[];
  now?: number;
  scope?: RevisitDataScope;
}): Promise<RevisitAttempt> {
  if (shouldUseFormalRevisitServer(args.scope)) {
    return formalRevisitCall('createOrGetRevisitAttempt', {
      attemptId: args.attemptId,
      stage: args.stage,
      sourceScenes: args.sourceScenes,
      now: args.now ?? Date.now(),
    });
  }
  const db = getRevisitDatabase(args.scope);
  const now = args.now ?? Date.now();
  return db.transaction('rw', db.revisitAttempts, async () => {
    const attempts = await db.revisitAttempts.where('stageId').equals(args.stage.id).toArray();
    const unfinished = attempts.find((attempt) => attempt.status !== 'completed');
    if (unfinished) return unfinished;
    const sequence = attempts.reduce((max, attempt) => Math.max(max, attempt.sequence), 0) + 1;
    const attempt: RevisitAttempt = {
      attemptId: args.attemptId,
      stageId: args.stage.id,
      sequence,
      status: 'preparing',
      sourceStage: structuredClone(args.stage),
      sourceScenes: structuredClone(args.sourceScenes),
      scenes: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.revisitAttempts.add(attempt);
    return attempt;
  });
}

export async function getRevisitAttempt(
  attemptId: string,
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<RevisitAttempt | undefined> {
  if (shouldUseFormalRevisitServer(scope))
    return formalRevisitCall('getRevisitAttempt', { attemptId });
  return getRevisitDatabase(scope).revisitAttempts.get(attemptId);
}

export async function listRevisitAttempts(
  stageId: string,
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<RevisitAttempt[]> {
  if (shouldUseFormalRevisitServer(scope))
    return formalRevisitCall('listRevisitAttempts', { stageId });
  const records = await getRevisitDatabase(scope)
    .revisitAttempts.where('stageId')
    .equals(stageId)
    .toArray();
  return records.sort((a, b) => b.sequence - a.sequence);
}

export async function saveRevisitAttemptBlueprint(
  attemptId: string,
  blueprint: RevisitExamBlueprint,
  now = Date.now(),
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<RevisitAttempt> {
  if (shouldUseFormalRevisitServer(scope))
    return formalRevisitCall('saveRevisitAttemptBlueprint', { attemptId, blueprint, now });
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.revisitAttempts, async () => {
    const existing = await requireAttempt(attemptId, scope);
    const scenes =
      existing.scenes.length >= blueprint.skeleton.pages.length
        ? [...existing.scenes]
        : Array<Scene | null>(blueprint.skeleton.pages.length).fill(null);
    const next = {
      ...existing,
      blueprint,
      scenes,
      updatedAt: now,
      preparationError: undefined,
    };
    await db.revisitAttempts.put(next);
    return next;
  });
}

export async function saveRevisitAttemptSource(
  attemptId: string,
  sourceStage: Stage,
  sourceScenes: Scene[],
  now = Date.now(),
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<RevisitAttempt> {
  if (shouldUseFormalRevisitServer(scope))
    return formalRevisitCall('saveRevisitAttemptSource', {
      attemptId,
      sourceStage,
      sourceScenes,
      now,
    });
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.revisitAttempts, async () => {
    const existing = await requireAttempt(attemptId, scope);
    const next = {
      ...existing,
      sourceStage: structuredClone(sourceStage),
      sourceScenes: structuredClone(sourceScenes),
      updatedAt: now,
    };
    await db.revisitAttempts.put(next);
    return next;
  });
}

export async function setRevisitAttemptSpiralAgentGenerationState(
  attemptId: string,
  state: NonNullable<RevisitAttempt['spiralAgentGenerationState']>,
  now = Date.now(),
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<RevisitAttempt> {
  if (shouldUseFormalRevisitServer(scope))
    return formalRevisitCall('setRevisitAttemptSpiralAgentGenerationState', {
      attemptId,
      state,
      now,
    });
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.revisitAttempts, async () => {
    const existing = await requireAttempt(attemptId, scope);
    const next: RevisitAttempt = {
      ...existing,
      spiralAgentGenerationState: state,
      updatedAt: now,
    };
    await db.revisitAttempts.put(next);
    return next;
  });
}

export async function upsertRevisitAttemptScene(args: {
  attemptId: string;
  scene: Scene;
  index: number;
  now?: number;
  scope?: RevisitDataScope;
}): Promise<RevisitAttempt> {
  if (shouldUseFormalRevisitServer(args.scope))
    return formalRevisitCall('upsertRevisitAttemptScene', {
      attemptId: args.attemptId,
      scene: args.scene,
      index: args.index,
      now: args.now ?? Date.now(),
    });
  const scope = args.scope ?? FORMAL_REVISIT_SCOPE;
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.revisitAttempts, async () => {
    const existing = await requireAttempt(args.attemptId, scope);
    if (!existing.blueprint) throw new Error('Could not persist revisit scene before blueprint.');
    const scenes =
      existing.scenes.length >= existing.blueprint.skeleton.pages.length
        ? [...existing.scenes]
        : Array<Scene | null>(existing.blueprint.skeleton.pages.length).fill(null);
    scenes[args.index] = args.scene;
    const next: RevisitAttempt = {
      ...existing,
      scenes,
      status: existing.status === 'completed' ? 'completed' : scenes[0] ? 'ready' : 'preparing',
      updatedAt: args.now ?? Date.now(),
      preparationError: undefined,
    };
    await db.revisitAttempts.put(next);
    return next;
  });
}

export async function setRevisitAttemptPreparationError(
  attemptId: string,
  error: string,
  now = Date.now(),
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<void> {
  if (shouldUseFormalRevisitServer(scope)) {
    await formalRevisitCall('setRevisitAttemptPreparationError', { attemptId, error, now });
    return;
  }
  const db = getRevisitDatabase(scope);
  await db.revisitAttempts.update(attemptId, { preparationError: error, updatedAt: now });
}

export async function markRevisitAttemptCompleted(
  attemptId: string,
  completedAt = Date.now(),
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<RevisitAttempt> {
  if (shouldUseFormalRevisitServer(scope))
    return formalRevisitCall('markRevisitAttemptCompleted', { attemptId, completedAt });
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.revisitAttempts, async () => {
    const existing = await requireAttempt(attemptId, scope);
    if (existing.status === 'completed') return existing;
    const next = {
      ...existing,
      status: 'completed' as const,
      completedAt,
      updatedAt: completedAt,
      preparationError: undefined,
    };
    await db.revisitAttempts.put(next);
    return next;
  });
}

async function requireAttempt(attemptId: string, scope: RevisitDataScope) {
  const attempt = await getRevisitDatabase(scope).revisitAttempts.get(attemptId);
  if (!attempt) throw new Error(`Could not persist revisit attempt: ${attemptId} was not found`);
  return attempt;
}

interface LegacyAttemptSnapshot {
  attemptId: string;
  stageId: string;
  blueprint: RevisitExamBlueprint;
  scenes: Array<Scene | null>;
  createdAt: number;
  updatedAt: number;
}

/** Imports old tab-scoped generated content once. Runtime fields are intentionally discarded. */
export async function importLegacyRevisitAttemptSnapshot(
  attemptId: string,
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): Promise<RevisitAttempt | undefined> {
  if (typeof window === 'undefined') return undefined;
  const key = `${LEGACY_ATTEMPT_KEY_PREFIX}${attemptId}`;
  const raw = window.sessionStorage.getItem(key);
  if (!raw) return getRevisitAttempt(attemptId, scope);
  try {
    const legacy = JSON.parse(raw) as LegacyAttemptSnapshot;
    if (shouldUseFormalRevisitServer(scope)) {
      const attempt = await formalRevisitCall<RevisitAttempt>('importLegacyAttemptSnapshot', {
        attempt: {
          attemptId,
          stageId: legacy.stageId,
          sequence: 0,
          status: legacy.scenes[0] ? 'ready' : 'preparing',
          sourceScenes: [],
          blueprint: legacy.blueprint,
          scenes: legacy.scenes,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
          reportOnly: false,
        } satisfies RevisitAttempt,
      });
      window.sessionStorage.removeItem(key);
      return attempt;
    }
    const db = getRevisitDatabase(scope);
    const existing = await db.revisitAttempts.get(attemptId);
    const attempts = await db.revisitAttempts.where('stageId').equals(legacy.stageId).toArray();
    const imported: RevisitAttempt = {
      ...(existing ?? {
        attemptId,
        stageId: legacy.stageId,
        sequence: attempts.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
        status: legacy.scenes[0] ? 'ready' : 'preparing',
        sourceScenes: [],
        createdAt: legacy.createdAt,
      }),
      blueprint: legacy.blueprint,
      scenes: legacy.scenes,
      updatedAt: legacy.updatedAt,
      reportOnly: false,
    };
    await db.revisitAttempts.put(imported);
    window.sessionStorage.removeItem(key);
    return imported;
  } catch {
    return undefined;
  }
}
