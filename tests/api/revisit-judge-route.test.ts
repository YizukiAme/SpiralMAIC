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

describe('revisit judge route logical session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModelFromRequest.mockResolvedValue({ model: 'model', thinkingConfig: undefined });
    mocks.buildJudgePrompt.mockReturnValue({ system: 'system', user: 'user' });
    mocks.callLLM.mockResolvedValue({ text: '{}' });
    mocks.parseJudgeResponse.mockReturnValue({ attemptId: 'attempt-1' });
  });

  it('resolves the judge model with the persisted attempt identity', async () => {
    const request = new Request('http://localhost/api/revisit/judge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: 'attempt-1',
        stageId: 'stage-1',
        blueprint: { id: 'blueprint-1' },
        transcript: [],
        pageReports: [],
      }),
    });

    const response = await POST(request as NextRequest);

    expect(response.ok).toBe(true);
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      request,
      expect.any(Object),
      'revisit-judge',
      { kind: 'revisit-attempt', id: 'attempt-1' },
    );
  });
});
