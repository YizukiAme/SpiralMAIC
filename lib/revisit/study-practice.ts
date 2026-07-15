import type {
  FlashcardsStudyPracticeState,
  QuizStudyPracticeState,
  StudyArtifactQuizItem,
} from '@/lib/revisit/types';

export function createFlashcardPractice(args: {
  artifactId: string;
  stageId: string;
  now?: number;
}): FlashcardsStudyPracticeState {
  return {
    artifactId: args.artifactId,
    stageId: args.stageId,
    kind: 'flashcards',
    updatedAt: args.now ?? Date.now(),
    currentIndex: 0,
    masteredItemIds: [],
    difficultItemIds: [],
  };
}

export function recordFlashcardResult(
  practice: FlashcardsStudyPracticeState,
  itemId: string,
  mastered: boolean,
  now = Date.now(),
): FlashcardsStudyPracticeState {
  const masteredIds = new Set(practice.masteredItemIds);
  const difficultIds = new Set(practice.difficultItemIds);
  if (mastered) {
    masteredIds.add(itemId);
    difficultIds.delete(itemId);
  } else {
    difficultIds.add(itemId);
    masteredIds.delete(itemId);
  }
  return {
    ...practice,
    updatedAt: now,
    masteredItemIds: [...masteredIds],
    difficultItemIds: [...difficultIds],
  };
}

export function createQuizPractice(args: {
  artifactId: string;
  stageId: string;
  now?: number;
}): QuizStudyPracticeState {
  return {
    artifactId: args.artifactId,
    stageId: args.stageId,
    kind: 'quiz',
    updatedAt: args.now ?? Date.now(),
    answers: {},
    correctItemIds: [],
  };
}

export function scoreStudyQuiz(
  items: StudyArtifactQuizItem[],
  answers: Record<string, number>,
): {
  correctItemIds: string[];
  wrongItemIds: string[];
  correct: number;
  total: number;
  percent: number;
} {
  const correctItemIds: string[] = [];
  const wrongItemIds: string[] = [];
  for (const item of items) {
    if (answers[item.id] === item.answerIndex) correctItemIds.push(item.id);
    else wrongItemIds.push(item.id);
  }
  return {
    correctItemIds,
    wrongItemIds,
    correct: correctItemIds.length,
    total: items.length,
    percent: items.length === 0 ? 0 : Math.round((correctItemIds.length / items.length) * 100),
  };
}
