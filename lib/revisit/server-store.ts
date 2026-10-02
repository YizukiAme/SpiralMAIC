import 'server-only';

import type { Queryable } from '@openmaic/storage/document/pg';

import type { LessonConcept } from '@/lib/revisit/types';

export type RevisitRecordKind =
  | 'lessonConcepts'
  | 'lessonProgress'
  | 'examBlueprints'
  | 'studyArtifacts'
  | 'studyPractice'
  | 'revisitAttempts'
  | 'revisitReports'
  | 'conceptEvidence'
  | 'userConceptState'
  | 'studyMaterials';

const REVISIT_RECORD_KINDS: ReadonlySet<string> = new Set<RevisitRecordKind>([
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
]);

const REVISIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS revisit_records (
  owner_id TEXT NOT NULL,
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  body JSONB NOT NULL,
  PRIMARY KEY (owner_id, stage_id, kind, record_id)
);
CREATE INDEX IF NOT EXISTS revisit_records_owner_kind_id_idx
  ON revisit_records (owner_id, kind, record_id);
`;

export async function ensureRevisitSchema(queryable: Queryable): Promise<void> {
  for (const sql of REVISIT_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement) await queryable.query(statement);
  }
}

export class RevisitAccessError extends Error {
  constructor(stageId: string) {
    super(`Revisit access refused for ${JSON.stringify(stageId)}`);
    this.name = 'RevisitAccessError';
  }
}

export async function assertRevisitOwner(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
): Promise<void> {
  const result = await queryable.query<{ owner_id: string } & Record<string, unknown>>(
    `SELECT owner_id FROM stage_meta WHERE stage_id = $1 AND deleted_at IS NULL`,
    [stageId],
  );
  if (result.rows[0]?.owner_id !== ownerId) throw new RevisitAccessError(stageId);
}

export async function listRevisitRecords<T>(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
  kind: RevisitRecordKind,
): Promise<T[]> {
  await assertRevisitOwner(queryable, ownerId, stageId);
  const result = await queryable.query<{ body: T } & Record<string, unknown>>(
    `SELECT body FROM revisit_records
      WHERE owner_id = $1 AND stage_id = $2 AND kind = $3`,
    [ownerId, stageId, kind],
  );
  return result.rows.map((row) => row.body);
}

export async function getRevisitRecord<T>(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
  kind: RevisitRecordKind,
  recordId: string,
): Promise<T | undefined> {
  await assertRevisitOwner(queryable, ownerId, stageId);
  const result = await queryable.query<{ body: T } & Record<string, unknown>>(
    `SELECT body FROM revisit_records
      WHERE owner_id = $1 AND stage_id = $2 AND kind = $3 AND record_id = $4`,
    [ownerId, stageId, kind, recordId],
  );
  return result.rows[0]?.body;
}

export async function putRevisitRecord(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
  kind: RevisitRecordKind,
  recordId: string,
  body: unknown,
): Promise<void> {
  await assertRevisitOwner(queryable, ownerId, stageId);
  await queryable.query(
    `INSERT INTO revisit_records (owner_id, stage_id, kind, record_id, body)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (owner_id, stage_id, kind, record_id)
     DO UPDATE SET body = EXCLUDED.body`,
    [ownerId, stageId, kind, recordId, JSON.stringify(body)],
  );
}

export async function upsertRevisitLessonConceptsForStage(
  tx: Queryable,
  ownerId: string,
  stageId: string,
  concepts: LessonConcept[],
): Promise<void> {
  await assertRevisitOwner(tx, ownerId, stageId);
  for (const concept of concepts) {
    if (concept.stageId !== stageId) throw new RevisitAccessError(concept.stageId);
    const existing = await getRevisitRecord<LessonConcept>(
      tx,
      ownerId,
      stageId,
      'lessonConcepts',
      concept.conceptId,
    );
    await putRevisitRecord(tx, ownerId, stageId, 'lessonConcepts', concept.conceptId, {
      ...concept,
      sourceSceneIds: [
        ...new Set([...(existing?.sourceSceneIds ?? []), ...concept.sourceSceneIds]),
      ],
      introducedAt: Math.min(existing?.introducedAt ?? concept.introducedAt, concept.introducedAt),
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
}

export async function reassignRevisitOwner(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<number> {
  const result = await tx.query<{ count: string } & Record<string, unknown>>(
    `WITH moved AS (
       UPDATE revisit_records SET owner_id = $2 WHERE owner_id = $1 RETURNING 1
     ) SELECT COUNT(*)::text AS count FROM moved`,
    [fromOwnerId, toOwnerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Caller has already verified course ownership in its pinned delete transaction. */
export async function deleteRevisitForStage(tx: Queryable, stageId: string): Promise<void> {
  await tx.query('DELETE FROM revisit_records WHERE stage_id = $1', [stageId]);
}

export interface LegacyRevisitImportRow {
  kind: RevisitRecordKind;
  recordId: string;
  body: Record<string, unknown>;
}

export interface LegacyRevisitImportResult {
  insertedIds: string[];
  conflictingIds: string[];
}

function remapCourseIds(
  value: unknown,
  sourceStageId: string,
  stageId: string,
  parentKey = '',
): unknown {
  if (Array.isArray(value))
    return value.map((item) => remapCourseIds(item, sourceStageId, stageId, parentKey));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (key === 'stageId' || (key === 'id' && parentKey === 'sourceStage')) && item === sourceStageId
        ? stageId
        : remapCourseIds(item, sourceStageId, stageId, key),
    ]),
  );
}

/** Import old browser rows after the browser id was bound to this owner. Existing rows win. */
export async function importLegacyRevisitRecords(
  tx: Queryable,
  ownerId: string,
  sourceStageId: string,
  stageId: string,
  rows: LegacyRevisitImportRow[],
): Promise<LegacyRevisitImportResult> {
  await assertRevisitOwner(tx, ownerId, stageId);
  const insertedIds: string[] = [];
  const conflictingIds: string[] = [];
  for (const row of rows) {
    if (!REVISIT_RECORD_KINDS.has(row.kind)) {
      throw new Error(`Unknown legacy Revisit table: ${row.kind}`);
    }
    if (!row.body || row.body.stageId !== sourceStageId) {
      throw new Error('Legacy Revisit row does not belong to its source course.');
    }
    const recordId =
      row.kind === 'lessonProgress' && row.recordId === sourceStageId ? stageId : row.recordId;
    const body = remapCourseIds(row.body, sourceStageId, stageId);
    const payload = JSON.stringify(body);
    const key = `${row.kind}:${recordId}`;
    const inserted = await tx.query<{ record_id: string } & Record<string, unknown>>(
      `INSERT INTO revisit_records (owner_id, stage_id, kind, record_id, body)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (owner_id, stage_id, kind, record_id) DO NOTHING
       RETURNING record_id`,
      [ownerId, stageId, row.kind, recordId, payload],
    );
    if (inserted.rows.length > 0) {
      insertedIds.push(key);
      continue;
    }
    const existing = await tx.query<{ same: boolean } & Record<string, unknown>>(
      `SELECT body = $5::jsonb AS same FROM revisit_records
        WHERE owner_id = $1 AND stage_id = $2 AND kind = $3 AND record_id = $4`,
      [ownerId, stageId, row.kind, recordId, payload],
    );
    if (existing.rows[0]?.same !== true) conflictingIds.push(key);
  }
  return { insertedIds, conflictingIds };
}
