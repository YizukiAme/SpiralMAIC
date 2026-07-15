import { describe, expect, it } from 'vitest';

import { parseOvertimePlanDraft, parseRequestLearningExtensionParams } from '@/lib/overtime/types';

const baseOutline = {
  type: 'slide',
  title: 'Approach 的用法',
  description: '解释 approach 作为动词时的核心用法。',
  keyPoints: ['基本含义', '与 come 的区别', '一个真实例句'],
  teachingObjective: '能够使用 approach 描述逐渐接近。',
  estimatedDuration: 90,
};

const context = {
  knownSceneIds: new Set(['scene-1', 'scene-2']),
  knownConceptIds: new Set(['go', 'come']),
};

describe('parseRequestLearningExtensionParams', () => {
  it('accepts a valid one-page extension decision', () => {
    expect(
      parseRequestLearningExtensionParams({
        disposition: 'append_page',
        topic: 'approach 的动词用法',
        teachingMove: 'extend',
      }),
    ).toEqual({
      disposition: 'append_page',
      topic: 'approach 的动词用法',
      teachingMove: 'extend',
    });
  });

  it('rejects unknown teaching moves and empty topics', () => {
    expect(
      parseRequestLearningExtensionParams({
        disposition: 'append_page',
        topic: '',
        teachingMove: 'chat',
      }),
    ).toBeNull();
  });
});

describe('parseOvertimePlanDraft', () => {
  it('accepts a slide with exact source ids and a new concept declaration', () => {
    expect(
      parseOvertimePlanDraft(
        {
          outline: baseOutline,
          sourceSceneIds: ['scene-1'],
          concepts: [
            {
              label: 'approach',
              summary: '表示逐渐靠近某人、某物或某个时间点。',
            },
          ],
        },
        context,
      ),
    ).toMatchObject({
      outline: { type: 'slide', title: 'Approach 的用法' },
      sourceSceneIds: ['scene-1'],
      concepts: [{ kind: 'new', label: 'approach' }],
    });
  });

  it('accepts a quiz only when it references existing concepts', () => {
    expect(
      parseOvertimePlanDraft(
        {
          outline: {
            ...baseOutline,
            type: 'quiz',
            quizConfig: {
              questionCount: 3,
              difficulty: 'medium',
              questionTypes: ['single'],
            },
          },
          sourceSceneIds: ['scene-2'],
          concepts: [{ existingConceptId: 'come' }],
        },
        context,
      ).concepts,
    ).toEqual([{ kind: 'existing', conceptId: 'come' }]);
  });

  it('rejects a quiz that tries to introduce a new concept', () => {
    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: {
            ...baseOutline,
            type: 'quiz',
            quizConfig: {
              questionCount: 3,
              difficulty: 'medium',
              questionTypes: ['single'],
            },
          },
          sourceSceneIds: ['scene-1'],
          concepts: [{ label: 'approach', summary: '表示靠近。' }],
        },
        context,
      ),
    ).toThrow(/quiz.*new concept/i);
  });

  it('requires complete interactive and PBL configuration', () => {
    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: { ...baseOutline, type: 'interactive' },
          sourceSceneIds: ['scene-1'],
          concepts: [{ existingConceptId: 'go' }],
        },
        context,
      ),
    ).toThrow(/interactive/i);

    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: { ...baseOutline, type: 'pbl' },
          sourceSceneIds: ['scene-1'],
          concepts: [{ existingConceptId: 'go' }],
        },
        context,
      ),
    ).toThrow(/pbl/i);
  });

  it('accepts a complete type-specific interactive configuration', () => {
    const result = parseOvertimePlanDraft(
      {
        outline: {
          ...baseOutline,
          type: 'interactive',
          widgetType: 'simulation',
          widgetOutline: {
            concept: 'Motion direction',
            keyVariables: ['speaker position', 'destination'],
          },
        },
        sourceSceneIds: ['scene-1'],
        concepts: [{ existingConceptId: 'go' }],
      },
      context,
    );

    expect(result.outline).toMatchObject({
      type: 'interactive',
      widgetType: 'simulation',
      widgetOutline: { keyVariables: ['speaker position', 'destination'] },
    });
  });

  it('rejects an empty or mismatched interactive configuration', () => {
    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: {
            ...baseOutline,
            type: 'interactive',
            widgetType: 'simulation',
            widgetOutline: {},
          },
          sourceSceneIds: ['scene-1'],
          concepts: [{ existingConceptId: 'go' }],
        },
        context,
      ),
    ).toThrow(/interactive/i);

    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: {
            ...baseOutline,
            type: 'interactive',
            widgetType: 'code',
            widgetOutline: { diagramType: 'flowchart' },
          },
          sourceSceneIds: ['scene-1'],
          concepts: [{ existingConceptId: 'go' }],
        },
        context,
      ),
    ).toThrow(/interactive/i);
  });

  it('rejects vocational procedural widgets that would be silently downgraded', () => {
    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: {
            ...baseOutline,
            type: 'interactive',
            widgetType: 'procedural-skill',
            widgetOutline: {
              task: 'Inspect a motor',
              steps: ['Power off'],
              successCriteria: ['Safe isolation'],
            },
          },
          sourceSceneIds: ['scene-1'],
          concepts: [{ existingConceptId: 'go' }],
        },
        context,
      ),
    ).toThrow(/interactive/i);
  });

  it('rejects invented source and existing concept ids', () => {
    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: baseOutline,
          sourceSceneIds: ['invented-scene'],
          concepts: [{ existingConceptId: 'invented-concept' }],
        },
        context,
      ),
    ).toThrow(/source scene/i);

    expect(() =>
      parseOvertimePlanDraft(
        {
          outline: baseOutline,
          sourceSceneIds: ['scene-1'],
          concepts: [{ existingConceptId: 'invented-concept' }],
        },
        context,
      ),
    ).toThrow(/concept id/i);
  });
});
