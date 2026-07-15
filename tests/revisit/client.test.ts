import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { RevisitExamBlueprint, RevisitPageReport } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const dbMocks = vi.hoisted(() => ({
  getConceptStates: vi.fn(),
  getLatestExamBlueprint: vi.fn(),
  getLatestSkeletonDeck: vi.fn(),
  saveBlueprintAndInitializeState: vi.fn(),
  saveEvidenceAndUpdateState: vi.fn(),
  saveSkeletonDeck: vi.fn(),
}));

vi.mock('@/lib/revisit/db', () => dbMocks);

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: vi.fn(() => ({
    modelString: '',
    apiKey: '',
    requiresApiKey: true,
  })),
  buildModelRequestHeaders: (config: Record<string, string | undefined>) => ({
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    ...(config.serviceTier ? { 'x-service-tier': config.serviceTier } : {}),
  }),
}));

import { submitRevisitAttempt } from '@/lib/revisit/client';
import { ensureRevisitBlueprint } from '@/lib/revisit/client';

const stage: Stage = {
  id: 'stage-1',
  name: 'Fallacies',
  createdAt: 1,
  updatedAt: 1,
  languageDirective: 'zh-CN',
};

const scenes: Scene[] = [
  {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Define it',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: [],
          fontColor: '#111111',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  },
];

const blueprint: RevisitExamBlueprint = {
  id: 'bp-1',
  stageId: 'stage-1',
  generatedAt: 1,
  language: 'zh-CN',
  sourceHash: 'hash',
  concepts: [
    {
      id: 'c1',
      label: 'Straw man',
      summary: 'Misrepresenting a claim before attacking it.',
      anchors: {
        clarity: ['define'],
        doubtResolution: ['distinguish'],
        transfer: ['apply'],
        errorCorrection: ['repair'],
      },
      probes: [],
    },
  ],
  skeleton: {
    pages: [
      {
        id: 'page-1',
        title: 'Define it',
        summary: 'Teach the definition.',
        conceptIds: ['c1'],
        cues: ['real claim', 'weaker claim'],
      },
    ],
  },
};

const pageReports: RevisitPageReport[] = [
  {
    pageId: 'page-1',
    pageIndex: 0,
    passed: true,
    probeCount: 1,
    conceptIds: ['c1'],
  },
];

const baseAttempt = {
  attemptId: 'attempt-1',
  stage,
  blueprint,
  transcript: [],
  pageReports,
  stableSuccessesRequired: 2,
  forgettingSpeedMultiplier: 1,
};

describe('revisit client attempt submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test('does not write memory when the judge API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 500 })),
    );

    await expect(
      submitRevisitAttempt({
        ...baseAttempt,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: 'key',
          requiresApiKey: true,
        },
      }),
    ).rejects.toThrow(/judge failed/i);

    expect(dbMocks.saveEvidenceAndUpdateState).not.toHaveBeenCalled();
  });

  test('does not fabricate a memory-writing report when no judge model is available', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      submitRevisitAttempt({
        ...baseAttempt,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: '',
          requiresApiKey: true,
        },
      }),
    ).rejects.toThrow(/judge model/i);

    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.saveEvidenceAndUpdateState).not.toHaveBeenCalled();
  });
});

describe('revisit client blueprint generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    dbMocks.getLatestExamBlueprint.mockResolvedValue(undefined);
  });

  test('does not fabricate a blueprint when no model is available', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      ensureRevisitBlueprint({
        stage,
        scenes,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: '',
          requiresApiKey: true,
        },
      }),
    ).rejects.toThrow(/blueprint model/i);

    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.saveBlueprintAndInitializeState).not.toHaveBeenCalled();
  });

  test('does not save a local fallback blueprint when the API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 500 })),
    );

    await expect(
      ensureRevisitBlueprint({
        stage,
        scenes,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: 'key',
          requiresApiKey: true,
        },
      }),
    ).rejects.toThrow(/blueprint failed/i);

    expect(dbMocks.saveBlueprintAndInitializeState).not.toHaveBeenCalled();
  });
});
