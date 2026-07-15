import { describe, expect, it } from 'vitest';

import { buildOvertimePlanPrompt, parseOvertimePlannerResponse } from '@/lib/overtime/planner';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'Go and Come',
  description: 'Basic motion verbs.',
  languageDirective: 'Use Chinese for explanations.',
  createdAt: 1,
  updatedAt: 2,
};

const scenes = [
  {
    id: 'scene-1',
    stageId: stage.id,
    title: 'go 的方向',
    order: 1,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
  },
] as Scene[];

describe('overtime planner prompt', () => {
  it('grounds one-page planning in exact course and concept ids', () => {
    const prompt = buildOvertimePlanPrompt({
      stage,
      scenes,
      request: {
        disposition: 'append_page',
        topic: 'approach 的用法',
        teachingMove: 'extend',
      },
      knownConcepts: [
        {
          conceptId: 'go',
          label: 'go',
          summary: '离开说话者方向的移动。',
          sourceSceneIds: ['scene-1'],
        },
      ],
    });

    expect(prompt.system).toContain('exactly one classroom page');
    expect(prompt.system).toContain('slide, quiz, interactive, or pbl');
    expect(prompt.system).toContain('Quiz pages must not introduce new concepts');
    expect(prompt.user).toContain('scene-1');
    expect(prompt.user).toContain('"conceptId": "go"');
    expect(prompt.user).toContain('approach 的用法');
    expect(`${prompt.system}\n${prompt.user}`).not.toMatch(/\{\{\w[\w-]*\}\}/);
  });

  it('parses fenced JSON through the strict client-safe validator', () => {
    const result = parseOvertimePlannerResponse({
      text: `\n\`\`\`json\n${JSON.stringify({
        outline: {
          type: 'slide',
          title: 'Approach',
          description: 'Introduce approach.',
          keyPoints: ['meaning'],
        },
        sourceSceneIds: ['scene-1'],
        concepts: [{ label: 'approach', summary: 'Move closer.' }],
      })}\n\`\`\``,
      knownSceneIds: new Set(['scene-1']),
      knownConceptIds: new Set(['go']),
    });

    expect(result.outline.type).toBe('slide');
    expect(result.concepts).toEqual([{ kind: 'new', label: 'approach', summary: 'Move closer.' }]);
  });
});
