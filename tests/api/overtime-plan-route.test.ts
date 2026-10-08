import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerAuthRequest } from '@/lib/server/identity/types';

const mocks = vi.hoisted(() => ({
  buildOvertimePlanPrompt: vi.fn(),
  callLLM: vi.fn(),
  parseOvertimePlannerResponse: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/overtime/planner', () => ({
  buildOvertimePlanPrompt: mocks.buildOvertimePlanPrompt,
  parseOvertimePlannerResponse: mocks.parseOvertimePlannerResponse,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { query: mocks.query } }),
}));
vi.mock('@/lib/server/identity/resolve', () => ({
  resolveRequestOwner: async (req: OwnerAuthRequest) => {
    const ownerId = req.headers.get('x-test-owner');
    return ownerId
      ? {
          ok: true,
          principal: { ownerId, kind: 'user', roles: new Set(), assurance: 'verified' },
          setCookies: [`owner=${ownerId}`],
        }
      : { ok: false, status: 401, code: 'INVALID_CREDENTIAL' };
  },
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
    vi.stubEnv('ACCESS_CODE', '');
    mocks.query.mockImplementation(async (_sql: string, [stageId, ownerId]: string[]) => ({
      rows: stageId === 'stage-1' && ownerId === 'alice' ? [{ stage_id: stageId }] : [],
    }));
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: 'openai:gpt-4.1-mini',
      thinkingConfig: undefined,
      serverManaged: true,
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
  afterEach(() => vi.unstubAllEnvs());

  it('uses the dedicated route and validates the model output against supplied ids', async () => {
    const request = new Request('http://localhost/api/overtime/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-owner': 'alice' },
      body: JSON.stringify(validBody),
    });

    const response = await POST(request as NextRequest);

    expect(response.ok).toBe(true);
    expect(response.headers.get('set-cookie')).toBe('owner=alice');
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('owner_id = $2 AND deleted_at IS NULL'),
      ['stage-1', 'alice'],
    );
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      request,
      validBody,
      'overtime-outline',
    );
    expect(mocks.buildOvertimePlanPrompt).toHaveBeenCalledWith(validBody);
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.anything(),
      'overtime-outline',
      undefined,
      undefined,
      { serverManaged: true },
    );
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
      headers: { 'Content-Type': 'application/json', 'x-test-owner': 'alice' },
      body: JSON.stringify({ stage: { id: 'stage-1' }, scenes: [] }),
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('returns the concrete schema error when the planner response cannot be parsed', async () => {
    mocks.parseOvertimePlannerResponse.mockImplementation(() => {
      throw new Error('Overtime planner returned no concept references.');
    });
    const request = new Request('http://localhost/api/overtime/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-owner': 'alice' },
      body: JSON.stringify(validBody),
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(422);
    expect(response.headers.get('set-cookie')).toBe('owner=alice');
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
      headers: { 'Content-Type': 'application/json', 'x-test-owner': 'alice' },
      body: JSON.stringify(validBody),
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(502);
    expect(response.headers.get('set-cookie')).toBe('owner=alice');
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: 'GENERATION_FAILED',
      error: 'Overtime planner model request failed',
      details: 'provider temporarily unavailable',
    });
  });

  it.each(['foreign owner', 'deleted course'])(
    'refuses a %s before model or prompt work',
    async (scope) => {
      const ownerId = scope === 'foreign owner' ? 'bob' : 'alice';
      if (scope === 'deleted course') mocks.query.mockResolvedValue({ rows: [] });
      const response = await POST(
        new Request('http://localhost/api/overtime/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-owner': ownerId },
          body: JSON.stringify(validBody),
        }) as NextRequest,
      );
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe('Not found');
      expect(response.headers.get('set-cookie')).toBe(`owner=${ownerId}`);
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining('owner_id = $2 AND deleted_at IS NULL'),
        ['stage-1', ownerId],
      );
      expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
      expect(mocks.buildOvertimePlanPrompt).not.toHaveBeenCalled();
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(mocks.parseOvertimePlannerResponse).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid owner credential before checking the course or spending model tokens', async () => {
    const response = await POST(
      new Request('http://localhost/api/overtime/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }) as NextRequest,
    );
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});
