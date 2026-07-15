import { describe, expect, it, vi } from 'vitest';

import {
  runOvertimeGeneration,
  type OvertimeGenerationDependencies,
} from '@/lib/overtime/generation';
import type { OvertimeExtension, OvertimePlanDraft } from '@/lib/overtime/types';
import type { Scene, Stage } from '@/lib/types/stage';

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
});
