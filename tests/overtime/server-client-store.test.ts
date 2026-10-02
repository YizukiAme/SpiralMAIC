import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkpointOvertimeExtension,
  claimOvertimeExtension,
  commitOvertimeExtension,
  createOrGetOvertimeExtension,
  getOvertimeExtension,
  heartbeatOvertimeExtension,
  releaseOvertimeExtension,
} from '@/lib/overtime/store';
import type { OvertimeExtension } from '@/lib/overtime/types';

const extension: OvertimeExtension = {
  id: 'task-1',
  stageId: 'stage-1',
  sequence: 1,
  reservedOrder: 2,
  status: 'planning',
  phase: 'outline',
  userPrompt: 'Teach approach',
  decision: { disposition: 'append_page', topic: 'approach', teachingMove: 'extend' },
  createdAt: 1,
  updatedAt: 1,
};

describe('formal overtime browser adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends every checkpoint and commit with the acquired lease and current version', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        calls.push({ path, body });
        const data = path.endsWith('/claim')
          ? { extension, version: 2, leaseToken: 'lease-1', leaseExpiresAt: 50_000 }
          : path.endsWith('/heartbeat')
            ? { leaseExpiresAt: 50_000 }
            : path.endsWith('/release')
              ? { extension: { ...extension, status: 'interrupted' }, version: 4 }
              : path.endsWith('/commit')
                ? { extension: { ...extension, status: 'ready' }, version: 4 }
                : init?.method === 'PATCH'
                  ? { extension: { ...extension, phase: 'content' }, version: 3 }
                  : { extension, version: 1 };
        return Response.json(data);
      }),
    );

    await createOrGetOvertimeExtension({
      id: 'task-1',
      stageId: 'stage-1',
      userPrompt: extension.userPrompt,
      decision: extension.decision,
    });
    await claimOvertimeExtension('task-1');
    await checkpointOvertimeExtension('task-1', {
      status: 'generating',
      phase: 'content',
      updatedAt: 2,
    });
    await heartbeatOvertimeExtension('task-1');
    await commitOvertimeExtension({
      extensionId: 'task-1',
      outline: {
        id: 'scene-1',
        order: 2,
        title: 'Approach',
        description: 'Move closer',
        keyPoints: [],
        type: 'slide',
      },
      scene: {
        id: 'scene-1',
        stageId: 'stage-1',
        order: 2,
        title: 'Approach',
        type: 'slide',
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#fff',
              themeColors: [],
              fontColor: '#111',
              fontName: 'Inter',
            },
            elements: [],
          },
        },
      },
      concepts: [],
    });
    await releaseOvertimeExtension('task-1');

    expect(calls.find((call) => call.path.endsWith('/claim'))?.body).toEqual({ version: 1 });
    expect(
      calls.find((call) => call.path === '/api/spiral/overtime/task-1' && call.body?.patch)?.body,
    ).toMatchObject({ version: 2, leaseToken: 'lease-1' });
    expect(calls.find((call) => call.path.endsWith('/commit'))?.body).toMatchObject({
      version: 3,
      leaseToken: 'lease-1',
      concepts: [],
    });
    expect(calls.find((call) => call.path.endsWith('/heartbeat'))?.body).toEqual({
      leaseToken: 'lease-1',
    });
  });

  it('does not lose a lease when an older read resolves after a checkpoint', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        calls.push({ path, body });
        const data = path.endsWith('/claim')
          ? { extension, version: 2, leaseToken: 'lease-1', leaseExpiresAt: 50_000 }
          : init?.method === 'PATCH'
            ? { extension: { ...extension, phase: 'content' }, version: 3 }
            : path.endsWith('/commit')
              ? { extension: { ...extension, status: 'ready' }, version: 4 }
              : { extension, version: 1 };
        return Response.json(data);
      }),
    );

    await createOrGetOvertimeExtension({
      id: extension.id,
      stageId: extension.stageId,
      userPrompt: extension.userPrompt,
      decision: extension.decision,
    });
    await claimOvertimeExtension(extension.id);
    await checkpointOvertimeExtension(extension.id, {
      status: 'generating',
      phase: 'content',
      updatedAt: 2,
    });
    await getOvertimeExtension(extension.id);
    await commitOvertimeExtension({
      extensionId: extension.id,
      outline: {
        id: 'scene-1',
        order: 2,
        title: 'Approach',
        description: 'Move closer',
        keyPoints: [],
        type: 'slide',
      },
      scene: {
        id: 'scene-1',
        stageId: extension.stageId,
        order: 2,
        title: 'Approach',
        type: 'slide',
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#fff',
              themeColors: [],
              fontColor: '#111',
              fontName: 'Inter',
            },
            elements: [],
          },
        },
      },
    });

    expect(calls.find((call) => call.path.endsWith('/commit'))?.body).toMatchObject({
      version: 3,
      leaseToken: 'lease-1',
    });
  });
});
