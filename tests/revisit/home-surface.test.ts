import { describe, expect, it } from 'vitest';

import {
  buildRevisitPanelReturnUrl,
  clearRevisitPanelReturnParams,
  isCurrentRevisitPanelRequest,
  parseRevisitPanelReturn,
  parseRevisitPanelSection,
  resolveHomeSurfaceState,
  shouldLoadRevisitHomeData,
} from '@/lib/revisit/home-surface';

describe('home Spiral surface state', () => {
  it('keeps the prompt visible in normal OpenMAIC mode', () => {
    expect(
      resolveHomeSurfaceState({
        reverseChallengeEnabled: false,
        classroomsLoaded: true,
        stageCount: 0,
      }),
    ).toEqual({
      showPromptComposer: true,
      showSpiralLogo: false,
      showEmptyCoursePrompt: false,
    });
  });

  it('hides the prompt composer in Spiral mode', () => {
    expect(
      resolveHomeSurfaceState({
        reverseChallengeEnabled: true,
        classroomsLoaded: true,
        stageCount: 1,
      }),
    ).toEqual({
      showPromptComposer: false,
      showSpiralLogo: true,
      showEmptyCoursePrompt: false,
    });
  });

  it('waits for course hydration before showing the Spiral empty prompt', () => {
    expect(
      resolveHomeSurfaceState({
        reverseChallengeEnabled: true,
        classroomsLoaded: false,
        stageCount: 0,
      }).showEmptyCoursePrompt,
    ).toBe(false);
  });

  it('shows the Spiral empty prompt only after an empty course list loads', () => {
    expect(
      resolveHomeSurfaceState({
        reverseChallengeEnabled: true,
        classroomsLoaded: true,
        stageCount: 0,
      }).showEmptyCoursePrompt,
    ).toBe(true);
    expect(
      resolveHomeSurfaceState({
        reverseChallengeEnabled: true,
        classroomsLoaded: true,
        stageCount: 1,
      }).showEmptyCoursePrompt,
    ).toBe(false);
  });

  it('does not open the revisit database while Spiral mode is off', () => {
    expect(shouldLoadRevisitHomeData({ reverseChallengeEnabled: false, stageCount: 3 })).toBe(
      false,
    );
    expect(shouldLoadRevisitHomeData({ reverseChallengeEnabled: true, stageCount: 0 })).toBe(false);
    expect(shouldLoadRevisitHomeData({ reverseChallengeEnabled: true, stageCount: 3 })).toBe(true);
  });

  it('rejects a stale review-panel response after another course is opened', () => {
    expect(isCurrentRevisitPanelRequest(1, 2)).toBe(false);
    expect(isCurrentRevisitPanelRequest(2, 2)).toBe(true);
  });

  it('round-trips the course and section needed to return to the Spiral panel', () => {
    const returnUrl = buildRevisitPanelReturnUrl({
      stageId: 'course/with spaces',
      section: 'materials',
    });

    expect(returnUrl).toBe('/?spiralStage=course%2Fwith+spaces&spiralSection=materials');
    expect(
      parseRevisitPanelReturn(new URL(`https://openmaic.test${returnUrl}`).searchParams),
    ).toEqual({
      stageId: 'course/with spaces',
      section: 'materials',
    });
    expect(parseRevisitPanelSection('demo')).toBe('demo');
    expect(parseRevisitPanelSection('unknown')).toBeNull();
  });

  it('ignores incomplete return state and removes only Spiral return parameters after use', () => {
    expect(parseRevisitPanelReturn(new URLSearchParams('spiralStage=course-1'))).toBeNull();
    expect(
      clearRevisitPanelReturnParams(
        new URL(
          'https://openmaic.test/?keep=1&spiralStage=course-1&spiralSection=materials#recent',
        ),
      ),
    ).toBe('/?keep=1#recent');
  });
});
