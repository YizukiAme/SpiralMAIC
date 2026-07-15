import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({
    modelString: 'openai/test',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    providerType: 'openai',
  }),
}));

import { requestOvertimePlan } from '@/lib/overtime/generation';
import type { OvertimeExtension } from '@/lib/overtime/types';
import type { Stage } from '@/lib/types/stage';

const stage = { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 1 } satisfies Stage;
const extension = {
  id: 'extension-1',
  stageId: stage.id,
  sequence: 1,
  reservedOrder: 1,
  status: 'planning',
  phase: 'outline',
  userPrompt: 'Teach more.',
  decision: { disposition: 'append_page', topic: 'More', teachingMove: 'extend' },
  createdAt: 1,
  updatedAt: 1,
} satisfies OvertimeExtension;

describe('requestOvertimePlan', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces the actionable API detail instead of the generic wrapper message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: 'Failed to parse overtime lesson plan',
              details: 'Overtime planner returned no concept references.',
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await expect(
      requestOvertimePlan({ stage, scenes: [], extension, knownConcepts: [] }),
    ).rejects.toThrow('Overtime planner returned no concept references.');
  });
});
