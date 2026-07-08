import { describe, expect, test } from 'vitest';

import { buildRevisitSkeletonScenes } from '@/lib/revisit/slides';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';
import type { Stage } from '@/lib/types/stage';

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

describe('revisit skeleton slide scenes', () => {
  test('turns blueprint skeleton pages into renderable slide scenes without mutating the course', () => {
    const scenes = buildRevisitSkeletonScenes({ stage, blueprint, now: 10 });

    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({
      id: 'stage-1:revisit:page-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Define it',
      order: 0,
      createdAt: 10,
      updatedAt: 10,
    });
    expect(scenes[0]?.content.type).toBe('slide');
    if (scenes[0]?.content.type !== 'slide') return;
    const text = scenes[0].content.canvas.elements
      .map((element) => ('content' in element ? String(element.content) : ''))
      .join('\n');
    expect(text).toContain('Define it');
    expect(text).toContain('Teach the definition');
    expect(text).toContain('real claim');
    expect(text).toContain('weaker claim');
    expect(text).not.toContain('<strong>');
    expect(text).not.toContain('<em>');
  });
});
