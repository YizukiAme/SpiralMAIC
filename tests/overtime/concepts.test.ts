import { describe, expect, it } from 'vitest';

import { materializeOvertimePlan } from '@/lib/overtime/concepts';
import type { OvertimeExtension, OvertimePlanDraft } from '@/lib/overtime/types';
import type { LessonConcept } from '@/lib/revisit/types';

const extension = {
  id: 'extension-1',
  stageId: 'stage-1',
  sequence: 2,
  reservedOrder: 5,
  status: 'planning',
  phase: 'outline',
  userPrompt: 'Teach approach.',
  decision: { disposition: 'append_page', topic: 'approach', teachingMove: 'extend' },
  createdAt: 10,
  updatedAt: 10,
} satisfies OvertimeExtension;

const known = {
  stageId: 'stage-1',
  conceptId: 'go',
  label: 'Go',
  summary: 'Move away.',
  origin: 'lesson',
  sourceSceneIds: ['scene-1'],
  introducedAt: 1,
  learnedAt: 2,
  createdAt: 1,
  updatedAt: 2,
} satisfies LessonConcept;

function plan(concepts: OvertimePlanDraft['concepts']): OvertimePlanDraft {
  return {
    outline: {
      type: 'slide',
      title: 'Approach',
      description: 'Move closer.',
      keyPoints: ['meaning'],
    },
    sourceSceneIds: ['scene-1'],
    concepts,
  };
}

describe('overtime concept materialization', () => {
  it('assigns stable page identity and deterministic ids to new concepts', () => {
    const first = materializeOvertimePlan({
      extension,
      plan: plan([{ kind: 'new', label: 'Approach', summary: 'Move closer.' }]),
      knownConcepts: [known],
      now: 20,
    });
    const retry = materializeOvertimePlan({
      extension,
      plan: plan([{ kind: 'new', label: 'Approach', summary: 'Move closer.' }]),
      knownConcepts: [known],
      now: 30,
    });

    expect(first.outline).toMatchObject({ id: 'overtime-extension-1', order: 5 });
    expect(first.conceptIds[0]).toMatch(/^overtime-approach-/);
    expect(retry.conceptIds).toEqual(first.conceptIds);
    expect(first.concepts[0]).toMatchObject({
      origin: 'overtime',
      sourceSceneIds: ['overtime-extension-1'],
    });
    expect(first.concepts[0]).not.toHaveProperty('learnedAt');
  });

  it('exactly reuses normalized labels instead of creating duplicates', () => {
    const result = materializeOvertimePlan({
      extension,
      plan: plan([
        { kind: 'new', label: '  GO ', summary: 'Same concept.' },
        { kind: 'existing', conceptId: 'go' },
      ]),
      knownConcepts: [known],
      now: 20,
    });

    expect(result.conceptIds).toEqual(['go']);
    expect(result.concepts).toEqual([
      expect.objectContaining({ conceptId: 'go', origin: 'lesson' }),
    ]);
  });
});
