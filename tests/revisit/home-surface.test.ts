import { describe, expect, it } from 'vitest';

import {
  buildRevisitPanelReturnUrl,
  clearRevisitPanelReturnParams,
  isCurrentRevisitPanelRequest,
  parseRevisitPanelReturn,
  parseRevisitPanelSection,
  orderSpiralClassrooms,
  resolveHomeSurfaceState,
  shouldLoadRevisitHomeData,
} from '@/lib/revisit/home-surface';

describe('home Spiral surface state', () => {
  it('keeps the prompt visible in normal OpenMAIC mode', () => {
    expect(
      resolveHomeSurfaceState({
        reverseChallengeEnabled: false,
      }),
    ).toEqual({
      showPromptComposer: true,
      showSpiralLogo: false,
      showProEntry: true,
    });
  });

  it('keeps Spiral and Pro as separate product surfaces', () => {
    expect(
      resolveHomeSurfaceState({
        reverseChallengeEnabled: true,
      }),
    ).toEqual({
      showPromptComposer: false,
      showSpiralLogo: true,
      showProEntry: false,
    });
  });

  it('does not open the revisit database while Spiral mode is off', () => {
    expect(shouldLoadRevisitHomeData({ reverseChallengeEnabled: false, stageCount: 3 })).toBe(
      false,
    );
    expect(shouldLoadRevisitHomeData({ reverseChallengeEnabled: true, stageCount: 0 })).toBe(false);
    expect(shouldLoadRevisitHomeData({ reverseChallengeEnabled: true, stageCount: 3 })).toBe(true);
  });

  it('orders the Spiral library by review need instead of recent activity', () => {
    const classrooms = [
      { id: 'stable', updatedAt: 40 },
      { id: 'fresh', updatedAt: 30 },
      { id: 'review-later', updatedAt: 20 },
      { id: 'review-now', updatedAt: 10 },
      { id: 'unlearned', updatedAt: 50 },
    ];

    expect(
      orderSpiralClassrooms(classrooms, {
        stable: { status: 'stable', recall: 0.92 },
        fresh: { status: 'fresh', recall: 0.78 },
        'review-later': { status: 'review', recall: 0.48 },
        'review-now': { status: 'review', recall: 0.22 },
        unlearned: { status: 'unlearned', recall: null },
      }).map(({ id }) => id),
    ).toEqual(['review-now', 'review-later', 'fresh', 'stable', 'unlearned']);
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
