import { describe, expect, it } from 'vitest';

import {
  buildOvertimeCourseDigest,
  OVERTIME_COURSE_CONTEXT_MAX_CHARS,
} from '@/lib/overtime/prompt-context';
import type { Scene } from '@/lib/types/stage';

function slide(args: {
  id: string;
  order: number;
  title: string;
  visual: string;
  lecture?: string;
}): Scene {
  return {
    id: args.id,
    stageId: 'stage-1',
    order: args.order,
    title: args.title,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        elements: [{ type: 'text', content: args.visual }],
      },
    },
    actions: args.lecture ? [{ type: 'speech', text: args.lecture }] : [],
  } as Scene;
}

describe('buildOvertimeCourseDigest', () => {
  it('sorts pages by scene order and includes titles, visual points, and lecture summaries', () => {
    const digest = buildOvertimeCourseDigest([
      slide({
        id: 'secret-scene-id-2',
        order: 1,
        title: '什么是谓语',
        visual: '谓语描述主语的动作或状态',
        lecture: '每个完整英语句子都要有谓语动词。',
      }),
      slide({
        id: 'secret-scene-id-1',
        order: 0,
        title: '什么是主语',
        visual: '主语回答谁或什么',
      }),
    ]);

    expect(digest.indexOf('Page 1 | slide | 什么是主语')).toBeLessThan(
      digest.indexOf('Page 2 | slide | 什么是谓语'),
    );
    expect(digest).toContain('主语回答谁或什么');
    expect(digest).toContain('谓语描述主语的动作或状态');
    expect(digest).toContain('每个完整英语句子都要有谓语动词');
    expect(digest).not.toContain('secret-scene-id');
  });

  it('keeps every page title while sharing a fixed detail budget', () => {
    const scenes = Array.from({ length: 30 }, (_, index) =>
      slide({
        id: `scene-${index}`,
        order: index,
        title: `唯一页面标题 ${index + 1}`,
        visual: `页面 ${index + 1} 的画面要点 ${'内容'.repeat(900)}`,
        lecture: `页面 ${index + 1} 的实际讲解 ${'讲解'.repeat(900)}`,
      }),
    );

    const digest = buildOvertimeCourseDigest(scenes);

    expect(digest.length).toBeLessThanOrEqual(OVERTIME_COURSE_CONTEXT_MAX_CHARS);
    for (const scene of scenes) expect(digest).toContain(scene.title);
  });
});
