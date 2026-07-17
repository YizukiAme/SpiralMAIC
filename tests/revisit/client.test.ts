import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  RevisitExamBlueprint,
  RevisitJudgeReport,
  RevisitPageReport,
  UserConceptState,
} from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const dbMocks = vi.hoisted(() => ({
  countRevisitReports: vi.fn(),
  getConceptStates: vi.fn(),
  getLatestExamBlueprint: vi.fn(),
  getLatestRevisitReport: vi.fn(),
  getRevisitReport: vi.fn(),
  getLessonProgress: vi.fn(),
  getPendingAssessmentConcepts: vi.fn(),
  saveExamBlueprint: vi.fn(),
  saveEvidenceAndUpdateState: vi.fn(),
  saveStudyArtifactNewVersion: vi.fn(),
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
    ...(config.baseUrl ? { 'x-base-url': config.baseUrl } : {}),
    ...(config.providerType ? { 'x-provider-type': config.providerType } : {}),
    ...(config.serviceTier ? { 'x-service-tier': config.serviceTier } : {}),
  }),
}));

import {
  ensureRevisitBlueprint,
  loadLessonMemorySummaries,
  loadRevisitAdaptiveContext,
  generateRevisitStudyArtifact,
  submitRevisitAttempt,
} from '@/lib/revisit/client';

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

const conceptState: UserConceptState = {
  stageId: 'stage-1',
  conceptId: 'c1',
  label: 'Straw man',
  hDays: 4,
  learnedAt: Date.UTC(2026, 6, 1),
  lastRetrievalAt: Date.UTC(2026, 6, 1),
  evidenceCount: 1,
  successChallengeDates: [],
  createdAt: Date.UTC(2026, 6, 1),
  updatedAt: Date.UTC(2026, 6, 1),
};

const judgeReport: RevisitJudgeReport = {
  attemptId: 'attempt-old',
  stageId: 'stage-1',
  completedAt: Date.UTC(2026, 6, 2),
  summary: 'Needs more transfer practice.',
  dimensions: {
    clarity: 0.8,
    doubtResolution: 0.7,
    transfer: 0.4,
    errorCorrection: 0.8,
  },
  qRaw: 0.65,
  q: 0.65,
  errors: [],
  evidence: [],
  pageReports,
};

const baseAttempt = {
  attemptId: 'attempt-1',
  stage,
  blueprint,
  transcript: [],
  pageReports,
  stableSuccessesRequired: 2,
};

describe('revisit client attempt submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    dbMocks.getRevisitReport.mockResolvedValue(undefined);
    dbMocks.getLessonProgress.mockResolvedValue({
      stageId: 'stage-1',
      completedAt: Date.UTC(2026, 6, 1),
      updatedAt: Date.UTC(2026, 6, 1),
    });
  });

  test('returns an existing report without judging or applying memory twice', async () => {
    dbMocks.getRevisitReport.mockResolvedValue(judgeReport);
    vi.stubGlobal('fetch', vi.fn());

    const result = await submitRevisitAttempt({
      ...baseAttempt,
      modelConfig: {
        modelString: 'openai:gpt-4.1-mini',
        apiKey: 'key',
        requiresApiKey: true,
      },
    });

    expect(result).toBe(judgeReport);
    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.saveEvidenceAndUpdateState).not.toHaveBeenCalled();
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

  test('does not judge or count an attempt before the original lesson was completed', async () => {
    dbMocks.getLessonProgress.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      submitRevisitAttempt({
        ...baseAttempt,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: 'key',
          requiresApiKey: true,
        },
      }),
    ).rejects.toThrow(/complete the original lesson/i);

    expect(fetch).not.toHaveBeenCalled();
    expect(dbMocks.saveEvidenceAndUpdateState).not.toHaveBeenCalled();
  });

  test('passes canonical blueprint labels into the successful memory write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, report: judgeReport })),
    );

    await submitRevisitAttempt({
      ...baseAttempt,
      modelConfig: {
        modelString: 'openai:gpt-4.1-mini',
        apiKey: 'key',
        requiresApiKey: true,
        serviceTier: 'priority',
      },
    });

    expect(dbMocks.saveEvidenceAndUpdateState).toHaveBeenCalledWith(
      judgeReport,
      expect.objectContaining({ conceptLabelsById: { c1: 'Straw man' } }),
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get('x-service-tier')).toBe('priority');
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

  test('does not judge or write memory after an attempt is discarded', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('attempt discarded', 'AbortError'));
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      submitRevisitAttempt({
        ...baseAttempt,
        signal: controller.signal,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: 'key',
          requiresApiKey: true,
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

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
    expect(dbMocks.saveExamBlueprint).not.toHaveBeenCalled();
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

    expect(dbMocks.saveExamBlueprint).not.toHaveBeenCalled();
  });

  test('reusing a blueprint does not create concept memory before a judged challenge', async () => {
    dbMocks.getLatestExamBlueprint.mockResolvedValue(blueprint);

    const result = await ensureRevisitBlueprint({ stage, scenes });

    expect(result).toBe(blueprint);
    expect(dbMocks.saveExamBlueprint).not.toHaveBeenCalled();
  });

  test('force-regenerates blueprint with adaptive context instead of reusing old cache', async () => {
    dbMocks.getLatestExamBlueprint.mockResolvedValue(blueprint);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, blueprint })),
    );

    await ensureRevisitBlueprint({
      attemptId: 'attempt-1',
      stage,
      scenes,
      forceRegenerate: true,
      adaptiveContext: {
        completedChallengeCount: 1,
        memorySummary: {
          status: 'review',
          recall: 0.4,
          meanRecall: 0.5,
          minRecall: 0.25,
          color: 'hsl(10 72% 40%)',
        },
        conceptStates: [conceptState],
        latestReport: judgeReport,
      },
      modelConfig: {
        modelString: 'openai:gpt-4.1-mini',
        apiKey: 'key',
        requiresApiKey: true,
        serviceTier: 'priority',
      },
    });

    expect(dbMocks.getLatestExamBlueprint).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.adaptiveContext.latestReport.attemptId).toBe('attempt-old');
    expect(body.adaptiveContext.completedChallengeCount).toBe(1);
    expect(body.adaptiveContext.memorySummary.status).toBe('review');
    expect(body.attemptId).toBe('attempt-1');
    expect(new Headers(init?.headers).get('x-service-tier')).toBe('priority');
    expect(dbMocks.saveExamBlueprint).toHaveBeenCalledWith(blueprint);
  });

  test('passes cancellation to blueprint generation without wrapping the abort', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('superseded attempt', 'AbortError'));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ensureRevisitBlueprint({
        stage,
        scenes,
        signal: controller.signal,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: 'key',
          requiresApiKey: true,
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(dbMocks.saveExamBlueprint).not.toHaveBeenCalled();
  });
});

describe('revisit study artifact generation', () => {
  const artifactDraft = {
    stageId: 'stage-1',
    kind: 'faq' as const,
    title: 'Fallacies FAQ',
    stageUpdatedAt: stage.updatedAt,
    language: 'zh-CN',
    options: {
      focusMode: 'balanced' as const,
      selectedSceneIds: [],
      customInstructions: '',
      count: 10,
    },
    sourceHash: 'source-hash',
    lessonSourceHash: 'lesson-hash',
    content: {
      items: [{ id: 'faq-1', question: '什么是稻草人谬误？', answer: '歪曲原主张后再反驳。' }],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    dbMocks.getConceptStates.mockResolvedValue([]);
    dbMocks.getLatestRevisitReport.mockResolvedValue(undefined);
    dbMocks.countRevisitReports.mockResolvedValue(0);
    dbMocks.getPendingAssessmentConcepts.mockResolvedValue([]);
    dbMocks.getLessonProgress.mockResolvedValue({
      stageId: 'stage-1',
      completedAt: Date.UTC(2026, 6, 1),
      updatedAt: Date.UTC(2026, 6, 1),
    });
  });

  test('persists one complete structured artifact as a new version', async () => {
    const saved = {
      ...artifactDraft,
      id: 'stage-1:faq:v1',
      version: 1,
      createdAt: 100,
      updatedAt: 100,
    };
    dbMocks.saveStudyArtifactNewVersion.mockResolvedValue(saved);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, artifact: artifactDraft })),
    );

    const result = await generateRevisitStudyArtifact({
      jobId: 'job-1',
      stage,
      scenes,
      kind: 'faq',
      options: artifactDraft.options,
      modelConfig: {
        modelString: 'openai:gpt-4.1-mini',
        apiKey: 'key',
        requiresApiKey: true,
        serviceTier: 'priority',
      },
    });

    expect(result).toEqual(saved);
    expect(dbMocks.saveStudyArtifactNewVersion).toHaveBeenCalledWith(artifactDraft);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get('x-service-tier')).toBe('priority');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jobId: 'job-1',
      kind: 'faq',
      options: { count: 10 },
      adaptiveContext: { completedChallengeCount: 0 },
    });
  });

  test('does not save a partial artifact when the singular API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 500 })),
    );

    await expect(
      generateRevisitStudyArtifact({
        stage,
        scenes,
        kind: 'faq',
        options: artifactDraft.options,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: 'key',
          requiresApiKey: true,
        },
      }),
    ).rejects.toThrow(/artifact failed/i);

    expect(dbMocks.saveStudyArtifactNewVersion).not.toHaveBeenCalled();
  });
});

describe('revisit lesson memory summaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.countRevisitReports.mockResolvedValue(0);
    dbMocks.getConceptStates.mockResolvedValue([]);
    dbMocks.getLessonProgress.mockResolvedValue(undefined);
    dbMocks.getPendingAssessmentConcepts.mockResolvedValue([]);
  });

  test('uses lesson completion progress as fresh memory before concept states exist', async () => {
    dbMocks.getLessonProgress.mockResolvedValue({
      stageId: 'stage-1',
      completedAt: Date.UTC(2026, 6, 1),
      updatedAt: Date.UTC(2026, 6, 1),
    });

    const summaries = await loadLessonMemorySummaries(['stage-1'], {
      now: Date.UTC(2026, 6, 1),
      stableSuccessesRequired: 2,
    });

    expect(summaries['stage-1']).toMatchObject({
      status: 'fresh',
      recall: 1,
    });
  });

  test('concept states take priority over lesson completion progress', async () => {
    dbMocks.getConceptStates.mockResolvedValue([conceptState]);
    dbMocks.getLessonProgress.mockResolvedValue({
      stageId: 'stage-1',
      completedAt: Date.UTC(2026, 6, 9),
      updatedAt: Date.UTC(2026, 6, 9),
    });

    const summaries = await loadLessonMemorySummaries(['stage-1'], {
      now: Date.UTC(2026, 6, 5),
      stableSuccessesRequired: 2,
    });

    expect(summaries['stage-1'].recall).toBe(0.5);
    expect(dbMocks.getLessonProgress).not.toHaveBeenCalled();
  });

  test('loads adaptive context for revisit generation', async () => {
    dbMocks.getConceptStates.mockResolvedValue([conceptState]);
    dbMocks.getLatestRevisitReport.mockResolvedValue(judgeReport);
    dbMocks.countRevisitReports.mockResolvedValue(2);
    dbMocks.getPendingAssessmentConcepts.mockResolvedValue([
      {
        stageId: 'stage-1',
        conceptId: 'approach',
        label: 'approach',
        summary: 'Move closer.',
        origin: 'overtime',
        sourceSceneIds: ['scene-overtime'],
        introducedAt: 10,
        learnedAt: 20,
        createdAt: 10,
        updatedAt: 20,
      },
    ]);

    const context = await loadRevisitAdaptiveContext('stage-1', {
      now: Date.UTC(2026, 6, 5),
      stableSuccessesRequired: 2,
    });

    expect(context.conceptStates).toEqual([conceptState]);
    expect(context.latestReport?.attemptId).toBe('attempt-old');
    expect(context.completedChallengeCount).toBe(2);
    expect(context.pendingConcepts?.map((concept) => concept.conceptId)).toEqual(['approach']);
    expect(context.memorySummary.status).toBe('review');
  });
});
