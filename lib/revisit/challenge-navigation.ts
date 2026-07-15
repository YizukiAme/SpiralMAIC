import { PENDING_SCENE_ID } from '@/lib/store/stage';

export const REVISIT_COMPLETION_PAGE_ID = PENDING_SCENE_ID;
export const REVISIT_REPORT_PAGE_ID = '__revisit_report__';

export type RevisitChallengeView =
  | { kind: 'scene'; pageIndex: number }
  | { kind: 'completion' }
  | { kind: 'report' };

export function resolveRevisitChallengeView(args: {
  sceneId: string;
  sceneIds: string[];
  allPagesPassed: boolean;
  reportAvailable: boolean;
}): RevisitChallengeView | null {
  const pageIndex = args.sceneIds.indexOf(args.sceneId);
  if (pageIndex >= 0) return { kind: 'scene', pageIndex };
  if (args.sceneId === REVISIT_COMPLETION_PAGE_ID) {
    return args.allPagesPassed ? { kind: 'completion' } : null;
  }
  if (args.sceneId === REVISIT_REPORT_PAGE_ID) {
    return args.reportAvailable ? { kind: 'report' } : null;
  }
  return null;
}
