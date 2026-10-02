import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runRevisitOperation } from '@/lib/revisit/server-operations';
import { ensureRevisitSchema, listRevisitRecords } from '@/lib/revisit/server-store';
import type { RevisitJudgeReport, UserConceptState } from '@/lib/revisit/types';

const url = process.env.PG_CONTRACT_URL;
const schema = 'spiral_revisit_server_test';
const ownerId = 'anon:11111111-1111-4111-8111-111111111111';
const stageId = 'stage-1';
const report: RevisitJudgeReport = {
  attemptId: 'attempt-1',
  stageId,
  completedAt: 30,
  summary: 'Complete',
  dimensions: { clarity: 1, doubtResolution: 1, transfer: 1, errorCorrection: 1 },
  qRaw: 0.9,
  q: 0.9,
  errors: [],
  evidence: [
    {
      id: 'evidence-1',
      attemptId: 'attempt-1',
      stageId,
      conceptId: 'concept-1',
      source: 'teach_back',
      scores: { clarity: 1, doubtResolution: 1, transfer: 1, errorCorrection: 1 },
      q: 0.9,
      qRaw: 0.9,
      polarity: 'positive',
      timestamp: 30,
      errors: [],
    },
  ],
  pageReports: [],
};

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!url)('formal Revisit on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query('CREATE TABLE document_stages (id TEXT PRIMARY KEY)');
    await pool.query(
      'CREATE TABLE stage_meta (stage_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, deleted_at TIMESTAMPTZ)',
    );
    await ensureRevisitSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE revisit_records, stage_meta, document_stages CASCADE');
    await pool.query('INSERT INTO document_stages (id) VALUES ($1)', [stageId]);
    await pool.query('INSERT INTO stage_meta (stage_id, owner_id) VALUES ($1, $2)', [
      stageId,
      ownerId,
    ]);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('rolls back the report, evidence, and memory state together; retries are idempotent', async () => {
    await inTransaction(pool, (tx) =>
      runRevisitOperation(tx, ownerId, 'recordLessonCompleted', { stageId, completedAt: 10 }),
    );

    await expect(
      inTransaction(pool, async (tx) => {
        await runRevisitOperation(tx, ownerId, 'saveEvidenceAndUpdateState', { report });
        throw new Error('simulate transaction failure');
      }),
    ).rejects.toThrow('simulate transaction failure');
    expect(await listRevisitRecords(pool, ownerId, stageId, 'revisitReports')).toHaveLength(0);
    expect(await listRevisitRecords(pool, ownerId, stageId, 'conceptEvidence')).toHaveLength(0);
    expect(await listRevisitRecords(pool, ownerId, stageId, 'userConceptState')).toHaveLength(0);

    for (let retry = 0; retry < 2; retry++) {
      await inTransaction(pool, (tx) =>
        runRevisitOperation(tx, ownerId, 'saveEvidenceAndUpdateState', { report }),
      );
    }
    expect(await listRevisitRecords(pool, ownerId, stageId, 'revisitReports')).toHaveLength(1);
    expect(await listRevisitRecords(pool, ownerId, stageId, 'conceptEvidence')).toHaveLength(1);
    expect(
      (await listRevisitRecords<UserConceptState>(pool, ownerId, stageId, 'userConceptState'))[0]
        ?.evidenceCount,
    ).toBe(1);
  });

  it('refuses another owner and cascades formal records with the course', async () => {
    await inTransaction(pool, (tx) =>
      runRevisitOperation(tx, ownerId, 'recordLessonCompleted', { stageId, completedAt: 10 }),
    );
    await expect(
      inTransaction(pool, (tx) =>
        runRevisitOperation(
          tx,
          'anon:22222222-2222-4222-8222-222222222222',
          'recordLessonCompleted',
          {
            stageId,
            completedAt: 20,
          },
        ),
      ),
    ).rejects.toThrow();
    await pool.query('DELETE FROM document_stages WHERE id = $1', [stageId]);
    const rows = await pool.query('SELECT * FROM revisit_records');
    expect(rows.rowCount).toBe(0);
  });
});
