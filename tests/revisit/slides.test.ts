import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildRevisitSkeletonOutlines,
  createGeneratedRevisitSkeletonScene,
  generateRevisitSkeletonScenes,
} from '@/lib/revisit/slides';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'Fallacies',
  createdAt: 1,
  updatedAt: 1,
  languageDirective: 'zh-CN',
};

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
        transfer: ['spot examples'],
        errorCorrection: ['repair examples'],
      },
      probes: [],
    },
  ],
  skeleton: {
    pages: [
      {
        id: 'page-1',
        title: 'Define it',
        summary: '<p>Teach the <strong>definition</strong> without reading full notes.</p>',
        conceptIds: ['c1'],
        cues: ['real claim', '<em>weaker claim</em>'],
      },
    ],
  },
};

const sourceScenes: Scene[] = [
  {
    id: 'source-scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Source style',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'source-canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#f8fafc',
          themeColors: ['#111827', '#2563eb', '#10b981'],
          fontColor: '#111827',
          fontName: 'Inter',
        },
        background: { type: 'solid', color: '#f8fafc' },
        elements: [],
      },
    },
  },
];

describe('revisit skeleton slide scenes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test('builds sparse slide-content outlines without answer-level detail', () => {
    const outlines = buildRevisitSkeletonOutlines(blueprint);

    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toMatchObject({
      id: 'revisit-page-1',
      type: 'slide',
      title: 'Define it',
      order: 0,
      languageNote: 'zh-CN',
    });
    expect(outlines[0]?.description).toContain('sparse reverse-teaching outline slide');
    expect(outlines[0]?.description).toContain('Do not include full explanations');
    expect(outlines[0]?.keyPoints).toEqual([
      'Teach the definition without reading full notes.',
      'real claim',
      'weaker claim',
    ]);
  });

  test('wraps generated slide content in a revisit scene that inherits source styling', () => {
    const scene = createGeneratedRevisitSkeletonScene({
      stage,
      page: blueprint.skeleton.pages[0],
      order: 0,
      now: 10,
      sourceTheme: {
        backgroundColor: '#123456',
        themeColors: ['#123456', '#abcdef'],
        fontColor: '#111111',
        fontName: 'Aptos',
      },
      content: {
        background: { type: 'solid', color: '#ffffff' },
        elements: [],
      },
    });

    expect(scene).toMatchObject({
      id: 'stage-1:revisit:page-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Define it',
      order: 0,
      createdAt: 10,
      updatedAt: 10,
    });
    if (scene.content.type !== 'slide') throw new Error('expected slide');
    expect(scene.content.canvas.theme).toMatchObject({ backgroundColor: '#123456' });
    expect(scene.content.canvas.background).toEqual({ type: 'solid', color: '#123456' });
  });

  test('generates skeleton slides through the normal scene-content route progressively', async () => {
    const onScene = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { outline: { title: string } };
      return new Response(
        JSON.stringify({
          success: true,
          content: {
            background: { type: 'solid', color: '#ffffff' },
            elements: [
              {
                id: 'generated-title',
                type: 'text',
                left: 0,
                top: 0,
                width: 100,
                height: 20,
                rotate: 0,
                content: `<p>${body.outline.title}</p>`,
              },
            ],
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const scenes = await generateRevisitSkeletonScenes({
      stage,
      blueprint,
      sourceScenes,
      modelConfig: {
        modelString: 'openai:gpt-4.1-mini',
        apiKey: 'key',
        requiresApiKey: true,
      },
      onScene,
      now: 10,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate/scene-content',
      expect.objectContaining({ method: 'POST' }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.outline.description).toContain('sparse reverse-teaching outline slide');
    expect(requestBody.requirements.requirement).toContain('Only title and bullet-like cue');
    expect(requestBody.thinkingConfig).toMatchObject({ mode: 'disabled' });
    expect(requestBody.allOutlines).toHaveLength(1);
    expect(scenes[0]?.id).toBe('stage-1:revisit:page-1');
    const generatedScene = scenes[0];
    if (!generatedScene || generatedScene.content.type !== 'slide') {
      throw new Error('expected generated slide');
    }
    expect(generatedScene.content.canvas.background).toEqual({
      type: 'solid',
      color: '#f8fafc',
    });
    expect(onScene).toHaveBeenCalledWith(scenes[0], 0);
  });

  test('does not call the slide model after the revisit generation is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('superseded attempt', 'AbortError'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateRevisitSkeletonScenes({
        stage,
        blueprint,
        sourceScenes,
        modelConfig: {
          modelString: 'openai:gpt-4.1-mini',
          apiKey: 'key',
          requiresApiKey: true,
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
