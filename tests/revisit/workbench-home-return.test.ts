import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/workbench/entry-gate', () => ({ isWorkbenchEntryEnabled: () => true }));
vi.mock('@/app/classic-home', () => ({ ClassicHomePage: () => null }));
vi.mock('@/components/workbench/WorkspaceEntry', () => ({ WorkspaceEntry: () => null }));

import HomePage from '@/app/page';
import { ClassicHomePage } from '@/app/classic-home';
import { WorkspaceEntry } from '@/components/workbench/WorkspaceEntry';
import { buildRevisitPanelReturnUrl } from '@/lib/revisit/home-surface';

describe('Spiral returns with the workbench home enabled', () => {
  it.each(['challenge', 'materials', 'demo'] as const)(
    'keeps the existing %s return link on the Spiral home',
    async (section) => {
      const url = new URL(
        buildRevisitPanelReturnUrl({ stageId: 'course-1', section }),
        'http://local',
      );
      const page = await HomePage({
        searchParams: Promise.resolve(Object.fromEntries(url.searchParams)),
      });
      expect(page.type).toBe(ClassicHomePage);
    },
  );

  it('keeps the ordinary workbench entry when no valid Spiral return is requested', async () => {
    expect(
      (await HomePage({ searchParams: Promise.resolve({ spiralStage: 'course-1' }) })).type,
    ).toBe(WorkspaceEntry);
  });
});
