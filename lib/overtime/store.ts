import type { OvertimeExtension } from '@/lib/overtime/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import { db } from '@/lib/utils/database';
import { withStagePersistenceLock } from '@/lib/utils/stage-persistence-lock';

const ACTIVE_STATUSES = new Set<OvertimeExtension['status']>([
  'planning',
  'generating',
  'failed',
  'interrupted',
]);

export async function createOrGetOvertimeExtension(args: {
  id: string;
  stageId: string;
  userPrompt: string;
  decision: OvertimeExtension['decision'];
  now?: number;
}): Promise<OvertimeExtension> {
  const now = args.now ?? Date.now();
  return withStagePersistenceLock(args.stageId, () =>
    db.transaction('rw', [db.overtimeExtensions, db.scenes], async () => {
      const records = await db.overtimeExtensions.where('stageId').equals(args.stageId).toArray();
      const unfinished = records.find((record) => ACTIVE_STATUSES.has(record.status));
      if (unfinished) return unfinished;

      const scenes = await db.scenes.where('stageId').equals(args.stageId).toArray();
      const sequence = records.reduce((max, record) => Math.max(max, record.sequence), 0) + 1;
      const reservedOrder =
        Math.max(
          -1,
          ...scenes.map((scene) => scene.order),
          ...records.map((record) => record.reservedOrder),
        ) + 1;
      const extension: OvertimeExtension = {
        id: args.id,
        stageId: args.stageId,
        sequence,
        reservedOrder,
        status: 'planning',
        phase: 'outline',
        userPrompt: args.userPrompt,
        decision: args.decision,
        createdAt: now,
        updatedAt: now,
      };
      await db.overtimeExtensions.add(extension);
      return extension;
    }),
  );
}

export function getOvertimeExtension(id: string): Promise<OvertimeExtension | undefined> {
  return db.overtimeExtensions.get(id);
}

export async function listOvertimeExtensions(stageId: string): Promise<OvertimeExtension[]> {
  const records = await db.overtimeExtensions.where('stageId').equals(stageId).toArray();
  return records.sort((a, b) => a.sequence - b.sequence);
}

export async function checkpointOvertimeExtension(
  id: string,
  patch: Partial<OvertimeExtension> & Pick<OvertimeExtension, 'phase' | 'status' | 'updatedAt'>,
): Promise<OvertimeExtension> {
  const existing = await db.overtimeExtensions.get(id);
  if (!existing) throw new Error(`Overtime extension ${id} was not found.`);
  if (existing.status === 'ready') return existing;
  const next: OvertimeExtension = {
    ...existing,
    ...patch,
    id: existing.id,
    stageId: existing.stageId,
    sequence: existing.sequence,
    reservedOrder: existing.reservedOrder,
    createdAt: existing.createdAt,
  };
  await db.overtimeExtensions.put(next);
  return next;
}

export async function markOvertimeExtensionFailed(
  id: string,
  error: string,
  now = Date.now(),
): Promise<void> {
  const existing = await db.overtimeExtensions.get(id);
  if (!existing || existing.status === 'ready') return;
  await db.overtimeExtensions.update(id, { status: 'failed', error, updatedAt: now });
}

export async function markActiveOvertimeExtensionsInterrupted(
  stageId?: string,
  now = Date.now(),
): Promise<number> {
  const records = stageId
    ? await db.overtimeExtensions.where('stageId').equals(stageId).toArray()
    : await db.overtimeExtensions.toArray();
  const active = records.filter(
    (record) => record.status === 'planning' || record.status === 'generating',
  );
  await db.transaction('rw', db.overtimeExtensions, async () => {
    await Promise.all(
      active.map((record) =>
        db.overtimeExtensions.update(record.id, { status: 'interrupted', updatedAt: now }),
      ),
    );
  });
  return active.length;
}

export async function commitOvertimeExtension(args: {
  extensionId: string;
  outline: SceneOutline;
  scene: Scene;
  now?: number;
}): Promise<OvertimeExtension> {
  const initial = await db.overtimeExtensions.get(args.extensionId);
  if (!initial) throw new Error(`Overtime extension ${args.extensionId} was not found.`);
  return withStagePersistenceLock(initial.stageId, () =>
    db.transaction(
      'rw',
      [db.stages, db.scenes, db.stageOutlines, db.overtimeExtensions],
      async () => {
        const extension = await db.overtimeExtensions.get(args.extensionId);
        if (!extension) throw new Error(`Overtime extension ${args.extensionId} was not found.`);
        if (extension.status === 'ready') return extension;
        const stage = await db.stages.get(extension.stageId);
        if (!stage) throw new Error(`Stage ${extension.stageId} was not found.`);
        if (
          args.scene.id !== args.outline.id ||
          args.scene.stageId !== extension.stageId ||
          args.scene.order !== extension.reservedOrder ||
          args.outline.order !== extension.reservedOrder
        ) {
          throw new Error('Overtime scene does not match its reserved identity and order.');
        }

        const now = args.now ?? Date.now();
        const existingOutlines = await db.stageOutlines.get(extension.stageId);
        const outlines = (existingOutlines?.outlines ?? []).filter(
          (outline) => outline.id !== args.outline.id,
        );
        outlines.push(args.outline);
        outlines.sort((a, b) => a.order - b.order);

        await db.scenes.put({
          ...args.scene,
          createdAt: args.scene.createdAt ?? now,
          updatedAt: now,
        });
        await db.stageOutlines.put({
          stageId: extension.stageId,
          outlines,
          generationComplete: true,
          createdAt: existingOutlines?.createdAt ?? now,
          updatedAt: now,
        });
        await db.stages.update(extension.stageId, { updatedAt: now });
        const ready: OvertimeExtension = {
          ...extension,
          status: 'ready',
          phase: 'commit',
          outline: args.outline,
          scene: args.scene,
          error: undefined,
          updatedAt: now,
          completedAt: now,
        };
        await db.overtimeExtensions.put(ready);
        return ready;
      },
    ),
  );
}
