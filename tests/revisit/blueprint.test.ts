import { describe, expect, it } from 'vitest';

import { normalizeBlueprint } from '@/lib/revisit/blueprint';

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

  it('rejects incomplete blueprint responses instead of inventing a local fallback', () => {
    expect(() =>
      normalizeBlueprint(
        {
          language: 'en-US',
          concepts: [],
          skeleton: { pages: [] },
        },
        { stageId: 'stage-1', generatedAt: Date.UTC(2026, 6, 8), sourceHash: 'abc' },
      ),
    ).toThrow(/no concepts/i);
  });
});
