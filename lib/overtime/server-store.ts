import { randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import { StageAccessError } from '@/lib/persistence/stage-meta';
import { upsertRevisitLessonConceptsForStage } from '@/lib/revisit/server-store';
import type { LessonConcept } from '@/lib/revisit/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';

import type { OvertimeExtension } from './types';

export class OvertimeConflictError extends Error {
  override readonly name = 'OvertimeConflictError';
}

export class OvertimeNotFoundError extends Error {
  override readonly name = 'OvertimeNotFoundError';
}

export interface VersionedOvertimeExtension {
  extension: OvertimeExtension;
  version: number;
}

interface OvertimeRow extends Record<string, unknown> {
  body: OvertimeExtension;
  version: number;
  stage_id: string;
  lease_token: string | null;
  lease_expires_at: number | null;
}

const LEASE_MS = 30_000;

/** A task row belongs to its course; `stage_meta` remains the sole owner record. */
export async function ensureServerOvertimeSchema(queryable: Queryable): Promise<void> {
  await queryable.query(`CREATE TABLE IF NOT EXISTS overtime_extensions (
    id TEXT PRIMARY KEY,
    stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    reserved_order INTEGER NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    lease_token TEXT,
    lease_expires_at DOUBLE PRECISION,
    body JSONB NOT NULL
  )`);
  await queryable.query(`CREATE INDEX IF NOT EXISTS overtime_extensions_stage_sequence_idx
    ON overtime_extensions (stage_id, sequence)`);
  await queryable.query(`CREATE UNIQUE INDEX IF NOT EXISTS overtime_extensions_one_unfinished_idx
    ON overtime_extensions (stage_id)
    WHERE status IN ('planning', 'generating', 'failed', 'interrupted')`);
}

/** Remove task rows in the same transaction that tombstones a course. */
export async function deleteOvertimeForStage(tx: Queryable, stageId: string): Promise<void> {
  await tx.query('DELETE FROM overtime_extensions WHERE stage_id = $1', [stageId]);
}

function versioned(row: OvertimeRow): VersionedOvertimeExtension {
  return { extension: sanitizeSceneContent(row.body), version: Number(row.version) };
}

function validId(value: string): boolean {
  return (
    value.length > 0 && value !== '.' && value !== '..' && !/[\u0000\uD800-\uDFFF]/u.test(value)
  );
}

export function createServerOvertimeStore(options: {
  pool: TransactionSource & Queryable;
  ownerId: string;
}) {
  const { pool, ownerId } = options;
  const documents = createOwnerBoundDocumentStore<Scene, Stage>({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });

  async function withOwnedMutation<T>(
    stageId: string,
    body: Parameters<typeof documents.withMutationTransaction<T>>[1],
  ): Promise<T> {
    try {
      return await documents.withMutationTransaction(stageId, body);
    } catch (error) {
      if (error instanceof StageAccessError) throw new OvertimeNotFoundError();
      throw error;
    }
  }

  async function ownedStageForTask(id: string): Promise<string | null> {
    if (!validId(id)) return null;
    const rows = await pool.query<{ stage_id: string } & Record<string, unknown>>(
      `SELECT task.stage_id FROM overtime_extensions AS task
       JOIN stage_meta AS meta ON meta.stage_id = task.stage_id
       WHERE task.id = $1 AND meta.owner_id = $2 AND meta.deleted_at IS NULL`,
      [id, ownerId],
    );
    return rows.rows[0]?.stage_id ?? null;
  }

  async function taskIn(tx: Queryable, id: string): Promise<OvertimeRow | null> {
    const rows = await tx.query<OvertimeRow>(
      'SELECT body, version, stage_id, lease_token, lease_expires_at FROM overtime_extensions WHERE id = $1 FOR UPDATE',
      [id],
    );
    const row = rows.rows[0];
    return row ? { ...row, body: sanitizeSceneContent(row.body) } : null;
  }

  function assertLease(row: OvertimeRow, token: string, now: number): void {
    if (!token || row.lease_token !== token || Number(row.lease_expires_at) <= now) {
      throw new OvertimeConflictError('Overtime generation lease is no longer held.');
    }
  }

  return {
    async get(id: string): Promise<VersionedOvertimeExtension | null> {
      if (!validId(id)) return null;
      const result = await pool.query<OvertimeRow>(
        `SELECT task.body, task.version, task.stage_id
         FROM overtime_extensions AS task
         JOIN stage_meta AS meta ON meta.stage_id = task.stage_id
         WHERE task.id = $1 AND meta.owner_id = $2 AND meta.deleted_at IS NULL`,
        [id, ownerId],
      );
      return result.rows[0] ? versioned(result.rows[0]) : null;
    },

    async list(stageId: string): Promise<VersionedOvertimeExtension[] | null> {
      if (!validId(stageId)) return null;
      const visible = await pool.query<Record<string, unknown>>(
        'SELECT 1 FROM stage_meta WHERE stage_id = $1 AND owner_id = $2 AND deleted_at IS NULL',
        [stageId, ownerId],
      );
      if (!visible.rows.length) return null;
      const result = await pool.query<OvertimeRow>(
        'SELECT body, version, stage_id FROM overtime_extensions WHERE stage_id = $1 ORDER BY sequence',
        [stageId],
      );
      return result.rows.map(versioned);
    },

    async createOrGet(
      args: Pick<OvertimeExtension, 'id' | 'stageId' | 'userPrompt' | 'decision'> & {
        now?: number;
      },
    ): Promise<VersionedOvertimeExtension> {
      if (!validId(args.id) || !validId(args.stageId)) throw new OvertimeNotFoundError();
      return withOwnedMutation(args.stageId, async (tx, document) => {
        const active = await tx.query<OvertimeRow>(
          `SELECT body, version, stage_id FROM overtime_extensions
           WHERE stage_id = $1 AND status IN ('planning', 'generating', 'failed', 'interrupted')
           FOR UPDATE`,
          [args.stageId],
        );
        if (active.rows[0]) return versioned(active.rows[0]);
        const current = await document.loadDocument();
        if (!current) throw new OvertimeNotFoundError();
        const previous = await tx.query<
          { sequence: number; reserved_order: number } & Record<string, unknown>
        >('SELECT sequence, reserved_order FROM overtime_extensions WHERE stage_id = $1', [
          args.stageId,
        ]);
        const now = args.now ?? Date.now();
        const extension: OvertimeExtension = {
          id: args.id,
          stageId: args.stageId,
          sequence: Math.max(0, ...previous.rows.map((row) => Number(row.sequence))) + 1,
          reservedOrder:
            Math.max(
              -1,
              ...current.scenes.map((scene) => scene.order),
              ...previous.rows.map((row) => Number(row.reserved_order)),
            ) + 1,
          status: 'planning',
          phase: 'outline',
          userPrompt: args.userPrompt,
          decision: args.decision,
          createdAt: now,
          updatedAt: now,
        };
        const inserted = await tx.query<OvertimeRow>(
          `INSERT INTO overtime_extensions (id, stage_id, sequence, reserved_order, status, body)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT DO NOTHING RETURNING body, version, stage_id`,
          [
            extension.id,
            extension.stageId,
            extension.sequence,
            extension.reservedOrder,
            extension.status,
            JSON.stringify(extension),
          ],
        );
        if (!inserted.rows[0]) throw new OvertimeConflictError('Overtime task id already exists.');
        return versioned(inserted.rows[0]);
      });
    },

    async claim(args: {
      id: string;
      version: number;
      now?: number;
    }): Promise<VersionedOvertimeExtension & { leaseToken: string; leaseExpiresAt: number }> {
      const stageId = await ownedStageForTask(args.id);
      if (!stageId) throw new OvertimeNotFoundError();
      return withOwnedMutation(stageId, async (tx) => {
        const current = await taskIn(tx, args.id);
        if (!current) throw new OvertimeNotFoundError();
        const now = args.now ?? Date.now();
        if (
          current.body.status === 'ready' ||
          current.version !== args.version ||
          (current.lease_token && Number(current.lease_expires_at) > now)
        ) {
          throw new OvertimeConflictError('Overtime task is already being generated.');
        }
        const leaseToken = randomUUID();
        const leaseExpiresAt = now + LEASE_MS;
        const result = await tx.query<OvertimeRow>(
          `UPDATE overtime_extensions SET lease_token = $2, lease_expires_at = $3,
            version = version + 1 WHERE id = $1 RETURNING body, version, stage_id`,
          [args.id, leaseToken, leaseExpiresAt],
        );
        return { ...versioned(result.rows[0]!), leaseToken, leaseExpiresAt };
      });
    },

    async heartbeat(args: {
      id: string;
      leaseToken: string;
      now?: number;
    }): Promise<{ leaseExpiresAt: number }> {
      const stageId = await ownedStageForTask(args.id);
      if (!stageId) throw new OvertimeNotFoundError();
      return withOwnedMutation(stageId, async (tx) => {
        const current = await taskIn(tx, args.id);
        if (!current) throw new OvertimeNotFoundError();
        const now = args.now ?? Date.now();
        assertLease(current, args.leaseToken, now);
        const leaseExpiresAt = now + LEASE_MS;
        await tx.query('UPDATE overtime_extensions SET lease_expires_at = $2 WHERE id = $1', [
          args.id,
          leaseExpiresAt,
        ]);
        return { leaseExpiresAt };
      });
    },

    async release(args: {
      id: string;
      leaseToken: string;
      now?: number;
    }): Promise<VersionedOvertimeExtension> {
      const stageId = await ownedStageForTask(args.id);
      if (!stageId) throw new OvertimeNotFoundError();
      return withOwnedMutation(stageId, async (tx) => {
        const current = await taskIn(tx, args.id);
        if (!current) throw new OvertimeNotFoundError();
        if (current.body.status === 'ready') return versioned(current);
        assertLease(current, args.leaseToken, args.now ?? Date.now());
        const next: OvertimeExtension = {
          ...current.body,
          status:
            current.body.status === 'planning' || current.body.status === 'generating'
              ? 'interrupted'
              : current.body.status,
          updatedAt: args.now ?? Date.now(),
        };
        const result = await tx.query<OvertimeRow>(
          `UPDATE overtime_extensions SET body = $2::jsonb, status = $3,
            lease_token = NULL, lease_expires_at = NULL, version = version + 1
            WHERE id = $1 RETURNING body, version, stage_id`,
          [args.id, JSON.stringify(next), next.status],
        );
        return versioned(result.rows[0]!);
      });
    },

    async checkpoint(args: {
      id: string;
      version: number;
      leaseToken: string;
      now?: number;
      patch: Partial<OvertimeExtension> & Pick<OvertimeExtension, 'phase' | 'status' | 'updatedAt'>;
    }): Promise<VersionedOvertimeExtension> {
      const stageId = await ownedStageForTask(args.id);
      if (!stageId) throw new OvertimeNotFoundError();
      if (!['planning', 'generating', 'failed', 'interrupted'].includes(args.patch.status)) {
        throw new OvertimeConflictError('Only the commit operation may mark a task ready.');
      }
      return withOwnedMutation(stageId, async (tx) => {
        const current = await taskIn(tx, args.id);
        if (!current) throw new OvertimeNotFoundError();
        if (current.body.status === 'ready') return versioned(current);
        if (current.version !== args.version)
          throw new OvertimeConflictError('Stale overtime task version.');
        const now = args.now ?? Date.now();
        assertLease(current, args.leaseToken, now);
        const { phase, status, updatedAt, plan, outline, content, scene, error } = args.patch;
        const next: OvertimeExtension = sanitizeSceneContent({
          ...current.body,
          phase,
          status,
          updatedAt,
          ...(plan === undefined ? {} : { plan }),
          ...(outline === undefined ? {} : { outline }),
          ...(content === undefined ? {} : { content }),
          ...(scene === undefined ? {} : { scene }),
          ...(status === 'planning' || status === 'generating'
            ? { error: undefined }
            : error === undefined
              ? {}
              : { error }),
        });
        const result = await tx.query<OvertimeRow>(
          `UPDATE overtime_extensions SET body = $2::jsonb, status = $3, version = version + 1,
            lease_token = CASE WHEN $3 IN ('failed', 'interrupted') THEN NULL ELSE lease_token END,
            lease_expires_at = CASE WHEN $3 IN ('failed', 'interrupted') THEN NULL ELSE $4::double precision END
           WHERE id = $1 RETURNING body, version, stage_id`,
          [args.id, JSON.stringify(next), status, now + LEASE_MS],
        );
        return versioned(result.rows[0]!);
      });
    },

    async commit(args: {
      id: string;
      version: number;
      leaseToken: string;
      outline: SceneOutline;
      scene: Scene;
      concepts?: LessonConcept[];
      now?: number;
    }): Promise<VersionedOvertimeExtension> {
      const stageId = await ownedStageForTask(args.id);
      if (!stageId) throw new OvertimeNotFoundError();
      return withOwnedMutation(stageId, async (tx, document) => {
        const current = await taskIn(tx, args.id);
        if (!current) throw new OvertimeNotFoundError();
        if (current.body.status === 'ready') return versioned(current);
        if (current.version !== args.version)
          throw new OvertimeConflictError('Stale overtime task version.');
        const now = args.now ?? Date.now();
        assertLease(current, args.leaseToken, now);
        const extension = current.body;
        if (
          args.scene.id !== args.outline.id ||
          args.scene.stageId !== stageId ||
          args.scene.order !== extension.reservedOrder ||
          args.outline.order !== extension.reservedOrder ||
          args.scene.overtime?.extensionId !== extension.id ||
          args.scene.overtime.sequence !== extension.sequence
        ) {
          throw new OvertimeConflictError('Overtime scene does not match its reserved task.');
        }
        const existing = await document.loadDocument();
        if (!existing) throw new OvertimeNotFoundError();
        const storedOutline = existing.outline as AppDocumentOutline | undefined;
        const outlines = (storedOutline?.outlines ?? []).filter(
          (item) => item.id !== args.outline.id,
        );
        outlines.push(args.outline);
        outlines.sort((a, b) => a.order - b.order);
        await document.saveDocument({
          ...existing,
          stage: { ...existing.stage, updatedAt: now },
          scenes: [
            ...existing.scenes.filter((item) => item.id !== args.scene.id),
            { ...args.scene, createdAt: args.scene.createdAt ?? now, updatedAt: now },
          ].sort((a, b) => a.order - b.order),
          outline: {
            ...storedOutline,
            outlines,
            generationComplete: true,
            createdAt: storedOutline?.createdAt ?? now,
            updatedAt: now,
          },
        });
        if (args.concepts?.length) {
          await upsertRevisitLessonConceptsForStage(tx, ownerId, stageId, args.concepts);
        }
        const ready: OvertimeExtension = sanitizeSceneContent({
          ...extension,
          status: 'ready',
          phase: 'commit',
          outline: args.outline,
          scene: args.scene,
          error: undefined,
          updatedAt: now,
          completedAt: now,
        });
        const result = await tx.query<OvertimeRow>(
          `UPDATE overtime_extensions SET body = $2::jsonb, status = 'ready', version = version + 1,
            lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1 RETURNING body, version, stage_id`,
          [args.id, JSON.stringify(ready)],
        );
        return versioned(result.rows[0]!);
      });
    },

    async import(args: {
      stageId: string;
      extensions: OvertimeExtension[];
    }): Promise<{ insertedIds: string[]; conflictingIds: string[] }> {
      if (!validId(args.stageId)) throw new OvertimeNotFoundError();
      return withOwnedMutation(args.stageId, async (tx) => {
        const insertedIds: string[] = [];
        const conflictingIds: string[] = [];
        for (const source of args.extensions) {
          if (!validId(source.id)) throw new OvertimeConflictError('Invalid overtime task id.');
          const extension: OvertimeExtension = sanitizeSceneContent({
            ...source,
            stageId: args.stageId,
            ...(source.scene ? { scene: { ...source.scene, stageId: args.stageId } } : {}),
          });
          const result = await tx.query<{ id: string } & Record<string, unknown>>(
            `INSERT INTO overtime_extensions (id, stage_id, sequence, reserved_order, status, body)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              extension.id,
              args.stageId,
              extension.sequence,
              extension.reservedOrder,
              extension.status,
              JSON.stringify(extension),
            ],
          );
          (result.rows[0] ? insertedIds : conflictingIds).push(extension.id);
        }
        return { insertedIds, conflictingIds };
      });
    },
  };
}
