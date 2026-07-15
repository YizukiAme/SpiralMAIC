// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const stage = (id: string) => ({ id, name: id, createdAt: 1, updatedAt: 1 });
  return {
    listeners,
    snapshot: {
      stage: stage('stage-a'),
      scenes: [] as unknown[],
      outlines: [] as unknown[],
      getSceneById: () => null,
    },
    runtimeOptions: undefined as
      | {
          messages: Array<{ role?: string; content?: unknown }>;
          isRunning: boolean;
          onNew: (message: {
            role: 'user';
            content: Array<{ type: 'text'; text: string }>;
          }) => Promise<void> | void;
          onCancel: () => Promise<void> | void;
        }
      | undefined,
    fetchInit: undefined as RequestInit | undefined,
    responseController: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
    rememberActiveSession: vi.fn(),
    saveSession: vi.fn(async () => undefined),
  };
});

vi.mock('@assistant-ui/react', () => ({
  useExternalStoreRuntime: (options: NonNullable<typeof mocks.runtimeOptions>) => {
    mocks.runtimeOptions = options;
    return options;
  },
}));

vi.mock('@/lib/store/stage', async () => {
  const { useSyncExternalStore } = await import('react');
  const getState = () => mocks.snapshot;
  const useStageStore = Object.assign(
    <T>(selector: (state: typeof mocks.snapshot) => T): T =>
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
        () => selector(getState()),
        () => selector(getState()),
      ),
    { getState },
  );
  return { useStageStore };
});

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: { getState: () => ({ activeElementIdList: [] }) },
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({}),
  buildModelRequestHeaders: () => ({}),
}));

vi.mock('@/lib/utils/database', () => ({ db: { agentEditSessions: {} } }));

vi.mock('@/lib/agent/client/agent-thread-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/client/agent-thread-store')>();
  return {
    ...actual,
    migrateLegacyThread: vi.fn(async () => undefined),
    listSessions: vi.fn(async (stageId: string) =>
      stageId === 'stage-a'
        ? [
            {
              id: 'session-a',
              stageId: 'stage-a',
              title: 'A',
              messages: [
                {
                  role: 'user' as const,
                  id: 'a-user',
                  content: [{ type: 'text' as const, text: 'stage A history' }],
                },
              ],
              createdAt: 1,
              updatedAt: 1,
            },
          ]
        : [],
    ),
    recallActiveSession: vi.fn((stageId: string) =>
      stageId === 'stage-a' ? 'session-a' : undefined,
    ),
    rememberActiveSession: mocks.rememberActiveSession,
    saveSession: mocks.saveSession,
  };
});

vi.mock('@/lib/agent/client/regen-snapshots', () => ({
  useRegenSnapshots: {
    getState: () => ({ clearAll: vi.fn(), setSnapshot: vi.fn() }),
  },
}));

vi.mock('@/lib/agent/client/thinking-timers', () => ({
  useThinkingTimers: {
    getState: () => ({
      timers: {},
      clear: vi.fn(),
      seed: vi.fn(),
      observe: vi.fn(),
      endAll: vi.fn(),
    }),
  },
}));

vi.mock('@/lib/store/scene-runtime-errors', () => ({
  useSceneRuntimeErrors: { getState: () => ({ errors: {} }) },
}));

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { useAgentRuntime } from '@/lib/agent/client/use-agent-runtime';

function switchStage(id: string): void {
  mocks.snapshot = {
    ...mocks.snapshot,
    stage: { id, name: id, createdAt: 1, updatedAt: 1 },
  };
  for (const listener of mocks.listeners) listener();
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useAgentRuntime stage ownership', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useAgentRuntime> | undefined;
  let runPromise: Promise<void> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.snapshot = {
      stage: { id: 'stage-a', name: 'stage-a', createdAt: 1, updatedAt: 1 },
      scenes: [],
      outlines: [],
      getSceneById: () => null,
    };
    mocks.fetchInit = undefined;
    mocks.responseController = undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        mocks.fetchInit = init;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              mocks.responseController = controller;
            },
          }),
          { status: 200 },
        );
      }),
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function Harness() {
      const result = useAgentRuntime({});
      useEffect(() => {
        latest = result;
      }, [result]);
      return null;
    }
    await act(async () => {
      root.render(createElement(Harness));
      await flushEffects();
    });
    expect(latest?.activeSessionId).toBe('session-a');
  });

  afterEach(async () => {
    if (mocks.responseController) {
      await act(async () => {
        mocks.responseController?.close();
        await runPromise;
      });
    }
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps an immediate stage-B run when the pending switch effect settles', async () => {
    await act(async () => {
      switchStage('stage-b');
      runPromise = Promise.resolve(
        mocks.runtimeOptions?.onNew({
          role: 'user',
          content: [{ type: 'text', text: 'stage B prompt' }],
        }),
      );
      await flushEffects();
    });

    const body = JSON.parse(String(mocks.fetchInit?.body)) as {
      sessionId?: string;
      history?: unknown[];
    };
    expect(body.history).toEqual([]);
    expect(body.sessionId).toBe(latest?.activeSessionId);
    expect(mocks.fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect((mocks.fetchInit?.signal as AbortSignal).aborted).toBe(false);
    expect(mocks.runtimeOptions?.isRunning).toBe(true);
    expect(JSON.stringify(mocks.runtimeOptions?.messages)).toContain('stage B prompt');
    expect(JSON.stringify(mocks.runtimeOptions?.messages)).not.toContain('stage A history');
  });
});
