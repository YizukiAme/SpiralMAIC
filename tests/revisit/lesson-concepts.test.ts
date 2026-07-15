import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearRevisitDatabase,
  getPendingAssessmentConcepts,
  listLessonConcepts,
  markLessonConceptsLearned,
  recordLessonCompleted,
  saveEvidenceAndUpdateState,
  saveExamBlueprint,
  upsertLessonConcepts,
} from '@/lib/revisit/db';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';

const blueprint: RevisitExamBlueprint = {
  id: 'bp-1',
  stageId: 'stage-1',
  generatedAt: 20,
  language: 'en',
  sourceHash: 'hash',
  concepts: [
    {
      id: 'go',
      label: 'go',
      summary: 'Move away.',
      anchors: { clarity: [], doubtResolution: [], transfer: [], errorCorrection: [] },
      probes: [],
    },
  ],
  skeleton: { pages: [] },
};

describe('lesson concept directory', () => {
  beforeEach(clearRevisitDatabase);
  afterEach(clearRevisitDatabase);

  it('syncs lesson concepts when a blueprint is saved', async () => {
    await recordLessonCompleted('stage-1', 10);
    await saveExamBlueprint(blueprint);

    expect(await listLessonConcepts('stage-1')).toEqual([
      expect.objectContaining({
        conceptId: 'go',
        label: 'go',
        origin: 'lesson',
        introducedAt: 10,
        learnedAt: 10,
      }),
    ]);
  });

  it('records overtime learning only once and exposes it as pending assessment', async () => {
    await upsertLessonConcepts([
      {
        stageId: 'stage-1',
        conceptId: 'approach',
        label: 'approach',
        summary: 'Move closer.',
        origin: 'overtime',
        sourceSceneIds: ['scene-overtime'],
        introducedAt: 20,
        createdAt: 20,
        updatedAt: 20,
      },
    ]);

    await markLessonConceptsLearned('stage-1', ['approach'], 30);
    await markLessonConceptsLearned('stage-1', ['approach'], 40);

    expect(await getPendingAssessmentConcepts('stage-1')).toEqual([
      expect.objectContaining({ conceptId: 'approach', learnedAt: 30 }),
    ]);
  });

  it('starts first judged state from each concept learnedAt', async () => {
    await recordLessonCompleted('stage-1', 10);
    await upsertLessonConcepts([
      {
        stageId: 'stage-1',
        conceptId: 'approach',
        label: 'approach',
        summary: 'Move closer.',
        origin: 'overtime',
        sourceSceneIds: ['scene-overtime'],
        introducedAt: 20,
        learnedAt: 30,
        createdAt: 20,
        updatedAt: 30,
      },
    ]);

    await saveEvidenceAndUpdateState({
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      completedAt: 50,
      summary: 'Good',
      dimensions: { clarity: 0.8, doubtResolution: 0.8, transfer: 0.8, errorCorrection: 0.8 },
      qRaw: 0.8,
      q: 0.8,
      errors: [],
      pageReports: [],
      evidence: [
        {
          id: 'evidence-1',
          attemptId: 'attempt-1',
          stageId: 'stage-1',
          conceptId: 'approach',
          source: 'teach_back',
          scores: { clarity: 0.8, doubtResolution: 0.8, transfer: 0.8, errorCorrection: 0.8 },
          qRaw: 0.8,
          q: 0.8,
          polarity: 'positive',
          timestamp: 50,
          errors: [],
        },
      ],
    });

    expect(await getPendingAssessmentConcepts('stage-1')).toEqual([]);
    const directory = await listLessonConcepts('stage-1');
    expect(directory[0]?.learnedAt).toBe(30);
  });
});
