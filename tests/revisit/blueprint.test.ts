import { describe, expect, it } from 'vitest';

import { createFallbackBlueprint, normalizeBlueprint } from '@/lib/revisit/blueprint';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'Informal fallacies',
  description: 'A short lesson about reasoning mistakes.',
  createdAt: 0,
  updatedAt: 0,
  languageDirective: 'Deliver the entire course in English.',
};

const scenes: Scene[] = [
  {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Straw man fallacy',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
        elements: [
          {
            id: 'text-1',
            type: 'text',
            content: 'A straw man distorts the opponent claim before attacking it.',
            left: 10,
            top: 10,
            width: 500,
            height: 100,
            defaultFontName: 'Inter',
            defaultColor: '#111',
            rotate: 0,
          },
        ],
      },
    },
  },
];

describe('SpiralMAIC blueprint normalization', () => {
  it('normalizes concepts, probes, and skeleton pages with stable ids', () => {
    const blueprint = normalizeBlueprint(
      {
        language: 'en-US',
        concepts: [
          {
            label: 'Straw man fallacy',
            summary: 'Distorting a claim before attacking it.',
            anchors: {
              clarity: ['Define it'],
              doubtResolution: ['Explain why it is not just disagreement'],
              transfer: ['Identify it in a debate'],
              errorCorrection: ['Correct a fake example'],
            },
            probes: [
              {
                prompt: 'Is every weak counterargument a straw man?',
                kind: 'confusion',
              },
            ],
          },
        ],
        skeleton: {
          pages: [
            {
              title: 'Name the real claim',
              summary: 'Teach the difference between the real claim and distorted claim.',
              conceptLabels: ['Straw man fallacy'],
              cues: ['real claim', 'distorted claim'],
            },
          ],
        },
      },
      { stageId: 'stage-1', generatedAt: Date.UTC(2026, 6, 8), sourceHash: 'abc' },
    );

    expect(blueprint.id).toBe('stage-1:abc');
    expect(blueprint.concepts[0].id).toBe('straw-man-fallacy');
    expect(blueprint.concepts[0].probes[0]).toMatchObject({
      conceptId: 'straw-man-fallacy',
      pageIndex: 0,
      kind: 'confusion',
    });
    expect(blueprint.skeleton.pages[0].conceptIds).toEqual(['straw-man-fallacy']);
  });

  it('creates a local fallback blueprint from existing scenes when generation is unavailable', () => {
    const blueprint = createFallbackBlueprint(stage, scenes, Date.UTC(2026, 6, 8));

    expect(blueprint.stageId).toBe('stage-1');
    expect(blueprint.concepts[0].label).toBe('Straw man fallacy');
    expect(blueprint.skeleton.pages[0]).toMatchObject({
      title: 'Straw man fallacy',
      conceptIds: [blueprint.concepts[0].id],
    });
    expect(blueprint.concepts[0].probes.length).toBeGreaterThanOrEqual(1);
  });
});
