import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildOvertimePlanPrompt: vi.fn(),
  callLLM: vi.fn(),
  parseOvertimePlannerResponse: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/overtime/planner', () => ({
  buildOvertimePlanPrompt: mocks.buildOvertimePlanPrompt,
  parseOvertimePlannerResponse: mocks.parseOvertimePlannerResponse,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

import { POST } from '@/app/api/overtime/plan/route';

const validBody = {
  stage: { id: 'stage-1', name: 'Motion verbs', createdAt: 1, updatedAt: 2 },
  scenes: [
    {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Go',
      order: 1,
      type: 'slide',
      content: { type: 'slide', canvas: { elements: [] } },
    },
  ],
  request: {
    disposition: 'append_page',
    topic: 'approach',
    teachingMove: 'extend',
  },
  knownConcepts: [
    { conceptId: 'go', label: 'go', summary: 'move away', sourceSceneIds: ['scene-1'] },
  ],
};

describe('overtime plan route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: 'openai:gpt-4.1-mini',
      thinkingConfig: undefined,
    });
    mocks.buildOvertimePlanPrompt.mockReturnValue({ system: 'system', user: 'user' });
    mocks.callLLM.mockResolvedValue({ text: '{}' });
    mocks.parseOvertimePlannerResponse.mockReturnValue({
      outline: {
        type: 'slide',
        title: 'Approach',
        description: 'Move closer.',
        keyPoints: ['meaning'],
      },
      sourceSceneIds: ['scene-1'],
      concepts: [{ kind: 'new', label: 'approach', summary: 'Move closer.' }],
    });
  });

  it('uses the dedicated route and validates the model output against supplied ids', async () => {
    const request = new Request('http://localhost/api/overtime/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const response = await POST(request as NextRequest);

    expect(response.ok).toBe(true);
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      request,
      validBody,
      'overtime-outline',
    );
    expect(mocks.buildOvertimePlanPrompt).toHaveBeenCalledWith(validBody);
    expect(mocks.parseOvertimePlannerResponse).toHaveBeenCalledWith({
      text: '{}',
      knownSceneIds: new Set(['scene-1']),
      knownConceptIds: new Set(['go']),
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      plan: expect.objectContaining({ sourceSceneIds: ['scene-1'] }),
    });
  });

  it('rejects malformed requests before calling the model', async () => {
    const request = new Request('http://localhost/api/overtime/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: { id: 'stage-1' }, scenes: [] }),
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(400);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('returns the concrete schema error when the planner response cannot be parsed', async () => {
    mocks.parseOvertimePlannerResponse.mockImplementation(() => {
      throw new Error('Overtime planner returned no concept references.');
    });
    const request = new Request('http://localhost/api/overtime/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: 'PARSE_FAILED',
      error: 'Failed to parse overtime lesson plan',
      details: 'Overtime planner returned no concept references.',
    });
  });

  it('distinguishes an upstream model failure from a schema failure', async () => {
    mocks.callLLM.mockRejectedValue(new Error('provider temporarily unavailable'));
    const request = new Request('http://localhost/api/overtime/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: 'GENERATION_FAILED',
      error: 'Overtime planner model request failed',
      details: 'provider temporarily unavailable',
    });
  });
});
