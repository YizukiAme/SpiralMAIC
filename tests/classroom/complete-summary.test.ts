import { describe, it, expect } from 'vitest';
import { summarizeScenes } from '@/lib/classroom/complete-summary';
import type { Scene, QuizQuestion } from '@/lib/types/stage';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string) => key,
  }),
}));

vi.mock('motion/react', async () => {
  const React = await import('react');
  const motion = new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
          React.createElement(tag, props, children),
    },
  );
  return {
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
    MotionConfig: ({ children }: React.PropsWithChildren) => children,
    motion,
    useReducedMotion: () => true,
  };
});

import { ClassroomCompletePage } from '@/components/scene-renderers/classroom-complete';

function slide(id: string, order: number): Scene {
  return {
    id,
    stageId: 's1',
    type: 'slide',
    title: id,
    order,
    content: { type: 'slide', canvas: {} as never },
  };
}

function quizScene(id: string, order: number, questions: QuizQuestion[]): Scene {
  return {
    id,
    stageId: 's1',
    type: 'quiz',
    title: id,
    order,
    content: { type: 'quiz', questions },
  };
}

function interactive(id: string, order: number): Scene {
  return {
    id,
    stageId: 's1',
    type: 'interactive',
    title: id,
    order,
    content: { type: 'interactive', url: 'about:blank' },
  };
}

const choiceQ = (id: string, answer: string[]): QuizQuestion => ({
  id,
  type: 'single',
  question: id,
  options: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
  answer,
  hasAnswer: true,
  points: 1,
});

describe('summarizeScenes', () => {
  it('counts scenes by type and omits zeros', () => {
    const scenes = [slide('s1', 0), slide('s2', 1), interactive('i1', 2)];
    const result = summarizeScenes(scenes, () => ({}));
    expect(result.countsByType).toEqual({ slide: 2, interactive: 1 });
    expect(result.quiz).toBeNull();
  });

  it('returns null quiz when no quiz scenes exist', () => {
    const result = summarizeScenes([slide('s1', 0)], () => ({}));
    expect(result.quiz).toBeNull();
  });

  it('aggregates quiz answers across multiple quiz scenes', () => {
    const scenes = [
      quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])]),
      quizScene('q2', 1, [choiceQ('qc', ['a'])]),
    ];
    const answers: Record<string, Record<string, string | string[]>> = {
      q1: { qa: 'a', qb: 'a' },
      q2: { qc: 'a' },
    };
    const result = summarizeScenes(scenes, (sceneId) => answers[sceneId] ?? {});
    expect(result.quiz).toEqual({ correct: 2, total: 3, pct: Math.round((2 / 3) * 100) });
    expect(result.countsByType.quiz).toBe(2);
  });

  it('returns null quiz when quiz scenes exist but have no gradeable questions', () => {
    const saOnly = quizScene('q1', 0, [
      {
        id: 'sa',
        type: 'short_answer',
        question: 'x',
        answer: [],
        hasAnswer: false,
      },
    ]);
    const result = summarizeScenes([saOnly], () => ({}));
    expect(result.quiz).toBeNull();
    expect(result.countsByType.quiz).toBe(1);
  });

  it('treats missing answers as incorrect (not skipped)', () => {
    const scenes = [quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])])];
    const result = summarizeScenes(scenes, () => ({}));
    expect(result.quiz).toEqual({ correct: 0, total: 2, pct: 0 });
  });
});

describe('Classroom completion action', () => {
  it.each([
    ['ready', 'Continue', false, false],
    ['loading', 'Generating report', true, false],
    ['error', 'Retry report', false, true],
  ] as const)('renders the %s action in place', (state, label, disabled, hasAlert) => {
    const html = renderToStaticMarkup(
      createElement(ClassroomCompletePage, {
        scenes: [],
        title: 'Course',
        completionAction: {
          state,
          title: 'Challenge report',
          description: 'Generate the report here.',
          label,
          errorMessage: state === 'error' ? 'Try again.' : undefined,
          onAction: () => {},
        },
      }),
    );

    expect(html).toContain('data-completion-action');
    expect(html).toContain('Challenge report');
    expect(html).toContain('Generate the report here.');
    expect(html).toContain(label);
    expect(html.includes('disabled=""')).toBe(disabled);
    expect(html.includes('role="alert"')).toBe(hasAlert);
    if (state === 'loading') {
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('motion-safe:animate-spin');
    }
  });

  it('keeps the ordinary completion page unchanged when no action is supplied', () => {
    const html = renderToStaticMarkup(
      createElement(ClassroomCompletePage, { scenes: [], title: 'Course' }),
    );

    expect(html).not.toContain('data-completion-action');
  });

  it('uses a plain scroll root with a min-height centering wrapper for tall content', () => {
    const html = renderToStaticMarkup(
      createElement(ClassroomCompletePage, {
        scenes: [],
        title: 'Course',
        completionAction: {
          state: 'ready',
          title: 'Challenge report',
          description: 'Generate the report here.',
          label: 'Continue',
          onAction: () => {},
        },
      }),
    );

    expect(html).toContain('class="absolute inset-0 z-[105] overflow-auto"');
    expect(html).toContain('class="relative flex min-h-full');
    expect(html).not.toContain(
      'class="absolute inset-0 z-[105] flex items-center justify-center overflow-auto"',
    );
  });
});
