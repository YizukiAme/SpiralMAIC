import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildJudgePrompt: vi.fn(),
  callLLM: vi.fn(),
  parseJudgeResponse: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/revisit/prompt-builders', () => ({
  buildJudgePrompt: mocks.buildJudgePrompt,
  parseJudgeResponse: mocks.parseJudgeResponse,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

import { POST } from '@/app/api/revisit/judge/route';

const validBody = {
  attemptId: 'attempt-1',
  stageId: 'stage-1',
  blueprint: {
    id: 'blueprint-1',
    stageId: 'stage-1',
    generatedAt: 1,
    language: 'en',
    sourceHash: 'source-1',
    concepts: [
      {
        id: 'concept-1',
        label: 'Concept one',
        summary: 'A complete concept summary.',
        anchors: {
          clarity: ['Explain the concept clearly.'],
          doubtResolution: ['Resolve a likely confusion.'],
          transfer: ['Apply the concept in a new setting.'],
          errorCorrection: ['Correct a likely misconception.'],
        },
        probes: [
          {
            id: 'probe-1',
            conceptId: 'concept-1',
            pageIndex: 0,
            kind: 'transfer',
            prompt: 'Apply the concept to a new example.',
          },
        ],
      },
    ],
    skeleton: {
      pages: [
        {
          id: 'page-1',
          title: 'Concept one review',
          summary: 'Review the first concept.',
          conceptIds: ['concept-1'],
          cues: ['Explain the core relationship.'],
        },
      ],
    },
  },
  transcript: [
    {
      id: 'message-1',
      role: 'teacher',
      text: 'A trusted explanation.',
      createdAt: 1,
    },
  ],
  pageReports: [
    {
      pageId: 'page-1',
      pageIndex: 0,
      passed: true,
      probeCount: 1,
      conceptIds: ['concept-1'],
    },
  ],
};

const secondConcept = {
  ...validBody.blueprint.concepts[0],
  id: 'concept-2',
  label: 'Concept two',
  probes: [
    {
      ...validBody.blueprint.concepts[0].probes[0],
      id: 'probe-2',
      conceptId: 'concept-2',
      pageIndex: 1,
    },
  ],
};

const secondPage = {
  ...validBody.blueprint.skeleton.pages[0],
  id: 'page-2',
  title: 'Concept two review',
  conceptIds: ['concept-2'],
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/revisit/judge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('revisit judge route logical session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: 'model',
      thinkingConfig: { enabled: true, budgetTokens: 8000 },
    });
    mocks.buildJudgePrompt.mockReturnValue({ system: 'system', user: 'user' });
    mocks.callLLM.mockResolvedValue({ text: '{}' });
    mocks.parseJudgeResponse.mockReturnValue({ attemptId: 'attempt-1' });
  });

  it('resolves the judge model with the persisted attempt identity', async () => {
    const request = makeRequest(validBody);

    const response = await POST(request as NextRequest);

    expect(response.ok).toBe(true);
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      request,
      expect.any(Object),
      'revisit-judge',
      { kind: 'revisit-attempt', id: 'attempt-1' },
    );
    expect(mocks.parseJudgeResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: validBody.transcript,
        pageReports: validBody.pageReports,
      }),
    );
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model', system: 'system', prompt: 'user' }),
      'revisit-judge',
      undefined,
      { enabled: true, budgetTokens: 8000 },
    );
  });

  it('accepts empty and duplicate cue strings allowed by the blueprint DTO', async () => {
    const response = await POST(
      makeRequest({
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          skeleton: {
            pages: [
              {
                ...validBody.blueprint.skeleton.pages[0],
                cues: ['', 'Repeated cue', 'Repeated cue'],
              },
            ],
          },
        },
      }) as NextRequest,
    );

    expect(response.ok).toBe(true);
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledOnce();
    expect(mocks.buildJudgePrompt).toHaveBeenCalledOnce();
    expect(mocks.callLLM).toHaveBeenCalledOnce();
    expect(mocks.parseJudgeResponse).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'missing transcript',
      body: { ...validBody, transcript: undefined },
    },
    {
      label: 'non-array transcript',
      body: { ...validBody, transcript: {} },
    },
    {
      label: 'empty transcript id',
      body: {
        ...validBody,
        transcript: [{ ...validBody.transcript[0], id: ' ' }],
      },
    },
    {
      label: 'non-string transcript text',
      body: {
        ...validBody,
        transcript: [{ ...validBody.transcript[0], text: 42 }],
      },
    },
    {
      label: 'unknown transcript role',
      body: {
        ...validBody,
        transcript: [{ ...validBody.transcript[0], role: 'system' }],
      },
    },
    {
      label: 'invalid transcript creation time',
      body: {
        ...validBody,
        transcript: [{ ...validBody.transcript[0], createdAt: '1' }],
      },
    },
    {
      label: 'non-string optional transcript agent metadata',
      body: {
        ...validBody,
        transcript: [{ ...validBody.transcript[0], agentName: 42 }],
      },
    },
    {
      label: 'missing page reports',
      body: { ...validBody, pageReports: undefined },
    },
    {
      label: 'non-array page reports',
      body: { ...validBody, pageReports: {} },
    },
    {
      label: 'empty page id',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], pageId: '' }],
      },
    },
    {
      label: 'non-integer page index',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], pageIndex: 0.5 }],
      },
    },
    {
      label: 'negative page index',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], pageIndex: -1 }],
      },
    },
    {
      label: 'non-integer probe count',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], probeCount: 1.5 }],
      },
    },
    {
      label: 'negative probe count',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], probeCount: -1 }],
      },
    },
    {
      label: 'non-boolean pass state',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], passed: 'true' }],
      },
    },
    {
      label: 'non-array concept ids',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], conceptIds: 'concept-1' }],
      },
    },
    {
      label: 'non-string concept id',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], conceptIds: ['concept-1', 2] }],
      },
    },
    {
      label: 'blank concept id',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], conceptIds: ['concept-1', ' '] }],
      },
    },
    {
      label: 'non-string page report notes',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], notes: 42 }],
      },
    },
    {
      label: 'blank attempt id',
      body: { ...validBody, attemptId: ' ' },
    },
    {
      label: 'non-string attempt id',
      body: { ...validBody, attemptId: 42 },
    },
    {
      label: 'blank stage id',
      body: { ...validBody, stageId: ' ' },
    },
    {
      label: 'non-string stage id',
      body: { ...validBody, stageId: 42 },
    },
    {
      label: 'non-finite completion time',
      body: { ...validBody, completedAt: Number.NaN },
    },
    {
      label: 'blank blueprint id',
      body: { ...validBody, blueprint: { ...validBody.blueprint, id: ' ' } },
    },
    {
      label: 'mismatched blueprint stage id',
      body: { ...validBody, blueprint: { ...validBody.blueprint, stageId: 'other-stage' } },
    },
    {
      label: 'invalid blueprint generation time',
      body: { ...validBody, blueprint: { ...validBody.blueprint, generatedAt: '1' } },
    },
    {
      label: 'blank blueprint language',
      body: { ...validBody, blueprint: { ...validBody.blueprint, language: ' ' } },
    },
    {
      label: 'blank blueprint source hash',
      body: { ...validBody, blueprint: { ...validBody.blueprint, sourceHash: ' ' } },
    },
    {
      label: 'empty blueprint concepts',
      body: { ...validBody, blueprint: { ...validBody.blueprint, concepts: [] } },
    },
    {
      label: 'duplicate blueprint concept ids',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          concepts: [validBody.blueprint.concepts[0], validBody.blueprint.concepts[0]],
        },
      },
    },
    {
      label: 'incomplete blueprint concept anchors',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          concepts: [
            {
              ...validBody.blueprint.concepts[0],
              anchors: { ...validBody.blueprint.concepts[0].anchors, clarity: [] },
            },
          ],
        },
      },
    },
    {
      label: 'empty blueprint concept probes',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          concepts: [{ ...validBody.blueprint.concepts[0], probes: [] }],
        },
      },
    },
    {
      label: 'probe bound to another concept',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          concepts: [
            {
              ...validBody.blueprint.concepts[0],
              probes: [
                { ...validBody.blueprint.concepts[0].probes[0], conceptId: 'other-concept' },
              ],
            },
          ],
        },
      },
    },
    {
      label: 'empty skeleton pages',
      body: {
        ...validBody,
        blueprint: { ...validBody.blueprint, skeleton: { pages: [] } },
      },
    },
    {
      label: 'duplicate skeleton page ids',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          skeleton: {
            pages: [validBody.blueprint.skeleton.pages[0], validBody.blueprint.skeleton.pages[0]],
          },
        },
      },
    },
    {
      label: 'non-string skeleton page cue',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          skeleton: {
            pages: [{ ...validBody.blueprint.skeleton.pages[0], cues: [42] }],
          },
        },
      },
    },
    {
      label: 'unknown skeleton page concept id',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          skeleton: {
            pages: [{ ...validBody.blueprint.skeleton.pages[0], conceptIds: ['missing-concept'] }],
          },
        },
      },
    },
    {
      label: 'empty skeleton page concept ids',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          skeleton: {
            pages: [{ ...validBody.blueprint.skeleton.pages[0], conceptIds: [] }],
          },
        },
        pageReports: [],
      },
    },
    {
      label: 'duplicate skeleton page concept ids',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          skeleton: {
            pages: [
              {
                ...validBody.blueprint.skeleton.pages[0],
                conceptIds: ['concept-1', 'concept-1'],
              },
            ],
          },
        },
        pageReports: [],
      },
    },
    {
      label: 'duplicate transcript ids',
      body: {
        ...validBody,
        transcript: [validBody.transcript[0], validBody.transcript[0]],
      },
    },
    {
      label: 'duplicate page report ids',
      body: {
        ...validBody,
        pageReports: [validBody.pageReports[0], validBody.pageReports[0]],
      },
    },
    {
      label: 'page report for an unknown blueprint page',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], pageId: 'missing-page' }],
      },
    },
    {
      label: 'page report with a mismatched blueprint page index',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], pageIndex: 1 }],
      },
    },
    {
      label: 'page report with no concept ids',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], conceptIds: [] }],
      },
    },
    {
      label: 'page report with duplicate concept ids',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], conceptIds: ['concept-1', 'concept-1'] }],
      },
    },
    {
      label: 'page report with an unknown blueprint concept id',
      body: {
        ...validBody,
        pageReports: [{ ...validBody.pageReports[0], conceptIds: ['missing-concept'] }],
      },
    },
    {
      label: 'page report concept id bound to another blueprint page',
      body: {
        ...validBody,
        blueprint: {
          ...validBody.blueprint,
          concepts: [...validBody.blueprint.concepts, secondConcept],
          skeleton: {
            pages: [...validBody.blueprint.skeleton.pages, secondPage],
          },
        },
        pageReports: [{ ...validBody.pageReports[0], conceptIds: ['concept-2'] }],
      },
    },
  ])('rejects $label before resolving or calling a model', async ({ body }) => {
    const response = await POST(makeRequest(body) as NextRequest);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.buildJudgePrompt).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.parseJudgeResponse).not.toHaveBeenCalled();
  });
});
