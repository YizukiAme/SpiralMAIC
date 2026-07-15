import { describe, expect, it } from 'vitest';

import { mergeLessonCompletionProgress } from '@/lib/revisit/db';
import {
  DEMO_RELAXED_COMPLETION_END_MS,
  DEMO_RELAXED_COMPLETION_START_MS,
  shouldRecordLessonPlaybackCompletion,
} from '@/lib/revisit/progress';

describe('SpiralMAIC lesson progress', () => {
  it('records lesson completion and never moves completedAt backwards', async () => {
    const initial = mergeLessonCompletionProgress(undefined, 'stage-1', 2000, 2000);
    const repeated = mergeLessonCompletionProgress(initial, 'stage-1', 1000, 3000);

    expect(repeated).toMatchObject({
      stageId: 'stage-1',
      completedAt: 2000,
      updatedAt: 3000,
    });

    const replayedLater = mergeLessonCompletionProgress(repeated, 'stage-1', 5000, 5000);
    expect(replayedLater.completedAt).toBe(2000);
    expect(replayedLater.updatedAt).toBe(5000);
  });

  it('records only when real playback finishes the last scene of a complete normal lesson', () => {
    const completedLesson = {
      sceneIds: ['scene-1', 'scene-2'],
      completedSceneIds: ['scene-1', 'scene-2'],
      reachedCourseEnd: true,
      materializedSceneCount: 2,
      outlineCount: 2,
      generatingOutlineCount: 0,
      generationComplete: false,
      isRevisit: false,
      // Pin outside the demo window so the strict semantics are exercised.
      now: DEMO_RELAXED_COMPLETION_END_MS,
    };

    expect(shouldRecordLessonPlaybackCompletion(completedLesson)).toBe(true);
    expect(
      shouldRecordLessonPlaybackCompletion({ ...completedLesson, reachedCourseEnd: false }),
    ).toBe(false);
    expect(
      shouldRecordLessonPlaybackCompletion({
        ...completedLesson,
        completedSceneIds: ['scene-2'],
      }),
    ).toBe(false);
    expect(
      shouldRecordLessonPlaybackCompletion({ ...completedLesson, generatingOutlineCount: 1 }),
    ).toBe(false);
    expect(shouldRecordLessonPlaybackCompletion({ ...completedLesson, isRevisit: true })).toBe(
      false,
    );
  });

  it('demo window (2026-07-10 → 2026-07-21 Beijing time) records on reaching the completion page', () => {
    const skippedPlayback = {
      sceneIds: ['scene-1', 'scene-2'],
      completedSceneIds: [] as string[],
      reachedCourseEnd: true,
      materializedSceneCount: 2,
      outlineCount: 2,
      generatingOutlineCount: 0,
      generationComplete: false,
      isRevisit: false,
      now: DEMO_RELAXED_COMPLETION_START_MS,
    };

    // Inside the window: reaching the end of a fully materialized lesson is enough.
    expect(shouldRecordLessonPlaybackCompletion(skippedPlayback)).toBe(true);
    expect(
      shouldRecordLessonPlaybackCompletion({
        ...skippedPlayback,
        now: DEMO_RELAXED_COMPLETION_END_MS - 1,
      }),
    ).toBe(true);

    // Still requires actually reaching the end of a complete lesson.
    expect(
      shouldRecordLessonPlaybackCompletion({ ...skippedPlayback, reachedCourseEnd: false }),
    ).toBe(false);
    expect(
      shouldRecordLessonPlaybackCompletion({ ...skippedPlayback, generatingOutlineCount: 1 }),
    ).toBe(false);
    expect(shouldRecordLessonPlaybackCompletion({ ...skippedPlayback, isRevisit: true })).toBe(
      false,
    );

    // Outside the window the strict semantics come back.
    expect(
      shouldRecordLessonPlaybackCompletion({
        ...skippedPlayback,
        now: DEMO_RELAXED_COMPLETION_START_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldRecordLessonPlaybackCompletion({
        ...skippedPlayback,
        now: DEMO_RELAXED_COMPLETION_END_MS,
      }),
    ).toBe(false);
  });
});
