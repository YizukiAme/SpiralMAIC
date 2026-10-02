import { PGlite } from '@electric-sql/pglite';
import type { Queryable, QueryResult } from '@openmaic/storage/document/pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runRevisitOperation } from '@/lib/revisit/server-operations';
import { ensureRevisitSchema, listRevisitRecords } from '@/lib/revisit/server-store';
import type { RevisitAttempt, RevisitJudgeReport, UserConceptState } from '@/lib/revisit/types';

const report: RevisitJudgeReport = {
  attemptId: 'attempt-1',
  stageId: 'stage-1',
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
      stageId: 'stage-1',
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

describe('formal Revisit operations', () => {
  let db: PGlite;
  const run = (op: string, args: Record<string, unknown>) =>
    runRevisitOperation(db, 'owner-1', op, args);

  beforeEach(async () => {
    db = new PGlite();
    await db.query('CREATE TABLE document_stages (id TEXT PRIMARY KEY)');
    await db.query(
      'CREATE TABLE stage_meta (stage_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, deleted_at TIMESTAMPTZ)',
    );
    await db.query("INSERT INTO document_stages (id) VALUES ('stage-1')");
    await db.query("INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-1', 'owner-1')");
    await ensureRevisitSchema(db);
  });

  afterEach(async () => db.close());

  it('requires completion before evidence and preserves the first completion time', async () => {
    await expect(run('saveEvidenceAndUpdateState', { report })).rejects.toThrow(
      'lesson completion',
    );
    expect(
      await run('recordLessonCompleted', { stageId: 'stage-1', completedAt: 10 }),
    ).toMatchObject({ completedAt: 10, updatedAt: 10 });
    expect(
      await run('recordLessonCompleted', { stageId: 'stage-1', completedAt: 20 }),
    ).toMatchObject({ completedAt: 10, updatedAt: 20 });
  });

  it('commits evidence once and completes its attempt once across retries', async () => {
    await run('recordLessonCompleted', { stageId: 'stage-1', completedAt: 10 });
    await run('createOrGetRevisitAttempt', {
      attemptId: 'attempt-1',
      stage: { id: 'stage-1', name: 'Lesson', createdAt: 1, updatedAt: 1 },
      sourceScenes: [],
      now: 20,
    });
    await run('saveEvidenceAndUpdateState', { report });
    await run('saveEvidenceAndUpdateState', { report });

    expect(await run('countRevisitReports', { stageId: 'stage-1' })).toBe(1);
    expect(await listRevisitRecords(db, 'owner-1', 'stage-1', 'conceptEvidence')).toHaveLength(1);
    expect(
      (await listRevisitRecords<UserConceptState>(db, 'owner-1', 'stage-1', 'userConceptState'))[0]
        ?.evidenceCount,
    ).toBe(1);
    expect(
      ((await run('getRevisitAttempt', { attemptId: 'attempt-1' })) as RevisitAttempt).status,
    ).toBe('completed');
  });

  it('resumes the unfinished attempt and assigns the next sequence after completion', async () => {
    const stage = { id: 'stage-1', name: 'Lesson', createdAt: 1, updatedAt: 1 };
    const first = (await run('createOrGetRevisitAttempt', {
      attemptId: 'attempt-1',
      stage,
      sourceScenes: [],
      now: 10,
    })) as RevisitAttempt;
    const resumed = (await run('createOrGetRevisitAttempt', {
      attemptId: 'attempt-2',
      stage,
      sourceScenes: [],
      now: 20,
    })) as RevisitAttempt;
    expect(resumed.attemptId).toBe('attempt-1');
    await run('markRevisitAttemptCompleted', { attemptId: 'attempt-1', completedAt: 30 });
    const second = (await run('createOrGetRevisitAttempt', {
      attemptId: 'attempt-2',
      stage,
      sourceScenes: [],
      now: 40,
    })) as RevisitAttempt;
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
  });

  it('does not overwrite a completed attempt when its create request is retried', async () => {
    const stage = { id: 'stage-1', name: 'Lesson', createdAt: 1, updatedAt: 1 };
    await run('createOrGetRevisitAttempt', {
      attemptId: 'attempt-1',
      stage,
      sourceScenes: [],
      now: 10,
    });
    await run('markRevisitAttemptCompleted', { attemptId: 'attempt-1', completedAt: 30 });
    const retry = (await run('createOrGetRevisitAttempt', {
      attemptId: 'attempt-1',
      stage: { ...stage, name: 'Changed' },
      sourceScenes: [],
      now: 40,
    })) as RevisitAttempt;
    expect(retry).toMatchObject({
      attemptId: 'attempt-1',
      sequence: 1,
      status: 'completed',
      completedAt: 30,
      sourceStage: { name: 'Lesson' },
    });
    expect(await run('listRevisitAttempts', { stageId: 'stage-1' })).toHaveLength(1);
  });

  it('reads a snapshot serially on one transaction client', async () => {
    await run('recordLessonCompleted', { stageId: 'stage-1', completedAt: 10 });
    let busy = false;
    const serialClient: Queryable = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<QueryResult<TRow>> {
        if (busy) throw new Error('concurrent transaction query');
        busy = true;
        await Promise.resolve();
        try {
          return (await db.query(sql, params)) as QueryResult<TRow>;
        } finally {
          busy = false;
        }
      },
    };
    const snapshot = (await runRevisitOperation(serialClient, 'owner-1', 'snapshotStage', {
      stageId: 'stage-1',
    })) as { lessonProgress: Array<{ completedAt: number }> };
    expect(snapshot.lessonProgress).toMatchObject([{ completedAt: 10 }]);
  });
});
