import { describe, expect, test, vi } from 'vitest';

import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { ThinkingConfig } from '@/lib/types/provider';

const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

function widgetHtml(type = 'procedural-skill') {
  return `<!DOCTYPE html>
<html>
  <body>
    <script type="application/json" id="widget-config">{"type":"${type}"}</script>
    <main>widget</main>
  </body>
</html>`;
}

function proceduralSkillOutline(): SceneOutline {
  return {
    id: 'scene-widget',
    type: 'interactive',
    title: 'Equipment Safety Check',
    description: 'Practice equipment safety inspection.',
    keyPoints: ['Check state', 'Make a go / stop decision'],
    order: 1,
    widgetType: 'procedural-skill',
    widgetOutline: {
      procedureType: 'inspection',
      task: 'Inspect equipment before operation',
      tools: ['checklist', 'multimeter'],
      steps: ['Power off', 'Measure voltage', 'Decide go or stop'],
      successCriteria: ['Unsafe state is not ignored'],
    },
  };
}

function slideOutline(): SceneOutline {
  return {
    id: 'scene-slide',
    type: 'slide',
    title: 'Safety Overview',
    description: 'Introduce safety checks.',
    keyPoints: ['Power isolation'],
    order: 1,
  };
}

async function callSceneContentRoute({
  providerId,
  outline,
  requestThinkingConfig,
}: {
  providerId: string;
  outline: SceneOutline;
  requestThinkingConfig?: ThinkingConfig;
}) {
  vi.resetModules();
  callLLMMock.mockReset();
  resolveModelFromRequestMock.mockReset();

  resolveModelFromRequestMock.mockResolvedValue({
    model: { provider: `${providerId}.chat`, modelId: providerId === 'glm' ? 'glm-5.1' : 'x' },
    modelInfo: { outputWindow: 4096, capabilities: {} },
    modelString: providerId === 'glm' ? 'glm:glm-5.1' : `${providerId}:x`,
    providerId,
    modelId: providerId === 'glm' ? 'glm-5.1' : 'x',
    apiKey: 'test-key',
    baseUrl: undefined,
    thinkingConfig: requestThinkingConfig,
  });

  callLLMMock.mockImplementation(async () => {
    const callIndex = callLLMMock.mock.calls.length;
    return {
      text:
        outline.type === 'interactive' && callIndex === 1
          ? widgetHtml(outline.widgetType)
          : outline.type === 'interactive'
            ? JSON.stringify({ actions: [] })
            : JSON.stringify({ background: null, elements: [] }),
    };
  });

  const { POST } = await import('@/app/api/generate/scene-content/route');
  await POST({
    json: async () => ({
      outline,
      allOutlines: [outline],
      stageId: 'stage-1',
      thinkingConfig: requestThinkingConfig,
    }),
  } as unknown as Parameters<typeof POST>[0]);

  return callLLMMock.mock.calls.map((call) => call[3] as ThinkingConfig | undefined);
}

describe('widget generation thinking policy', () => {
  test('disables thinking for GLM widget content and widget teacher actions', async () => {
    const thinkingArgs = await callSceneContentRoute({
      providerId: 'glm',
      outline: proceduralSkillOutline(),
      requestThinkingConfig: { mode: 'enabled', enabled: true },
    });

    expect(thinkingArgs).toHaveLength(2);
    expect(thinkingArgs[0]).toEqual({ mode: 'disabled', enabled: false });
    expect(thinkingArgs[1]).toEqual({ mode: 'disabled', enabled: false });
  });

  test('disables thinking for GLM slide scene content even without widget context', async () => {
    const thinkingArgs = await callSceneContentRoute({
      providerId: 'glm',
      outline: slideOutline(),
      requestThinkingConfig: { mode: 'enabled', enabled: true },
    });

    expect(thinkingArgs).toEqual([{ mode: 'disabled', enabled: false }]);
  });

  test('keeps route-level GLM policy active when request thinking config is absent', async () => {
    const thinkingArgs = await callSceneContentRoute({
      providerId: 'glm',
      outline: slideOutline(),
    });

    expect(thinkingArgs).toEqual([{ mode: 'disabled', enabled: false }]);
  });

  test('does not force-disable thinking for non-GLM widget content', async () => {
    const requestThinkingConfig: ThinkingConfig = { mode: 'enabled', enabled: true };
    const thinkingArgs = await callSceneContentRoute({
      providerId: 'deepseek',
      outline: proceduralSkillOutline(),
      requestThinkingConfig,
    });

    expect(thinkingArgs).toEqual([requestThinkingConfig, requestThinkingConfig]);
  });

  test('keeps existing two-argument aiCall mocks compatible', async () => {
    const aiCall: AICallFn = async () => widgetHtml();

    const content = await generateSceneContent(proceduralSkillOutline(), aiCall);

    expect(content).not.toBeNull();
  });
});
