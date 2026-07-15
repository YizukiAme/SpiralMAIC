import { describe, expect, it } from 'vitest';
import {
  buildOvertimeCourseGenerationSession,
  mergeReadyOvertimePage,
} from '@/lib/overtime/classroom';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const stage = {
  id: 'stage-1',
  name: 'Motion verbs',
  description: 'go and come',
  createdAt: 1,
  updatedAt: 2,
} satisfies Stage;

const scene = {
  id: 'overtime-1',
  stageId: stage.id,
  title: 'Approach',
  type: 'slide',
  order: 3,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
      elements: [],
    },
  },
} satisfies Scene;

const outline = {
  id: scene.id,
  type: 'slide',
  order: scene.order,
  title: scene.title,
  description: 'Move closer.',
  keyPoints: ['meaning'],
} satisfies SceneOutline;

describe('overtime classroom helpers', () => {
  it('merges a committed page idempotently and keeps course order stable', () => {
    const merged = mergeReadyOvertimePage({
      scenes: [{ ...scene, id: 'scene-1', order: 1 }, scene],
      outlines: [{ ...outline, id: 'scene-1', order: 1 }, outline],
      scene,
      outline,
    });

    expect(merged.scenes.map((item) => item.id)).toEqual(['scene-1', 'overtime-1']);
    expect(merged.outlines.map((item) => item.id)).toEqual(['scene-1', 'overtime-1']);
  });

  it('builds a normal generation-preview session with the question and course context', () => {
    const session = buildOvertimeCourseGenerationSession({
      sessionId: 'session-1',
      stage,
      scenes: [scene],
      userPrompt: 'I want a full course about the history of approach.',
      topic: 'the history of approach',
    });

    expect(session.mode).toBe('course');
    expect(session.currentStep).toBe('generating');
    expect(session.requirements.requirement).toContain('Motion verbs');
    expect(session.requirements.requirement).toContain('the history of approach');
    expect(session.requirements.requirement).toContain('Approach');
  });
});
