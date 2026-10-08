import { describe, expect, it, vi } from 'vitest';

import {
  runOvertimeGeneration,
  type OvertimeGenerationDependencies,
} from '@/lib/overtime/generation';
import type { OvertimeExtension, OvertimePlanDraft } from '@/lib/overtime/types';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const stage: Stage = {
  id: 'stage-1',
  name: 'Motion verbs',
  createdAt: 1,
  updatedAt: 2,
};

const sourceScene = {
  id: 'scene-1',
  stageId: stage.id,
  type: 'slide',
  title: 'Go',
  order: 1,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
      elements: [],
    },
  },
} satisfies Scene;

const plan: OvertimePlanDraft = {
  outline: {
    type: 'slide',
    title: 'Approach',
    description: 'Move closer.',
    keyPoints: ['meaning'],
  },
  sourceSceneIds: ['scene-1'],
  concepts: [{ kind: 'new', label: 'approach', summary: 'Move closer.' }],
};

function extension(overrides: Partial<OvertimeExtension> = {}): OvertimeExtension {
  return {
    id: 'extension-1',
    stageId: stage.id,
    sequence: 1,
    reservedOrder: 2,
    status: 'planning',
    phase: 'outline',
    userPrompt: 'Teach approach.',
    decision: { disposition: 'append_page', topic: 'approach', teachingMove: 'extend' },
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function generatedScene() {
  return {
    ...sourceScene,
    id: 'overtime-extension-1',
    title: 'Approach',
    order: 2,
  } satisfies Scene;
}

function deps(record: { current: OvertimeExtension }): OvertimeGenerationDependencies {
  return {
    getExtension: vi.fn(async () => record.current),
    requestPlan: vi.fn(async () => plan),
    checkpoint: vi.fn(async (_id, patch) => {
      record.current = { ...record.current, ...patch };
      return record.current;
    }),
    markFailed: vi.fn(async () => undefined),
    fetchContent: vi.fn(async () => ({ success: true, content: { elements: [] } })),
    fetchActions: vi.fn(async () => ({ success: true, scene: generatedScene() })),
    generateTTS: vi.fn(async () => ({ success: true, failedCount: 0 })),
    generateMedia: vi.fn(async () => undefined),
    upsertConcepts: vi.fn(async () => undefined),
    commit: vi.fn(async ({ scene, outline }) => {
      record.current = {
        ...record.current,
        status: 'ready',
        phase: 'commit',
        scene,
        outline,
      };
      return record.current;
    }),
  };
}

describe('overtime generation pipeline', () => {
  it('claims a generation lease before planning and releases it after completion', async () => {
    const record = { current: extension() };
    const dependencies = deps(record);
    dependencies.claim = vi.fn(async () => record.current);
    dependencies.heartbeat = vi.fn(async () => undefined);
    dependencies.release = vi.fn(async () => undefined);

    await runOvertimeGeneration({
      extensionId: record.current.id,
      stage,
      scenes: [sourceScene],
      existingOutlines: [],
      knownConcepts: [],
      dependencies,
      now: () => 20,
    });

    expect(dependencies.claim).toHaveBeenCalledWith('extension-1');
    expect(dependencies.release).toHaveBeenCalledWith('extension-1');
  });

  it('plans and generates one durable page through the existing content/actions/TTS pipeline', async () => {
    const record = { current: extension() };
    const dependencies = deps(record);
    const onProgress = vi.fn();

    const result = await runOvertimeGeneration({
      extensionId: record.current.id,
      stage,
      scenes: [sourceScene],
      existingOutlines: [],
      knownConcepts: [],
      now: () => 20,
      dependencies,
      onProgress,
    });

    expect(dependencies.requestPlan).toHaveBeenCalledOnce();
    expect(dependencies.fetchContent).toHaveBeenCalledOnce();
    expect(dependencies.fetchActions).toHaveBeenCalledOnce();
    expect(dependencies.generateTTS).toHaveBeenCalledOnce();
    expect(dependencies.upsertConcepts).toHaveBeenCalledWith([
      expect.objectContaining({ conceptId: expect.stringMatching(/^overtime-approach-/) }),
    ]);
    expect(dependencies.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: expect.objectContaining({
          overtime: expect.objectContaining({ extensionId: 'extension-1' }),
        }),
      }),
    );
    expect(result.status).toBe('ready');
    expect(onProgress.mock.calls.map(([item]) => [item.status, item.phase])).toEqual([
      ['planning', 'outline'],
      ['generating', 'content'],
      ['generating', 'actions'],
      ['generating', 'tts'],
      ['generating', 'commit'],
      ['ready', 'commit'],
    ]);
  });

  it('passes an effective content outline into action generation context', async () => {
    const record = { current: extension() };
    const dependencies = deps(record);
    vi.mocked(dependencies.fetchContent).mockResolvedValue({
      success: true,
      content: { elements: [] },
      effectiveOutline: {
        ...plan.outline,
        title: 'Approach in context',
        id: 'temporary-id',
        order: 99,
      },
    });

    await runOvertimeGeneration({
      extensionId: record.current.id,
      stage,
      scenes: [sourceScene],
      existingOutlines: [],
      knownConcepts: [],
      now: () => 20,
      dependencies,
    });

    expect(dependencies.fetchActions).toHaveBeenCalledWith(
      expect.objectContaining({
        outline: expect.objectContaining({ title: 'Approach in context' }),
        allOutlines: [expect.objectContaining({ title: 'Approach in context' })],
      }),
      undefined,
    );
  });

  it('resumes at TTS when planning, content, and actions checkpoints already exist', async () => {
    const materializedOutline = {
      ...plan.outline,
      id: 'overtime-extension-1',
      order: 2,
    };
    const record = {
      current: extension({
        status: 'interrupted',
        phase: 'tts',
        plan,
        outline: materializedOutline,
        content: { elements: [] },
        scene: generatedScene(),
      }),
    };
    const dependencies = deps(record);

    await runOvertimeGeneration({
      extensionId: record.current.id,
      stage,
      scenes: [sourceScene],
      existingOutlines: [],
      knownConcepts: [],
      now: () => 20,
      dependencies,
    });

    expect(dependencies.requestPlan).not.toHaveBeenCalled();
    expect(dependencies.fetchContent).not.toHaveBeenCalled();
    expect(dependencies.fetchActions).not.toHaveBeenCalled();
    expect(dependencies.generateTTS).toHaveBeenCalledOnce();
    expect(dependencies.commit).toHaveBeenCalledOnce();
  });

  it('keeps the last checkpoint and marks failure without committing a partial page', async () => {
    const record = { current: extension({ plan }) };
    const dependencies = deps(record);
    vi.mocked(dependencies.fetchContent).mockResolvedValue({
      success: false,
      error: 'content failed',
    });

    await expect(
      runOvertimeGeneration({
        extensionId: record.current.id,
        stage,
        scenes: [sourceScene],
        existingOutlines: [],
        knownConcepts: [],
        now: () => 20,
        dependencies,
      }),
    ).rejects.toThrow('content failed');

    expect(dependencies.markFailed).toHaveBeenCalledWith('extension-1', 'content failed', 20);
    expect(dependencies.commit).not.toHaveBeenCalled();
  });

  it('checkpoints completed narration before a failed TTS pass is retried', async () => {
    const record = { current: extension({ plan }) };
    const dependencies = deps(record);
    vi.mocked(dependencies.generateTTS).mockImplementation(async (scene) => {
      scene.actions = [
        { id: 'paid-clip', type: 'speech', text: 'Already narrated', audioId: 'asset-paid' },
      ];
      return { success: false, failedCount: 1, error: 'Next clip failed' };
    });
    await expect(
      runOvertimeGeneration({
        extensionId: record.current.id,
        stage,
        scenes: [sourceScene],
        existingOutlines: [],
        knownConcepts: [],
        dependencies,
        now: () => 20,
      }),
    ).rejects.toThrow('Next clip failed');
    expect(dependencies.checkpoint).toHaveBeenCalledWith(
      'extension-1',
      expect.objectContaining({
        phase: 'tts',
        scene: expect.objectContaining({
          actions: [expect.objectContaining({ audioId: 'asset-paid' })],
        }),
      }),
    );
    expect(dependencies.commit).not.toHaveBeenCalled();
  });

  it('generates media after the durable page is revealed and keeps a committed page ready on media failure', async () => {
    const record = { current: extension({ plan }) };
    const dependencies = deps(record);
    const onReady = vi.fn();
    vi.mocked(dependencies.generateMedia).mockImplementation(async () => {
      expect(record.current.status).toBe('ready');
      expect(onReady).toHaveBeenCalledOnce();
      throw new Error('Image provider unavailable');
    });
    await expect(
      runOvertimeGeneration({
        extensionId: record.current.id,
        stage,
        scenes: [sourceScene],
        existingOutlines: [],
        knownConcepts: [],
        dependencies,
        onReady,
        now: () => 20,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(dependencies.markFailed).not.toHaveBeenCalled();
  });

  it('resumes pending media on an already committed page without repeating paid generation or commit', async () => {
    const readyOutline: SceneOutline = {
      id: 'overtime-extension-1',
      order: 2,
      ...plan.outline,
      mediaGenerations: [{ elementId: 'image-pending', type: 'image', prompt: 'Motion arrows' }],
    };
    const record = {
      current: extension({
        status: 'ready',
        phase: 'commit',
        outline: readyOutline,
        scene: generatedScene(),
      }),
    };
    const dependencies = deps(record);
    dependencies.claim = vi.fn();
    await expect(
      runOvertimeGeneration({
        extensionId: record.current.id,
        stage,
        scenes: [sourceScene],
        existingOutlines: [],
        knownConcepts: [],
        dependencies,
        now: () => 20,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(dependencies.generateMedia).toHaveBeenCalledWith([readyOutline], stage.id, undefined);
    expect(dependencies.claim).not.toHaveBeenCalled();
    expect(dependencies.requestPlan).not.toHaveBeenCalled();
    expect(dependencies.fetchContent).not.toHaveBeenCalled();
    expect(dependencies.fetchActions).not.toHaveBeenCalled();
    expect(dependencies.generateTTS).not.toHaveBeenCalled();
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
});
