import { describe, expect, it } from 'vitest';

import {
  createFlashcardPractice,
  createQuizPractice,
  recordFlashcardResult,
  scoreStudyQuiz,
} from '@/lib/revisit/study-practice';
import type { StudyArtifactQuizItem } from '@/lib/revisit/types';

describe('study artifact practice state', () => {
  it('moves flashcards between mastered and difficult without memory evidence fields', () => {
    const initial = createFlashcardPractice({
      artifactId: 'artifact-1',
      stageId: 'stage-1',
      now: 10,
    });
    const missed = recordFlashcardResult(initial, 'card-1', false, 20);
    const mastered = recordFlashcardResult(missed, 'card-1', true, 30);

    expect(missed.difficultItemIds).toEqual(['card-1']);
    expect(mastered.masteredItemIds).toEqual(['card-1']);
    expect(mastered.difficultItemIds).toEqual([]);
    expect(mastered).not.toHaveProperty('q');
    expect(mastered).not.toHaveProperty('evidence');
  });

  it('scores only submitted multiple-choice answers and returns wrong ids', () => {
    const items: StudyArtifactQuizItem[] = [
      {
        id: 'q1',
        question: 'One?',
        options: ['A', 'B'],
        answerIndex: 1,
        explanation: 'B',
      },
      {
        id: 'q2',
        question: 'Two?',
        options: ['A', 'B'],
        answerIndex: 0,
        explanation: 'A',
      },
    ];

    expect(scoreStudyQuiz(items, { q1: 1, q2: 1 })).toEqual({
      correctItemIds: ['q1'],
      wrongItemIds: ['q2'],
      correct: 1,
      total: 2,
      percent: 50,
    });
  });

  it('creates quiz progress without Spiral memory fields', () => {
    const practice = createQuizPractice({
      artifactId: 'artifact-2',
      stageId: 'stage-1',
      now: 10,
    });

    expect(practice).toEqual({
      artifactId: 'artifact-2',
      stageId: 'stage-1',
      kind: 'quiz',
      updatedAt: 10,
      answers: {},
      correctItemIds: [],
    });
  });
});
