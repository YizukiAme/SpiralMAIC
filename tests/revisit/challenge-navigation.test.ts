import { describe, expect, it } from 'vitest';

import {
  REVISIT_COMPLETION_PAGE_ID,
  REVISIT_REPORT_PAGE_ID,
  resolveRevisitChallengeView,
} from '@/lib/revisit/challenge-navigation';

describe('Reverse Challenge tail-page navigation', () => {
  const sceneIds = ['page-1', 'page-2', 'page-3', 'page-4'];

  it('opens the completion slot after every challenge page has passed', () => {
    expect(
      resolveRevisitChallengeView({
        sceneId: REVISIT_COMPLETION_PAGE_ID,
        sceneIds,
        allPagesPassed: true,
        reportAvailable: false,
      }),
    ).toEqual({ kind: 'completion' });
  });

  it('keeps the completion slot locked before all challenge pages pass', () => {
    expect(
      resolveRevisitChallengeView({
        sceneId: REVISIT_COMPLETION_PAGE_ID,
        sceneIds,
        allPagesPassed: false,
        reportAvailable: false,
      }),
    ).toBeNull();
  });

  it('opens a separate report page only after a report becomes available', () => {
    expect(
      resolveRevisitChallengeView({
        sceneId: REVISIT_REPORT_PAGE_ID,
        sceneIds,
        allPagesPassed: true,
        reportAvailable: true,
      }),
    ).toEqual({ kind: 'report' });
  });

  it('continues to resolve real challenge scenes by index', () => {
    expect(
      resolveRevisitChallengeView({
        sceneId: 'page-3',
        sceneIds,
        allPagesPassed: true,
        reportAvailable: true,
      }),
    ).toEqual({ kind: 'scene', pageIndex: 2 });
  });
});
