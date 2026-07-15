import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearRevisitDatabase,
  deleteStudyArtifact,
  getStudyArtifact,
  getStudyPractice,
  listStudyArtifacts,
  renameStudyArtifact,
  saveStudyArtifactNewVersion,
  saveStudyPractice,
} from '@/lib/revisit/db';

describe('study artifact Dexie helpers', () => {
  beforeEach(async () => {
    await clearRevisitDatabase();
  });

  afterEach(async () => {
    await clearRevisitDatabase();
  });

  it('allocates versions transactionally per stage and kind', async () => {
    const first = await saveStudyArtifactNewVersion({
      stageId: 'stage-1',
      kind: 'quiz',
      title: 'Quiz v1',
      stageUpdatedAt: 2,
      language: 'en-US',
      options: {
        focusMode: 'balanced',
        selectedSceneIds: [],
        customInstructions: '',
        count: 10,
        difficulty: 'medium',
        format: 'mcq',
      },
      sourceHash: 'source-1',
      lessonSourceHash: 'lesson-1',
      content: {
        items: [
          {
            id: 'quiz-1',
            question: 'Which part is the predicate?',
            options: ['Cats', 'sleep'],
            answerIndex: 1,
            explanation: 'sleep is the predicate',
            conceptIds: ['subject-vs-predicate'],
            sourceSceneIds: ['scene-2'],
          },
        ],
      },
    });

    const second = await saveStudyArtifactNewVersion({
      ...first,
      title: 'Quiz v2',
      sourceHash: 'source-2',
      lessonSourceHash: 'lesson-2',
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);

    const artifacts = await listStudyArtifacts('stage-1', 'quiz');
    expect(artifacts.map((artifact) => artifact.version)).toEqual([2, 1]);
  });

  it('renames artifacts and cascades delete into study practice', async () => {
    const artifact = await saveStudyArtifactNewVersion({
      stageId: 'stage-1',
      kind: 'flashcards',
      title: 'Flashcards',
      stageUpdatedAt: 2,
      language: 'en-US',
      options: {
        focusMode: 'balanced',
        selectedSceneIds: [],
        customInstructions: '',
        count: 15,
        difficulty: 'medium',
      },
      sourceHash: 'source-1',
      lessonSourceHash: 'lesson-1',
      content: {
        items: [
          {
            id: 'flashcard-1',
            front: 'Subject',
            back: 'The thing the sentence is about.',
            conceptIds: ['subject-vs-predicate'],
            sourceSceneIds: ['scene-1'],
          },
        ],
      },
    });

    await renameStudyArtifact(artifact.id, 'Renamed flashcards');
    const renamed = await getStudyArtifact(artifact.id);
    expect(renamed?.title).toBe('Renamed flashcards');

    await saveStudyPractice({
      artifactId: artifact.id,
      stageId: artifact.stageId,
      kind: 'flashcards',
      updatedAt: 200,
      currentIndex: 0,
      masteredItemIds: [],
      difficultItemIds: ['flashcard-1'],
      completedAt: undefined,
    });
    expect(await getStudyPractice(artifact.id)).toMatchObject({
      artifactId: artifact.id,
      kind: 'flashcards',
    });

    await deleteStudyArtifact(artifact.id);

    expect(await getStudyArtifact(artifact.id)).toBeUndefined();
    expect(await getStudyPractice(artifact.id)).toBeUndefined();
  });

  it('round-trips quiz and flashcard practice states without memory evidence fields', async () => {
    const flashcardArtifact = await saveStudyArtifactNewVersion({
      stageId: 'stage-1',
      kind: 'flashcards',
      title: 'Flashcards',
      stageUpdatedAt: 2,
      language: 'en-US',
      options: {
        focusMode: 'balanced',
        selectedSceneIds: [],
        customInstructions: '',
        count: 15,
        difficulty: 'medium',
      },
      sourceHash: 'source-1',
      lessonSourceHash: 'lesson-1',
      content: {
        items: [
          {
            id: 'flashcard-1',
            front: 'Subject',
            back: 'The thing the sentence is about.',
            conceptIds: ['subject-vs-predicate'],
            sourceSceneIds: ['scene-1'],
          },
        ],
      },
    });
    const quizArtifact = await saveStudyArtifactNewVersion({
      stageId: 'stage-1',
      kind: 'quiz',
      title: 'Quiz',
      stageUpdatedAt: 2,
      language: 'en-US',
      options: {
        focusMode: 'balanced',
        selectedSceneIds: [],
        customInstructions: '',
        count: 10,
        difficulty: 'medium',
        format: 'mcq',
      },
      sourceHash: 'source-2',
      lessonSourceHash: 'lesson-2',
      content: {
        items: [
          {
            id: 'quiz-1',
            question: 'Which part is the predicate?',
            options: ['Cats', 'sleep'],
            answerIndex: 1,
            explanation: 'sleep is the predicate',
            conceptIds: ['subject-vs-predicate'],
            sourceSceneIds: ['scene-2'],
          },
        ],
      },
    });

    await saveStudyPractice({
      artifactId: flashcardArtifact.id,
      stageId: flashcardArtifact.stageId,
      kind: 'flashcards',
      updatedAt: 300,
      currentIndex: 0,
      masteredItemIds: ['flashcard-1'],
      difficultItemIds: [],
      completedAt: 301,
    });
    await saveStudyPractice({
      artifactId: quizArtifact.id,
      stageId: quizArtifact.stageId,
      kind: 'quiz',
      updatedAt: 400,
      answers: { 'quiz-1': 1 },
      correctItemIds: ['quiz-1'],
      completedAt: 401,
    });

    expect(await getStudyPractice(flashcardArtifact.id)).toEqual({
      artifactId: flashcardArtifact.id,
      stageId: flashcardArtifact.stageId,
      kind: 'flashcards',
      updatedAt: 300,
      currentIndex: 0,
      masteredItemIds: ['flashcard-1'],
      difficultItemIds: [],
      completedAt: 301,
    });
    expect(await getStudyPractice(quizArtifact.id)).toEqual({
      artifactId: quizArtifact.id,
      stageId: quizArtifact.stageId,
      kind: 'quiz',
      updatedAt: 400,
      answers: { 'quiz-1': 1 },
      correctItemIds: ['quiz-1'],
      completedAt: 401,
    });
  });
});
