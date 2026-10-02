'use client';

import type { LessonConcept } from '@/lib/revisit/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

import type { OvertimeExtension } from './types';

interface VersionedTask {
  extension: OvertimeExtension;
  version: number;
}

interface HeldTask {
  version: number;
  leaseToken?: string;
}

const held = new Map<string, HeldTask>();

export class OvertimeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OvertimeHttpError';
  }
}

export function isOvertimeLeaseConflict(error: unknown): boolean {
  return error instanceof OvertimeHttpError && error.status === 409;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await response.json().catch(() => null)) as
    | (T & {
        error?: { message?: string } | string;
        details?: string;
      })
    | null;
  if (!response.ok) {
    const message =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ??
          body?.details ??
          `Overtime request failed: HTTP ${response.status}`);
    throw new OvertimeHttpError(response.status, message);
  }
  return body as T;
}

function remember(task: VersionedTask, keepLease = false): OvertimeExtension {
  const old = held.get(task.extension.id);
  if (old && task.version < old.version) return task.extension;
  held.set(task.extension.id, {
    version: task.version,
    ...(keepLease && old?.leaseToken ? { leaseToken: old.leaseToken } : {}),
  });
  return task.extension;
}

function leaseFor(id: string): HeldTask & { leaseToken: string } {
  const task = held.get(id);
  if (!task?.leaseToken) throw new OvertimeHttpError(409, 'Overtime generation lease is not held.');
  return task as HeldTask & { leaseToken: string };
}

function taskPath(id: string): string {
  return `/api/spiral/overtime/${encodeURIComponent(id)}`;
}

export async function createOrGetOvertimeExtension(args: {
  id: string;
  stageId: string;
  userPrompt: string;
  decision: OvertimeExtension['decision'];
  now?: number;
}): Promise<OvertimeExtension> {
  const task = await request<VersionedTask>('/api/spiral/overtime', {
    method: 'POST',
    body: JSON.stringify(args),
  });
  return remember(task);
}

export async function getOvertimeExtension(id: string): Promise<OvertimeExtension | undefined> {
  const task = await request<VersionedTask>(taskPath(id)).catch((error) => {
    if (error instanceof OvertimeHttpError && error.status === 404) return null;
    throw error;
  });
  return task ? remember(task, held.get(id)?.version === task.version) : undefined;
}

export async function listOvertimeExtensions(stageId: string): Promise<OvertimeExtension[]> {
  const result = await request<{ extensions: VersionedTask[] }>(
    `/api/spiral/overtime?stageId=${encodeURIComponent(stageId)}`,
  );
  return result.extensions.map((task) =>
    remember(task, held.get(task.extension.id)?.version === task.version),
  );
}

export async function claimOvertimeExtension(id: string): Promise<OvertimeExtension> {
  const current = await getOvertimeExtension(id);
  if (!current) throw new OvertimeHttpError(404, 'Overtime task was not found.');
  const version = held.get(id)!.version;
  const claimed = await request<VersionedTask & { leaseToken: string }>(`${taskPath(id)}/claim`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
  held.set(id, { version: claimed.version, leaseToken: claimed.leaseToken });
  return claimed.extension;
}

export async function heartbeatOvertimeExtension(id: string): Promise<void> {
  const { leaseToken } = leaseFor(id);
  await request(`${taskPath(id)}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ leaseToken }),
  });
}

export async function releaseOvertimeExtension(id: string): Promise<void> {
  const task = held.get(id);
  if (!task?.leaseToken) return;
  held.delete(id);
  await request(`${taskPath(id)}/release`, {
    method: 'POST',
    body: JSON.stringify({ leaseToken: task.leaseToken }),
  });
}

export async function checkpointOvertimeExtension(
  id: string,
  patch: Partial<OvertimeExtension> & Pick<OvertimeExtension, 'phase' | 'status' | 'updatedAt'>,
): Promise<OvertimeExtension> {
  const { version, leaseToken } = leaseFor(id);
  const task = await request<VersionedTask>(taskPath(id), {
    method: 'PATCH',
    body: JSON.stringify({ version, leaseToken, patch }),
  });
  return remember(
    task,
    task.extension.status !== 'failed' && task.extension.status !== 'interrupted',
  );
}

export async function markOvertimeExtensionFailed(
  id: string,
  error: string,
  now = Date.now(),
): Promise<void> {
  const extension = await getOvertimeExtension(id);
  if (!extension || extension.status === 'ready') return;
  await checkpointOvertimeExtension(id, {
    status: 'failed',
    phase: extension.phase,
    error,
    updatedAt: now,
  });
}

export async function commitOvertimeExtension(args: {
  extensionId: string;
  outline: SceneOutline;
  scene: Scene;
  concepts?: LessonConcept[];
  now?: number;
}): Promise<OvertimeExtension> {
  const { version, leaseToken } = leaseFor(args.extensionId);
  const task = await request<VersionedTask>(`${taskPath(args.extensionId)}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      version,
      leaseToken,
      outline: args.outline,
      scene: args.scene,
      concepts: args.concepts ?? [],
    }),
  });
  return remember(task);
}
