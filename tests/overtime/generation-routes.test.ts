import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  model: vi.fn(),
  content: vi.fn(),
  actions: vi.fn(),
  profiles: vi.fn(),
  callLLM: vi.fn(),
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { query: mocks.query } }),
}));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    req: Request,
    handler: (principal: { ownerId: string }, headers: Headers) => Promise<Response>,
  ) => {
    if (!req.headers.get('x-test-owner')) return new Response('Unauthorized', { status: 401 });
    return handler(
      { ownerId: req.headers.get('x-test-owner')! },
      new Headers({ 'Set-Cookie': 'owner=test' }),
    );
  },
}));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModelFromRequest: mocks.model }));
vi.mock('@/lib/server/generation/steps/scene-content', () => ({
  generateSceneContent: mocks.content,
}));
vi.mock('@/lib/server/generation/steps/scene-actions', () => ({
  generateSceneActions: mocks.actions,
}));
vi.mock('@/lib/server/generation/steps/agent-profiles', () => ({
  generateAgentProfiles: mocks.profiles,
}));

const outline = { id: 'page-1', type: 'slide', title: 'More', order: 1 };
function request(path: string, body: unknown, owner = 'alice') {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-test-owner': owner } : {}) },
    body: JSON.stringify(body),
  });
}

describe('owner-scoped Spiral generation adapters', () => {
  beforeEach(() => {
    vi.stubEnv('ACCESS_CODE', '');
    mocks.query.mockReset().mockResolvedValue({ rows: [{ stage_id: 'stage-1' }] });
    mocks.model.mockReset().mockResolvedValue({ model: {}, serverManaged: true });
    mocks.content
      .mockReset()
      .mockResolvedValue({ content: { elements: [] }, effectiveOutline: outline });
    mocks.actions
      .mockReset()
      .mockResolvedValue({ scene: { id: 'page-1', stageId: 'stage-1' }, previousSpeeches: [] });
    mocks.profiles
      .mockReset()
      .mockResolvedValue([{ role: 'assistant' }, { role: 'student' }, { role: 'student' }]);
    mocks.callLLM.mockReset().mockResolvedValue({
      text: JSON.stringify({
        outline: {
          type: 'slide',
          title: 'Approach',
          description: 'Introduce approach',
          keyPoints: ['meaning'],
        },
        sourceSceneIds: [],
        concepts: [{ label: 'approach', summary: 'Move closer' }],
      }),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('calls the shared content step after verifying the course owner', async () => {
    const { POST } = await import('@/app/api/overtime/scene-content/route');
    const body = {
      stageId: 'stage-1',
      outline,
      allOutlines: [outline],
      languageDirective: 'English',
      requirements: { requirement: 'Sparse cues' },
      thinkingConfig: { mode: 'disabled' },
    };
    const response = await POST(request('/api/overtime/scene-content', body));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe('owner=test');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('owner_id = $2'), [
      'stage-1',
      'alice',
    ]);
    expect(mocks.model).toHaveBeenCalledWith(expect.anything(), body, 'scene-content:slide');
    expect(mocks.content).toHaveBeenCalledWith(
      expect.objectContaining({ outline, requirements: { requirement: 'Sparse cues' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('refuses unauthenticated generation before checking course or model configuration', async () => {
    const { POST } = await import('@/app/api/overtime/scene-content/route');
    const response = await POST(
      request('/api/overtime/scene-content', { stageId: 'stage-1', outline }, ''),
    );
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each(['scene-content', 'scene-actions'])(
    'refuses a foreign or deleted course before %s generation',
    async (step) => {
      mocks.query.mockResolvedValue({ rows: [] });
      const { POST } =
        step === 'scene-content'
          ? await import('@/app/api/overtime/scene-content/route')
          : await import('@/app/api/overtime/scene-actions/route');
      const response = await POST(
        request(`/api/overtime/${step}`, {
          stageId: 'foreign',
          outline,
          allOutlines: [outline],
          content: { elements: [] },
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
      expect(response.headers.get('set-cookie')).toBe('owner=test');
      expect(mocks.model).not.toHaveBeenCalled();
    },
  );

  it('keeps action generation context and the API response contract', async () => {
    const { POST } = await import('@/app/api/overtime/scene-actions/route');
    const body = {
      stageId: 'stage-1',
      outline,
      allOutlines: [outline],
      content: { elements: [] },
      previousSpeeches: ['Earlier'],
    };
    const response = await POST(request('/api/overtime/scene-actions', body));
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      scene: { id: 'page-1' },
      previousSpeeches: [],
    });
    expect(mocks.actions).toHaveBeenCalledWith(
      expect.objectContaining({ previousSpeeches: ['Earlier'] }),
      expect.anything(),
    );
  });

  it('uses Spiral roster mode and refuses a foreign course', async () => {
    const { POST } = await import('@/app/api/revisit/agent-profiles/route');
    const body = {
      stageId: 'stage-1',
      mode: 'spiral',
      stageInfo: { name: 'Course' },
      languageDirective: 'English',
      availableAvatars: ['/a.png'],
    };
    const response = await POST(request('/api/revisit/agent-profiles', body));
    expect(response.status).toBe(200);
    expect(mocks.profiles).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'spiral' }),
      expect.anything(),
    );
    mocks.model.mockClear();
    mocks.query.mockResolvedValue({ rows: [] });
    expect((await POST(request('/api/revisit/agent-profiles', body))).status).toBe(404);
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it('plans only for the course owner and preserves server-managed fallback eligibility', async () => {
    const { POST } = await import('@/app/api/overtime/plan/route');
    const body = {
      stage: { id: 'stage-1', name: 'Course' },
      scenes: [],
      request: { disposition: 'append_page', topic: 'Approach', teachingMove: 'extend' },
    };
    const response = await POST(request('/api/overtime/plan', body));
    expect(response.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.anything(),
      'overtime-outline',
      undefined,
      undefined,
      { serverManaged: true },
    );
    mocks.model.mockClear();
    mocks.query.mockResolvedValue({ rows: [] });
    expect((await POST(request('/api/overtime/plan', body))).status).toBe(404);
    expect(mocks.model).not.toHaveBeenCalled();
  });
});
