import 'server-only';

import type { Queryable } from '@openmaic/storage/document/pg';

import { createStudyArtifactVersionId } from '@/lib/revisit/artifact-ids';
import {
  applyEvidenceToConceptState,
  createConceptStateFromEvidence,
  DEFAULT_STABLE_SUCCESSES_REQUIRED,
  filterJudgedConceptStates,
} from '@/lib/revisit/memory';
import {
  assertRevisitOwner,
  getRevisitRecord,
  importLegacyRevisitRecords,
  listRevisitRecords,
  putRevisitRecord,
  upsertRevisitLessonConceptsForStage,
  type RevisitRecordKind,
} from '@/lib/revisit/server-store';
import type {
  LessonConcept,
  LessonProgress,
  RevisitAttempt,
  RevisitExamBlueprint,
  RevisitJudgeReport,
  StudyArtifact,
  StudyArtifactDraft,
  StudyPracticeState,
  UserConceptState,
} from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

async function byId<T>(
  tx: Queryable,
  ownerId: string,
  kind: RevisitRecordKind,
  id: string,
): Promise<T | undefined> {
  const result = await tx.query<{ stage_id: string; body: T } & Record<string, unknown>>(
    `SELECT stage_id, body FROM revisit_records
      WHERE owner_id = $1 AND kind = $2 AND record_id = $3 LIMIT 1`,
    [ownerId, kind, id],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  await assertRevisitOwner(tx, ownerId, row.stage_id);
  return row.body;
}

async function deleteById(
  tx: Queryable,
  ownerId: string,
  kind: RevisitRecordKind,
  id: string,
): Promise<void> {
  const result = await tx.query<{ stage_id: string } & Record<string, unknown>>(
    `SELECT stage_id FROM revisit_records
      WHERE owner_id = $1 AND kind = $2 AND record_id = $3 LIMIT 1`,
    [ownerId, kind, id],
  );
  const stageId = result.rows[0]?.stage_id;
  if (!stageId) return;
  await assertRevisitOwner(tx, ownerId, stageId);
  await tx.query(
    `DELETE FROM revisit_records
      WHERE owner_id = $1 AND stage_id = $2 AND kind = $3 AND record_id = $4`,
    [ownerId, stageId, kind, id],
  );
}

async function lockStage(tx: Queryable, ownerId: string, stageId: string): Promise<void> {
  const result = await tx.query<{ owner_id: string } & Record<string, unknown>>(
    `SELECT owner_id FROM stage_meta
      WHERE stage_id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [stageId],
  );
  if (result.rows[0]?.owner_id !== ownerId) await assertRevisitOwner(tx, ownerId, stageId);
}

async function requireAttempt(
  tx: Queryable,
  ownerId: string,
  attemptId: string,
): Promise<RevisitAttempt> {
  const attempt = await byId<RevisitAttempt>(tx, ownerId, 'revisitAttempts', attemptId);
  if (!attempt) throw new Error(`Could not persist revisit attempt: ${attemptId} was not found`);
  return attempt;
}

async function saveAttempt(
  tx: Queryable,
  ownerId: string,
  attempt: RevisitAttempt,
): Promise<RevisitAttempt> {
  await putRevisitRecord(
    tx,
    ownerId,
    attempt.stageId,
    'revisitAttempts',
    attempt.attemptId,
    attempt,
  );
  return attempt;
}

function sortBy<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  return items.sort(compare);
}

/** Runs one formal Revisit operation in the caller's PostgreSQL transaction. */
export async function runRevisitOperation(
  tx: Queryable,
  ownerId: string,
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const stageId = args.stageId as string;
  const attemptId = args.attemptId as string;
  const now = (args.now as number | undefined) ?? Date.now();
  switch (op) {
    case 'getLatestExamBlueprint': {
      const rows = await listRevisitRecords<RevisitExamBlueprint>(
        tx,
        ownerId,
        stageId,
        'examBlueprints',
      );
      return sortBy(rows, (a, b) => b.generatedAt - a.generatedAt)[0];
    }
    case 'saveExamBlueprint': {
      const blueprint = args.blueprint as RevisitExamBlueprint;
      await lockStage(tx, ownerId, blueprint.stageId);
      await putRevisitRecord(
        tx,
        ownerId,
        blueprint.stageId,
        'examBlueprints',
        blueprint.id,
        blueprint,
      );
      const progress = await getRevisitRecord<LessonProgress>(
        tx,
        ownerId,
        blueprint.stageId,
        'lessonProgress',
        blueprint.stageId,
      );
      for (const concept of blueprint.concepts) {
        const existing = await getRevisitRecord<LessonConcept>(
          tx,
          ownerId,
          blueprint.stageId,
          'lessonConcepts',
          concept.id,
        );
        const introducedAt =
          existing?.introducedAt ?? progress?.completedAt ?? blueprint.generatedAt;
        await putRevisitRecord(tx, ownerId, blueprint.stageId, 'lessonConcepts', concept.id, {
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
        } satisfies LessonConcept);
      }
      return null;
    }
    case 'listLessonConcepts': {
      const rows = await listRevisitRecords<LessonConcept>(tx, ownerId, stageId, 'lessonConcepts');
      return sortBy(
        rows,
        (a, b) => a.introducedAt - b.introducedAt || a.label.localeCompare(b.label),
      );
    }
    case 'upsertLessonConcepts': {
      const concepts = args.concepts as LessonConcept[];
      const groups = new Map<string, LessonConcept[]>();
      for (const concept of concepts) {
        const group = groups.get(concept.stageId) ?? [];
        group.push(concept);
        groups.set(concept.stageId, group);
      }
      for (const [id, group] of groups) {
        await lockStage(tx, ownerId, id);
        await upsertRevisitLessonConceptsForStage(tx, ownerId, id, group);
      }
      return null;
    }
    case 'markLessonConceptsLearned': {
      await lockStage(tx, ownerId, stageId);
      const learnedAt = args.learnedAt as number;
      for (const conceptId of new Set(args.conceptIds as string[])) {
        const existing = await getRevisitRecord<LessonConcept>(
          tx,
          ownerId,
          stageId,
          'lessonConcepts',
          conceptId,
        );
        if (existing && existing.learnedAt === undefined) {
          await putRevisitRecord(tx, ownerId, stageId, 'lessonConcepts', conceptId, {
            ...existing,
            learnedAt,
            updatedAt: learnedAt,
          });
        }
      }
      return null;
    }
    case 'getPendingAssessmentConcepts': {
      const concepts = await listRevisitRecords<LessonConcept>(
        tx,
        ownerId,
        stageId,
        'lessonConcepts',
      );
      const states = await listRevisitRecords<UserConceptState>(
        tx,
        ownerId,
        stageId,
        'userConceptState',
      );
      const assessed = new Set(
        states.filter((item) => item.evidenceCount > 0).map((item) => item.conceptId),
      );
      return sortBy(
        concepts.filter((item) => Number.isFinite(item.learnedAt) && !assessed.has(item.conceptId)),
        (a, b) => a.introducedAt - b.introducedAt || a.label.localeCompare(b.label),
      );
    }
    case 'listStudyArtifacts': {
      const rows = await listRevisitRecords<StudyArtifact>(tx, ownerId, stageId, 'studyArtifacts');
      return sortBy(
        rows.filter((item) => !args.kind || item.kind === args.kind),
        (a, b) => b.version - a.version || b.updatedAt - a.updatedAt,
      );
    }
    case 'getStudyArtifact':
      return byId<StudyArtifact>(tx, ownerId, 'studyArtifacts', args.id as string);
    case 'saveStudyArtifactNewVersion': {
      const artifact = args.artifact as StudyArtifactDraft | StudyArtifact;
      await lockStage(tx, ownerId, artifact.stageId);
      const siblings = await listRevisitRecords<StudyArtifact>(
        tx,
        ownerId,
        artifact.stageId,
        'studyArtifacts',
      );
      const version =
        siblings
          .filter((item) => item.kind === artifact.kind)
          .reduce((max, item) => Math.max(max, item.version), 0) + 1;
      const next = {
        ...artifact,
        id: createStudyArtifactVersionId(artifact.stageId, artifact.kind, version),
        version,
        createdAt: now,
        updatedAt: now,
      } as StudyArtifact;
      await putRevisitRecord(tx, ownerId, artifact.stageId, 'studyArtifacts', next.id, next);
      return next;
    }
    case 'renameStudyArtifact': {
      const existing = await byId<StudyArtifact>(tx, ownerId, 'studyArtifacts', args.id as string);
      if (!existing) return undefined;
      await lockStage(tx, ownerId, existing.stageId);
      const renamed = { ...existing, title: args.title as string, updatedAt: now };
      await putRevisitRecord(tx, ownerId, existing.stageId, 'studyArtifacts', existing.id, renamed);
      return renamed;
    }
    case 'deleteStudyArtifact': {
      const existing = await byId<StudyArtifact>(tx, ownerId, 'studyArtifacts', args.id as string);
      if (!existing) return null;
      await lockStage(tx, ownerId, existing.stageId);
      await deleteById(tx, ownerId, 'studyArtifacts', existing.id);
      await deleteById(tx, ownerId, 'studyPractice', existing.id);
      return null;
    }
    case 'getStudyPractice':
      return byId<StudyPracticeState>(tx, ownerId, 'studyPractice', args.artifactId as string);
    case 'saveStudyPractice': {
      const practice = args.practice as StudyPracticeState;
      await lockStage(tx, ownerId, practice.stageId);
      await putRevisitRecord(
        tx,
        ownerId,
        practice.stageId,
        'studyPractice',
        practice.artifactId,
        practice,
      );
      return null;
    }
    case 'getLessonProgress':
      return getRevisitRecord<LessonProgress>(tx, ownerId, stageId, 'lessonProgress', stageId);
    case 'recordLessonCompleted': {
      await lockStage(tx, ownerId, stageId);
      const completedAt = args.completedAt as number;
      const existing = await getRevisitRecord<LessonProgress>(
        tx,
        ownerId,
        stageId,
        'lessonProgress',
        stageId,
      );
      const next: LessonProgress = {
        stageId,
        completedAt: existing?.completedAt ?? completedAt,
        updatedAt: Math.max(existing?.updatedAt ?? 0, completedAt),
      };
      await putRevisitRecord(tx, ownerId, stageId, 'lessonProgress', stageId, next);
      return next;
    }
    case 'getLatestRevisitReport': {
      const rows = await listRevisitRecords<RevisitJudgeReport>(
        tx,
        ownerId,
        stageId,
        'revisitReports',
      );
      return sortBy(rows, (a, b) => b.completedAt - a.completedAt)[0];
    }
    case 'getRevisitReport':
      return byId<RevisitJudgeReport>(tx, ownerId, 'revisitReports', attemptId);
    case 'listRevisitReports': {
      const rows = await listRevisitRecords<RevisitJudgeReport>(
        tx,
        ownerId,
        stageId,
        'revisitReports',
      );
      return sortBy(rows, (a, b) => b.completedAt - a.completedAt);
    }
    case 'countRevisitReports':
      return (await listRevisitRecords(tx, ownerId, stageId, 'revisitReports')).length;
    case 'getConceptStates': {
      const rows = await listRevisitRecords<UserConceptState>(
        tx,
        ownerId,
        stageId,
        'userConceptState',
      );
      return filterJudgedConceptStates(rows);
    }
    case 'saveEvidenceAndUpdateState': {
      const report = args.report as RevisitJudgeReport;
      await lockStage(tx, ownerId, report.stageId);
      if (await getRevisitRecord(tx, ownerId, report.stageId, 'revisitReports', report.attemptId))
        return null;
      const progress = await getRevisitRecord<LessonProgress>(
        tx,
        ownerId,
        report.stageId,
        'lessonProgress',
        report.stageId,
      );
      if (!progress)
        throw new Error('Cannot save Reverse Challenge evidence before lesson completion.');
      const existingAttempt = await byId<RevisitAttempt>(
        tx,
        ownerId,
        'revisitAttempts',
        report.attemptId,
      );
      if (existingAttempt && existingAttempt.stageId !== report.stageId)
        throw new Error('Revisit attempt belongs to a different course.');
      for (const evidence of report.evidence) {
        if (evidence.stageId !== report.stageId || evidence.attemptId !== report.attemptId) {
          throw new Error('Revisit evidence belongs to a different attempt or course.');
        }
      }
      await putRevisitRecord(
        tx,
        ownerId,
        report.stageId,
        'revisitReports',
        report.attemptId,
        report,
      );
      for (const evidence of report.evidence) {
        await putRevisitRecord(
          tx,
          ownerId,
          report.stageId,
          'conceptEvidence',
          evidence.id,
          evidence,
        );
        const existing = await getRevisitRecord<UserConceptState>(
          tx,
          ownerId,
          report.stageId,
          'userConceptState',
          evidence.conceptId,
        );
        const lessonConcept = await getRevisitRecord<LessonConcept>(
          tx,
          ownerId,
          report.stageId,
          'lessonConcepts',
          evidence.conceptId,
        );
        const base =
          existing && existing.evidenceCount > 0
            ? existing
            : createConceptStateFromEvidence(evidence, {
                label: (args.conceptLabelsById as Record<string, string> | undefined)?.[
                  evidence.conceptId
                ],
                learnedAt: lessonConcept?.learnedAt ?? progress.completedAt,
              });
        const next = applyEvidenceToConceptState(base, evidence, {
          now: evidence.timestamp,
          stableSuccessesRequired:
            (args.stableSuccessesRequired as number | undefined) ??
            DEFAULT_STABLE_SUCCESSES_REQUIRED,
        });
        await putRevisitRecord(
          tx,
          ownerId,
          report.stageId,
          'userConceptState',
          evidence.conceptId,
          next,
        );
      }
      if (existingAttempt)
        await saveAttempt(tx, ownerId, {
          ...existingAttempt,
          status: 'completed',
          completedAt: report.completedAt,
          updatedAt: report.completedAt,
          preparationError: undefined,
        });
      return null;
    }
    case 'deleteRevisitStageData': {
      await lockStage(tx, ownerId, stageId);
      await tx.query('DELETE FROM revisit_records WHERE owner_id = $1 AND stage_id = $2', [
        ownerId,
        stageId,
      ]);
      return null;
    }
    case 'snapshotStage': {
      const kinds: RevisitRecordKind[] = [
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
      ];
      const rows = [];
      for (const kind of kinds) {
        rows.push([kind, await listRevisitRecords(tx, ownerId, stageId, kind)] as const);
      }
      return Object.fromEntries(rows);
    }
    case 'createOrGetRevisitAttempt': {
      const stage = args.stage as Stage;
      await lockStage(tx, ownerId, stage.id);
      const prior = await byId<RevisitAttempt>(tx, ownerId, 'revisitAttempts', attemptId);
      if (prior) {
        if (prior.stageId !== stage.id)
          throw new Error('Revisit attempt belongs to a different course.');
        return prior;
      }
      const attempts = await listRevisitRecords<RevisitAttempt>(
        tx,
        ownerId,
        stage.id,
        'revisitAttempts',
      );
      const unfinished = sortBy(attempts, (a, b) => a.sequence - b.sequence).find(
        (attempt) => attempt.status !== 'completed',
      );
      if (unfinished) return unfinished;
      const next: RevisitAttempt = {
        attemptId,
        stageId: stage.id,
        sequence: attempts.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
        status: 'preparing',
        sourceStage: structuredClone(stage),
        sourceScenes: structuredClone(args.sourceScenes as Scene[]),
        scenes: [],
        createdAt: now,
        updatedAt: now,
      };
      return saveAttempt(tx, ownerId, next);
    }
    case 'getRevisitAttempt':
      return byId<RevisitAttempt>(tx, ownerId, 'revisitAttempts', attemptId);
    case 'listRevisitAttempts': {
      const rows = await listRevisitRecords<RevisitAttempt>(
        tx,
        ownerId,
        stageId,
        'revisitAttempts',
      );
      return sortBy(rows, (a, b) => b.sequence - a.sequence);
    }
    case 'saveRevisitAttemptBlueprint': {
      const existing = await requireAttempt(tx, ownerId, attemptId);
      await lockStage(tx, ownerId, existing.stageId);
      const blueprint = args.blueprint as RevisitExamBlueprint;
      if (blueprint.stageId !== existing.stageId)
        throw new Error('Blueprint belongs to a different course.');
      const scenes =
        existing.scenes.length >= blueprint.skeleton.pages.length
          ? [...existing.scenes]
          : Array<Scene | null>(blueprint.skeleton.pages.length).fill(null);
      return saveAttempt(tx, ownerId, {
        ...existing,
        blueprint,
        scenes,
        updatedAt: now,
        preparationError: undefined,
      });
    }
    case 'saveRevisitAttemptSource': {
      const existing = await requireAttempt(tx, ownerId, attemptId);
      await lockStage(tx, ownerId, existing.stageId);
      const sourceStage = args.sourceStage as Stage;
      if (sourceStage.id !== existing.stageId)
        throw new Error('Source belongs to a different course.');
      return saveAttempt(tx, ownerId, {
        ...existing,
        sourceStage: structuredClone(sourceStage),
        sourceScenes: structuredClone(args.sourceScenes as Scene[]),
        updatedAt: now,
      });
    }
    case 'setRevisitAttemptSpiralAgentGenerationState': {
      const existing = await requireAttempt(tx, ownerId, attemptId);
      await lockStage(tx, ownerId, existing.stageId);
      return saveAttempt(tx, ownerId, {
        ...existing,
        spiralAgentGenerationState: args.state as RevisitAttempt['spiralAgentGenerationState'],
        updatedAt: now,
      });
    }
    case 'upsertRevisitAttemptScene': {
      const existing = await requireAttempt(tx, ownerId, attemptId);
      await lockStage(tx, ownerId, existing.stageId);
      if (!existing.blueprint) throw new Error('Could not persist revisit scene before blueprint.');
      const scenes =
        existing.scenes.length >= existing.blueprint.skeleton.pages.length
          ? [...existing.scenes]
          : Array<Scene | null>(existing.blueprint.skeleton.pages.length).fill(null);
      const index = args.index as number;
      if (!Number.isInteger(index) || index < 0 || index >= scenes.length)
        throw new Error('Invalid revisit scene index.');
      scenes[index] = args.scene as Scene;
      return saveAttempt(tx, ownerId, {
        ...existing,
        scenes,
        status: existing.status === 'completed' ? 'completed' : scenes[0] ? 'ready' : 'preparing',
        updatedAt: now,
        preparationError: undefined,
      });
    }
    case 'setRevisitAttemptPreparationError': {
      const existing = await requireAttempt(tx, ownerId, attemptId);
      await lockStage(tx, ownerId, existing.stageId);
      await saveAttempt(tx, ownerId, {
        ...existing,
        preparationError: args.error as string,
        updatedAt: now,
      });
      return null;
    }
    case 'markRevisitAttemptCompleted': {
      const existing = await requireAttempt(tx, ownerId, attemptId);
      await lockStage(tx, ownerId, existing.stageId);
      if (existing.status === 'completed') return existing;
      const completedAt = args.completedAt as number;
      return saveAttempt(tx, ownerId, {
        ...existing,
        status: 'completed',
        completedAt,
        updatedAt: completedAt,
        preparationError: undefined,
      });
    }
    case 'importLegacyAttemptSnapshot': {
      const incoming = args.attempt as RevisitAttempt;
      await lockStage(tx, ownerId, incoming.stageId);
      const prior = await byId<RevisitAttempt>(tx, ownerId, 'revisitAttempts', incoming.attemptId);
      if (prior) return prior;
      const attempts = await listRevisitRecords<RevisitAttempt>(
        tx,
        ownerId,
        incoming.stageId,
        'revisitAttempts',
      );
      const sequence = attempts.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
      return saveAttempt(tx, ownerId, {
        attemptId: incoming.attemptId,
        stageId: incoming.stageId,
        sequence,
        status: incoming.scenes[0] ? 'ready' : 'preparing',
        sourceScenes: [],
        blueprint: incoming.blueprint,
        scenes: incoming.scenes,
        createdAt: incoming.createdAt,
        updatedAt: incoming.updatedAt,
        reportOnly: false,
      });
    }
    case 'importLegacy':
      await lockStage(tx, ownerId, stageId);
      return importLegacyRevisitRecords(
        tx,
        ownerId,
        args.sourceStageId as string,
        stageId,
        args.rows as Parameters<typeof importLegacyRevisitRecords>[4],
      );
    default:
      throw new Error(`Unknown Revisit operation: ${op}`);
  }
}
