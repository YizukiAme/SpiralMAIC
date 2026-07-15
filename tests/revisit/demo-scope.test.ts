import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveRevisitDemoSession,
  clearAllRevisitDemoData,
  clearRevisitDatabase,
  createRevisitDemoSession,
  getLessonProgress,
  getStudyPractice,
  listLessonConcepts,
  listRevisitDemoSessions,
  recordLessonCompleted,
  saveStudyPractice,
  upsertLessonConcepts,
} from '@/lib/revisit/db';
import { demoRevisitScope, FORMAL_REVISIT_SCOPE } from '@/lib/revisit/scope';

describe('revisit demo data scope', () => {
  beforeEach(clearRevisitDatabase);
  afterEach(clearRevisitDatabase);

  it('clones formal Spiral data into an isolated persistent demo database', async () => {
    await recordLessonCompleted('stage-1', 100, FORMAL_REVISIT_SCOPE);
    const session = await createRevisitDemoSession({ id: 'demo-1', createdAt: 200 });
    const demoScope = demoRevisitScope(session.id);

    expect(await getLessonProgress('stage-1', demoScope)).toMatchObject({ completedAt: 100 });

    await recordLessonCompleted('stage-1', 300, demoScope);
    await recordLessonCompleted('stage-2', 301, demoScope);

    expect(await getLessonProgress('stage-2', FORMAL_REVISIT_SCOPE)).toBeUndefined();
    expect(await getLessonProgress('stage-2', demoScope)).toMatchObject({ completedAt: 301 });
  });

  it('archives a demo with a frozen simulated time without deleting its database', async () => {
    await createRevisitDemoSession({ id: 'demo-1', createdAt: 100 });
    await archiveRevisitDemoSession('demo-1', { offsetHours: 24, simulatedAt: 200 });

    const [session] = await listRevisitDemoSessions();
    expect(session).toMatchObject({
      id: 'demo-1',
      status: 'archived',
      offsetHours: 24,
      simulatedAt: 200,
    });
  });

  it('clears every demo database without touching formal learning data', async () => {
    await recordLessonCompleted('formal-stage', 100, FORMAL_REVISIT_SCOPE);
    await createRevisitDemoSession({ id: 'demo-1', createdAt: 200 });
    await recordLessonCompleted('demo-stage', 300, demoRevisitScope('demo-1'));

    await clearAllRevisitDemoData();

    expect(await getLessonProgress('formal-stage', FORMAL_REVISIT_SCOPE)).toMatchObject({
      completedAt: 100,
    });
    expect(await listRevisitDemoSessions()).toEqual([]);
  });

  it('keeps study practice in the demo copy', async () => {
    await createRevisitDemoSession({ id: 'demo-1', createdAt: 200 });
    const scope = demoRevisitScope('demo-1');
    await saveStudyPractice(
      {
        artifactId: 'artifact-1',
        stageId: 'stage-1',
        kind: 'quiz',
        updatedAt: 300,
        answers: { q1: 1 },
        correctItemIds: ['q1'],
      },
      scope,
    );

    expect(await getStudyPractice('artifact-1', FORMAL_REVISIT_SCOPE)).toBeUndefined();
    expect(await getStudyPractice('artifact-1', scope)).toMatchObject({ answers: { q1: 1 } });
  });

  it('clones the lesson concept directory into each demo session', async () => {
    await upsertLessonConcepts([
      {
        stageId: 'stage-1',
        conceptId: 'approach',
        label: 'approach',
        summary: 'Move closer.',
        origin: 'overtime',
        sourceSceneIds: ['scene-overtime'],
        introducedAt: 100,
        learnedAt: 200,
        createdAt: 100,
        updatedAt: 200,
      },
    ]);

    await createRevisitDemoSession({ id: 'demo-1', createdAt: 300 });

    expect(await listLessonConcepts('stage-1', demoRevisitScope('demo-1'))).toEqual([
      expect.objectContaining({ conceptId: 'approach', learnedAt: 200 }),
    ]);
  });
});
