import Dexie, { type EntityTable, type Transaction } from 'dexie';

import { createStudyArtifactVersionId } from '@/lib/revisit/artifact-ids';
import {
  applyEvidenceToConceptState,
  createConceptStateFromEvidence,
  DEFAULT_STABLE_SUCCESSES_REQUIRED,
  filterJudgedConceptStates,
} from '@/lib/revisit/memory';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';
import type {
  ConceptEvidence,
  LessonProgress,
  LessonConcept,
  RevisitAttempt,
  RevisitDemoSession,
  RevisitExamBlueprint,
  RevisitJudgeReport,
  StudyArtifact,
  StudyArtifactDraft,
  StudyPracticeState,
  UserConceptState,
} from '@/lib/revisit/types';

export const REVISIT_DATABASE_NAME = 'SpiralMAIC-Revisit';
export const REVISIT_DEMO_DATABASE_PREFIX = `${REVISIT_DATABASE_NAME}-Demo-`;

interface LegacyStudyMaterialRecord {
  id: string;
  stageId: string;
  generatedAt: number;
  sourceHash: string;
}

const V6_STORES = {
  userConceptState: '[stageId+conceptId], stageId, conceptId, lastRetrievalAt, stableAt, updatedAt',
  conceptEvidence:
    'id, stageId, conceptId, attemptId, timestamp, [stageId+timestamp], [stageId+conceptId]',
  examBlueprints: 'id, stageId, generatedAt, sourceHash',
  skeletonDecks: 'id, stageId, blueprintId, generatedAt, sourceHash',
  revisitReports: 'attemptId, stageId, completedAt',
  lessonProgress: 'stageId, completedAt, updatedAt',
  studyMaterials: 'id, stageId, generatedAt, sourceHash, [stageId+generatedAt]',
  studyArtifacts:
    'id, stageId, kind, version, updatedAt, [stageId+kind], [stageId+kind+version], [stageId+updatedAt]',
  studyPractice: 'artifactId, stageId, kind, updatedAt, [stageId+kind], [stageId+updatedAt]',
  revisitAttempts:
    'attemptId, stageId, sequence, status, createdAt, completedAt, [stageId+sequence], [stageId+status]',
  revisitDemoSessions: 'id, status, createdAt, updatedAt',
} as const;

const V7_STORES = {
  ...V6_STORES,
  lessonConcepts:
    '[stageId+conceptId], stageId, conceptId, origin, learnedAt, updatedAt, [stageId+origin]',
} as const;

const V8_STORES = {
  skeletonDecks: null,
} as const;

const CLONED_TABLE_NAMES = [
  'userConceptState',
  'conceptEvidence',
  'examBlueprints',
  'revisitReports',
  'lessonProgress',
  'studyMaterials',
  'studyArtifacts',
  'studyPractice',
  'revisitAttempts',
  'lessonConcepts',
] as const;

export class RevisitDatabase extends Dexie {
  userConceptState!: EntityTable<UserConceptState, 'conceptId'>;
  conceptEvidence!: EntityTable<ConceptEvidence, 'id'>;
  examBlueprints!: EntityTable<RevisitExamBlueprint, 'id'>;
  revisitReports!: EntityTable<RevisitJudgeReport, 'attemptId'>;
  lessonProgress!: EntityTable<LessonProgress, 'stageId'>;
  studyMaterials!: EntityTable<LegacyStudyMaterialRecord, 'id'>;
  studyArtifacts!: EntityTable<StudyArtifact, 'id'>;
  studyPractice!: EntityTable<StudyPracticeState, 'artifactId'>;
  revisitAttempts!: EntityTable<RevisitAttempt, 'attemptId'>;
  revisitDemoSessions!: EntityTable<RevisitDemoSession, 'id'>;
  lessonConcepts!: EntityTable<LessonConcept, 'conceptId'>;

  constructor(name = REVISIT_DATABASE_NAME) {
    super(name);

    this.version(1).stores({
      userConceptState: V6_STORES.userConceptState,
      conceptEvidence: V6_STORES.conceptEvidence,
      examBlueprints: V6_STORES.examBlueprints,
      revisitReports: V6_STORES.revisitReports,
    });
    this.version(2).stores({
      userConceptState: V6_STORES.userConceptState,
      conceptEvidence: V6_STORES.conceptEvidence,
      examBlueprints: V6_STORES.examBlueprints,
      skeletonDecks: V6_STORES.skeletonDecks,
      revisitReports: V6_STORES.revisitReports,
    });
    this.version(3).stores({
      userConceptState: V6_STORES.userConceptState,
      conceptEvidence: V6_STORES.conceptEvidence,
      examBlueprints: V6_STORES.examBlueprints,
      skeletonDecks: V6_STORES.skeletonDecks,
      revisitReports: V6_STORES.revisitReports,
      lessonProgress: V6_STORES.lessonProgress,
    });
    this.version(4).stores({
      userConceptState: V6_STORES.userConceptState,
      conceptEvidence: V6_STORES.conceptEvidence,
      examBlueprints: V6_STORES.examBlueprints,
      skeletonDecks: V6_STORES.skeletonDecks,
      revisitReports: V6_STORES.revisitReports,
      lessonProgress: V6_STORES.lessonProgress,
      studyMaterials: V6_STORES.studyMaterials,
    });
    this.version(5).stores({
      userConceptState: V6_STORES.userConceptState,
      conceptEvidence: V6_STORES.conceptEvidence,
      examBlueprints: V6_STORES.examBlueprints,
      skeletonDecks: V6_STORES.skeletonDecks,
      revisitReports: V6_STORES.revisitReports,
      lessonProgress: V6_STORES.lessonProgress,
      studyMaterials: V6_STORES.studyMaterials,
      studyArtifacts: V6_STORES.studyArtifacts,
      studyPractice: V6_STORES.studyPractice,
    });
    this.version(6)
      .stores(V6_STORES)
      .upgrade(async (transaction) => migrateReportsToAttempts(transaction));
    this.version(7)
      .stores(V7_STORES)
      .upgrade(async (transaction) => migrateLessonConceptDirectory(transaction));
    this.version(8).stores(V8_STORES);
  }
}

async function migrateReportsToAttempts(transaction: Transaction): Promise<void> {
  const reports = (await transaction.table('revisitReports').toArray()) as RevisitJudgeReport[];
  if (reports.length === 0) return;
  const grouped = new Map<string, RevisitJudgeReport[]>();
  for (const report of reports) {
    const group = grouped.get(report.stageId) ?? [];
    group.push(report);
    grouped.set(report.stageId, group);
  }
  const attempts: RevisitAttempt[] = [];
  for (const [stageId, group] of grouped) {
    group
      .sort((a, b) => a.completedAt - b.completedAt || a.attemptId.localeCompare(b.attemptId))
      .forEach((report, index) => {
        attempts.push({
          attemptId: report.attemptId,
          stageId,
          sequence: index + 1,
          status: 'completed',
          sourceScenes: [],
          scenes: [],
          createdAt: report.completedAt,
          updatedAt: report.completedAt,
          completedAt: report.completedAt,
          reportOnly: true,
        });
      });
  }
  await transaction.table('revisitAttempts').bulkPut(attempts);
}

async function migrateLessonConceptDirectory(transaction: Transaction): Promise<void> {
  const [blueprints, states, progressRows] = await Promise.all([
    transaction.table('examBlueprints').toArray() as Promise<RevisitExamBlueprint[]>,
    transaction.table('userConceptState').toArray() as Promise<UserConceptState[]>,
    transaction.table('lessonProgress').toArray() as Promise<LessonProgress[]>,
  ]);
  const progressByStage = new Map(progressRows.map((progress) => [progress.stageId, progress]));
  const records = new Map<string, LessonConcept>();
  for (const blueprint of blueprints.sort((a, b) => a.generatedAt - b.generatedAt)) {
    const completedAt = progressByStage.get(blueprint.stageId)?.completedAt;
    for (const concept of blueprint.concepts) {
      const key = `${blueprint.stageId}\u0000${concept.id}`;
      const existing = records.get(key);
      const introducedAt = existing?.introducedAt ?? completedAt ?? blueprint.generatedAt;
      records.set(key, {
        stageId: blueprint.stageId,
        conceptId: concept.id,
        label: concept.label,
        summary: concept.summary,
        origin: existing?.origin ?? 'lesson',
        sourceSceneIds: existing?.sourceSceneIds ?? [],
        introducedAt,
        learnedAt: existing?.learnedAt ?? completedAt,
        createdAt: existing?.createdAt ?? introducedAt,
        updatedAt: Math.max(existing?.updatedAt ?? 0, blueprint.generatedAt),
      });
    }
  }
  for (const state of states) {
    const key = `${state.stageId}\u0000${state.conceptId}`;
    const existing = records.get(key);
    records.set(key, {
      stageId: state.stageId,
      conceptId: state.conceptId,
      label: existing?.label ?? state.label,
      summary: existing?.summary ?? state.label,
      origin: existing?.origin ?? 'lesson',
      sourceSceneIds: existing?.sourceSceneIds ?? [],
      introducedAt: Math.min(existing?.introducedAt ?? state.learnedAt, state.learnedAt),
      learnedAt: Math.min(existing?.learnedAt ?? state.learnedAt, state.learnedAt),
      createdAt: existing?.createdAt ?? state.createdAt,
      updatedAt: Math.max(existing?.updatedAt ?? 0, state.updatedAt),
    });
  }
  if (records.size > 0) await transaction.table('lessonConcepts').bulkPut([...records.values()]);
}

export const revisitDb = new RevisitDatabase();
const demoDatabases = new Map<string, RevisitDatabase>();
const clearedDemoSessionIds = new Set<string>();

export function getRevisitDatabase(
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
): RevisitDatabase {
  if (scope.kind === 'formal') return revisitDb;
  if (clearedDemoSessionIds.has(scope.sessionId)) {
    throw new Error('This Demo session has been cleared.');
  }
  let database = demoDatabases.get(scope.sessionId);
  if (!database) {
    database = new RevisitDatabase(`${REVISIT_DEMO_DATABASE_PREFIX}${scope.sessionId}`);
    demoDatabases.set(scope.sessionId, database);
  }
  return database;
}

export async function createRevisitDemoSession(args: {
  id: string;
  createdAt?: number;
}): Promise<RevisitDemoSession> {
  const existing = await revisitDb.revisitDemoSessions.get(args.id);
  if (existing) return existing;
  clearedDemoSessionIds.delete(args.id);
  const createdAt = args.createdAt ?? Date.now();
  const databaseName = `${REVISIT_DEMO_DATABASE_PREFIX}${args.id}`;
  const destination = getRevisitDatabase({ kind: 'demo', sessionId: args.id });
  await Promise.all([revisitDb.open(), destination.open()]);
  const snapshots = await Promise.all(
    CLONED_TABLE_NAMES.map(async (name) => [name, await revisitDb.table(name).toArray()] as const),
  );
  await destination.transaction(
    'rw',
    CLONED_TABLE_NAMES.map((name) => destination.table(name)),
    async () => {
      for (const [name, records] of snapshots) {
        if (records.length > 0) await destination.table(name).bulkPut(records);
      }
    },
  );
  const session: RevisitDemoSession = {
    id: args.id,
    databaseName,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    offsetHours: 0,
  };
  await revisitDb.revisitDemoSessions.put(session);
  return session;
}

export async function updateRevisitDemoSessionClock(
  id: string,
  offsetHours: number,
  updatedAt = Date.now(),
): Promise<RevisitDemoSession> {
  return revisitDb.transaction('rw', revisitDb.revisitDemoSessions, async () => {
    const existing = await revisitDb.revisitDemoSessions.get(id);
    if (!existing || existing.status !== 'active') throw new Error('Demo session is unavailable.');
    const nextOffset = Math.max(existing.offsetHours, Math.min(168, Math.round(offsetHours)));
    const next = { ...existing, offsetHours: nextOffset, updatedAt };
    await revisitDb.revisitDemoSessions.put(next);
    return next;
  });
}

export async function archiveRevisitDemoSession(
  id: string,
  args: { offsetHours: number; simulatedAt: number; archivedAt?: number },
): Promise<RevisitDemoSession> {
  return revisitDb.transaction('rw', revisitDb.revisitDemoSessions, async () => {
    const existing = await revisitDb.revisitDemoSessions.get(id);
    if (!existing) throw new Error('Demo session is unavailable.');
    const archivedAt = args.archivedAt ?? Date.now();
    const next: RevisitDemoSession = {
      ...existing,
      status: 'archived',
      offsetHours: Math.max(existing.offsetHours, Math.min(168, Math.round(args.offsetHours))),
      simulatedAt: args.simulatedAt,
      archivedAt,
      updatedAt: archivedAt,
    };
    await revisitDb.revisitDemoSessions.put(next);
    return next;
  });
}

export async function listRevisitDemoSessions(): Promise<RevisitDemoSession[]> {
  return (await revisitDb.revisitDemoSessions.toArray()).sort((a, b) => b.createdAt - a.createdAt);
}

export interface RevisitDemoSessionContents {
  session: RevisitDemoSession;
  attempts: RevisitAttempt[];
  reports: RevisitJudgeReport[];
  artifacts: StudyArtifact[];
  practice: StudyPracticeState[];
  practiceCount: number;
}

export async function listRevisitDemoSessionContents(): Promise<RevisitDemoSessionContents[]> {
  const sessions = await listRevisitDemoSessions();
  return Promise.all(
    sessions.map(async (session) => {
      const db = getRevisitDatabase({ kind: 'demo', sessionId: session.id });
      const [attempts, reports, artifacts, practice] = await Promise.all([
        db.revisitAttempts.toArray(),
        db.revisitReports.toArray(),
        db.studyArtifacts.toArray(),
        db.studyPractice.toArray(),
      ]);
      return {
        session,
        attempts: attempts.sort((a, b) => b.createdAt - a.createdAt),
        reports: reports.sort((a, b) => b.completedAt - a.completedAt),
        artifacts: artifacts.sort((a, b) => b.updatedAt - a.updatedAt),
        practice: practice.sort((a, b) => b.updatedAt - a.updatedAt),
        practiceCount: practice.length,
      };
    }),
  );
}

export async function clearAllRevisitDemoData(): Promise<void> {
  const sessions = await revisitDb.revisitDemoSessions.toArray();
  for (const session of sessions) {
    clearedDemoSessionIds.add(session.id);
    const db = demoDatabases.get(session.id);
    db?.close();
    await Dexie.delete(session.databaseName);
    demoDatabases.delete(session.id);
  }
  await revisitDb.revisitDemoSessions.clear();
}

export async function getLatestExamBlueprint(stageId: string, scope = FORMAL_REVISIT_SCOPE) {
  const db = getRevisitDatabase(scope);
  const records = await db.examBlueprints.where('stageId').equals(stageId).toArray();
  return records.sort((a, b) => b.generatedAt - a.generatedAt)[0];
}

export async function saveExamBlueprint(
  blueprint: RevisitExamBlueprint,
  scope = FORMAL_REVISIT_SCOPE,
): Promise<void> {
  const db = getRevisitDatabase(scope);
  await db.transaction(
    'rw',
    [db.examBlueprints, db.lessonConcepts, db.lessonProgress],
    async () => {
      await db.examBlueprints.put(blueprint);
      const progress = await db.lessonProgress.get(blueprint.stageId);
      for (const concept of blueprint.concepts) {
        const key = [blueprint.stageId, concept.id] as [string, string];
        const existing = await db.lessonConcepts.get(key);
        const introducedAt =
          existing?.introducedAt ?? progress?.completedAt ?? blueprint.generatedAt;
        await db.lessonConcepts.put({
          stageId: blueprint.stageId,
          conceptId: concept.id,
          label: concept.label,
          summary: concept.summary,
          origin: existing?.origin ?? 'lesson',
          sourceSceneIds: existing?.sourceSceneIds ?? [],
          introducedAt,
          learnedAt: existing?.learnedAt ?? progress?.completedAt,
          createdAt: existing?.createdAt ?? introducedAt,
          updatedAt: Math.max(existing?.updatedAt ?? 0, blueprint.generatedAt),
        });
      }
    },
  );
}

export async function listLessonConcepts(
  stageId: string,
  scope = FORMAL_REVISIT_SCOPE,
): Promise<LessonConcept[]> {
  const records = await getRevisitDatabase(scope)
    .lessonConcepts.where('stageId')
    .equals(stageId)
    .toArray();
  return records.sort((a, b) => a.introducedAt - b.introducedAt || a.label.localeCompare(b.label));
}

export async function upsertLessonConcepts(
  concepts: LessonConcept[],
  scope = FORMAL_REVISIT_SCOPE,
): Promise<void> {
  const db = getRevisitDatabase(scope);
  await db.transaction('rw', db.lessonConcepts, async () => {
    for (const concept of concepts) {
      const key = [concept.stageId, concept.conceptId] as [string, string];
      const existing = await db.lessonConcepts.get(key);
      await db.lessonConcepts.put({
        ...concept,
        sourceSceneIds: Array.from(
          new Set([...(existing?.sourceSceneIds ?? []), ...concept.sourceSceneIds]),
        ),
        introducedAt: Math.min(
          existing?.introducedAt ?? concept.introducedAt,
          concept.introducedAt,
        ),
        learnedAt:
          existing?.learnedAt === undefined
            ? concept.learnedAt
            : concept.learnedAt === undefined
              ? existing.learnedAt
              : Math.min(existing.learnedAt, concept.learnedAt),
        createdAt: Math.min(existing?.createdAt ?? concept.createdAt, concept.createdAt),
        updatedAt: Math.max(existing?.updatedAt ?? 0, concept.updatedAt),
        origin: existing?.origin ?? concept.origin,
      });
    }
  });
}

export async function markLessonConceptsLearned(
  stageId: string,
  conceptIds: string[],
  learnedAt = Date.now(),
  scope = FORMAL_REVISIT_SCOPE,
): Promise<void> {
  const db = getRevisitDatabase(scope);
  await db.transaction('rw', db.lessonConcepts, async () => {
    for (const conceptId of new Set(conceptIds)) {
      const key = [stageId, conceptId] as [string, string];
      const existing = await db.lessonConcepts.get(key);
      if (!existing || existing.learnedAt !== undefined) continue;
      await db.lessonConcepts.put({ ...existing, learnedAt, updatedAt: learnedAt });
    }
  });
}

export async function getPendingAssessmentConcepts(
  stageId: string,
  scope = FORMAL_REVISIT_SCOPE,
): Promise<LessonConcept[]> {
  const db = getRevisitDatabase(scope);
  const [concepts, states] = await Promise.all([
    listLessonConcepts(stageId, scope),
    db.userConceptState.where('stageId').equals(stageId).toArray(),
  ]);
  const assessedIds = new Set(
    states.filter((state) => state.evidenceCount > 0).map((state) => state.conceptId),
  );
  return concepts.filter(
    (concept) => Number.isFinite(concept.learnedAt) && !assessedIds.has(concept.conceptId),
  );
}

export async function listStudyArtifacts(
  stageId: string,
  kind?: StudyArtifact['kind'],
  scope = FORMAL_REVISIT_SCOPE,
): Promise<StudyArtifact[]> {
  const db = getRevisitDatabase(scope);
  const records = kind
    ? await db.studyArtifacts.where('[stageId+kind]').equals([stageId, kind]).toArray()
    : await db.studyArtifacts.where('stageId').equals(stageId).toArray();
  return records.sort((a, b) => b.version - a.version || b.updatedAt - a.updatedAt);
}

export async function getStudyArtifact(id: string, scope = FORMAL_REVISIT_SCOPE) {
  return getRevisitDatabase(scope).studyArtifacts.get(id);
}

export async function saveStudyArtifactNewVersion(
  artifact: StudyArtifactDraft | StudyArtifact,
  scope = FORMAL_REVISIT_SCOPE,
  now = Date.now(),
): Promise<StudyArtifact> {
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.studyArtifacts, async () => {
    const siblings = await db.studyArtifacts
      .where('[stageId+kind]')
      .equals([artifact.stageId, artifact.kind])
      .toArray();
    const version = siblings.reduce((max, item) => Math.max(max, item.version), 0) + 1;
    const next: StudyArtifact = {
      ...artifact,
      id: createStudyArtifactVersionId(artifact.stageId, artifact.kind, version),
      version,
      createdAt: now,
      updatedAt: now,
    } as StudyArtifact;
    await db.studyArtifacts.put(next);
    return next;
  });
}

export async function renameStudyArtifact(
  id: string,
  title: string,
  scope = FORMAL_REVISIT_SCOPE,
  now = Date.now(),
) {
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.studyArtifacts, async () => {
    const existing = await db.studyArtifacts.get(id);
    if (!existing) return undefined;
    const renamed = { ...existing, title, updatedAt: now };
    await db.studyArtifacts.put(renamed);
    return renamed;
  });
}

export async function deleteStudyArtifact(id: string, scope = FORMAL_REVISIT_SCOPE): Promise<void> {
  const db = getRevisitDatabase(scope);
  await db.transaction('rw', [db.studyArtifacts, db.studyPractice], async () => {
    await db.studyArtifacts.delete(id);
    await db.studyPractice.delete(id);
  });
}

export async function getStudyPractice(artifactId: string, scope = FORMAL_REVISIT_SCOPE) {
  return getRevisitDatabase(scope).studyPractice.get(artifactId);
}

export async function saveStudyPractice(
  practice: StudyPracticeState,
  scope = FORMAL_REVISIT_SCOPE,
): Promise<void> {
  await getRevisitDatabase(scope).studyPractice.put(practice);
}

export async function getLessonProgress(stageId: string, scope = FORMAL_REVISIT_SCOPE) {
  return getRevisitDatabase(scope).lessonProgress.get(stageId);
}

export function mergeLessonCompletionProgress(
  existing: LessonProgress | undefined,
  stageId: string,
  completedAt: number,
  updatedAt: number,
): LessonProgress {
  return {
    stageId,
    completedAt: existing?.completedAt ?? completedAt,
    updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt),
  };
}

export async function recordLessonCompleted(
  stageId: string,
  completedAt = Date.now(),
  scope = FORMAL_REVISIT_SCOPE,
): Promise<LessonProgress> {
  const db = getRevisitDatabase(scope);
  return db.transaction('rw', db.lessonProgress, async () => {
    const existing = await db.lessonProgress.get(stageId);
    const next = mergeLessonCompletionProgress(existing, stageId, completedAt, completedAt);
    await db.lessonProgress.put(next);
    return next;
  });
}

export async function getLatestRevisitReport(stageId: string, scope = FORMAL_REVISIT_SCOPE) {
  const records = await getRevisitDatabase(scope)
    .revisitReports.where('stageId')
    .equals(stageId)
    .toArray();
  return records.sort((a, b) => b.completedAt - a.completedAt)[0];
}

export async function getRevisitReport(attemptId: string, scope = FORMAL_REVISIT_SCOPE) {
  return getRevisitDatabase(scope).revisitReports.get(attemptId);
}

export async function listRevisitReports(stageId: string, scope = FORMAL_REVISIT_SCOPE) {
  const reports = await getRevisitDatabase(scope)
    .revisitReports.where('stageId')
    .equals(stageId)
    .toArray();
  return reports.sort((a, b) => b.completedAt - a.completedAt);
}

export async function countRevisitReports(stageId: string, scope = FORMAL_REVISIT_SCOPE) {
  return getRevisitDatabase(scope).revisitReports.where('stageId').equals(stageId).count();
}

export async function getConceptStates(stageId: string, scope = FORMAL_REVISIT_SCOPE) {
  const states = await getRevisitDatabase(scope)
    .userConceptState.where('stageId')
    .equals(stageId)
    .toArray();
  return filterJudgedConceptStates(states);
}

export async function saveEvidenceAndUpdateState(
  report: RevisitJudgeReport,
  options: {
    stableSuccessesRequired?: number;
    conceptLabelsById?: Record<string, string>;
    signal?: AbortSignal;
    scope?: RevisitDataScope;
  } = {},
): Promise<void> {
  const db = getRevisitDatabase(options.scope);
  await db.transaction(
    'rw',
    [
      db.conceptEvidence,
      db.userConceptState,
      db.revisitReports,
      db.lessonProgress,
      db.revisitAttempts,
      db.lessonConcepts,
    ],
    async () => {
      throwIfAborted(options.signal);
      if (await db.revisitReports.get(report.attemptId)) return;
      const lessonProgress = await db.lessonProgress.get(report.stageId);
      if (!lessonProgress) {
        throw new Error('Cannot save Reverse Challenge evidence before lesson completion.');
      }
      await db.revisitReports.put(report);
      if (report.evidence.length > 0) await db.conceptEvidence.bulkPut(report.evidence);
      for (const evidence of report.evidence) {
        throwIfAborted(options.signal);
        const key = [evidence.stageId, evidence.conceptId] as [string, string];
        const existing = await db.userConceptState.get(key);
        const lessonConcept = await db.lessonConcepts.get(key);
        const base =
          existing && existing.evidenceCount > 0
            ? existing
            : createConceptStateFromEvidence(evidence, {
                label: options.conceptLabelsById?.[evidence.conceptId],
                learnedAt: lessonConcept?.learnedAt ?? lessonProgress.completedAt,
              });
        await db.userConceptState.put(
          applyEvidenceToConceptState(base, evidence, {
            now: evidence.timestamp,
            stableSuccessesRequired:
              options.stableSuccessesRequired ?? DEFAULT_STABLE_SUCCESSES_REQUIRED,
          }),
        );
      }
      const attempt = await db.revisitAttempts.get(report.attemptId);
      if (attempt) {
        await db.revisitAttempts.put({
          ...attempt,
          status: 'completed',
          completedAt: report.completedAt,
          updatedAt: report.completedAt,
          preparationError: undefined,
        });
      }
    },
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export async function deleteRevisitStageData(
  stageId: string,
  scope = FORMAL_REVISIT_SCOPE,
): Promise<void> {
  const db = getRevisitDatabase(scope);
  await db.transaction(
    'rw',
    CLONED_TABLE_NAMES.map((name) => db.table(name)),
    async () => {
      await db.userConceptState.where('stageId').equals(stageId).delete();
      await db.conceptEvidence.where('stageId').equals(stageId).delete();
      await db.examBlueprints.where('stageId').equals(stageId).delete();
      await db.revisitReports.where('stageId').equals(stageId).delete();
      await db.lessonProgress.delete(stageId);
      await db.studyMaterials.where('stageId').equals(stageId).delete();
      await db.studyArtifacts.where('stageId').equals(stageId).delete();
      await db.studyPractice.where('stageId').equals(stageId).delete();
      await db.revisitAttempts.where('stageId').equals(stageId).delete();
      await db.lessonConcepts.where('stageId').equals(stageId).delete();
    },
  );
}

export async function clearRevisitDatabase(): Promise<void> {
  if (revisitDb.isOpen()) {
    try {
      await clearAllRevisitDemoData();
    } catch {
      // A partially-created test database may not have the registry table yet.
    }
  }
  for (const database of demoDatabases.values()) database.close();
  demoDatabases.clear();
  clearedDemoSessionIds.clear();
  revisitDb.close();
  await Dexie.delete(REVISIT_DATABASE_NAME);
  await revisitDb.open();
}
