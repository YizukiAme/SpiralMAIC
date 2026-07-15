import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildBlueprintPrompt: vi.fn(),
  callLLM: vi.fn(),
  parseBlueprintResponse: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/revisit/prompt-builders', () => ({
  buildBlueprintPrompt: mocks.buildBlueprintPrompt,
  parseBlueprintResponse: mocks.parseBlueprintResponse,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

import { POST } from '@/app/api/revisit/blueprint/route';

describe('revisit blueprint route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: 'openai:gpt-4.1-mini',
      thinkingConfig: undefined,
    });
    mocks.buildBlueprintPrompt.mockReturnValue({
      system: 'system',
      user: 'user',
      sourceHash: 'hash',
    });
    mocks.callLLM.mockResolvedValue({ text: '{}' });
    mocks.parseBlueprintResponse.mockReturnValue({ id: 'bp-1' });
  });

  it('passes completed challenge history into prompt construction', async () => {
    const adaptiveContext = {
      completedChallengeCount: 2,
      memorySummary: {
        status: 'review',
        recall: 0.4,
        meanRecall: 0.5,
        minRecall: 0.25,
        color: 'hsl(10 72% 40%)',
      },
      conceptStates: [{ conceptId: 'straw-man', label: 'Straw man fallacy' }],
      pendingConcepts: [
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
      ],
    };
    const request = new Request('http://localhost/api/revisit/blueprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: { id: 'stage-1', name: 'Fallacies', createdAt: 1, updatedAt: 1 },
        scenes: [],
        targetProbeCount: 4,
        adaptiveContext,
      }),
    });

    const response = await POST(request as NextRequest);

    expect(response.ok).toBe(true);
    expect(mocks.buildBlueprintPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ adaptiveContext }),
    );
    expect(mocks.parseBlueprintResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalConcepts: [
          { id: 'straw-man', label: 'Straw man fallacy' },
          { id: 'approach', label: 'approach' },
        ],
        requiredConceptIds: ['approach'],
      }),
    );
  });
});
