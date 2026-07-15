// Demo window (2026-07-10 00:00 → 2026-07-21 24:00, Beijing time / UTC+8):
// reaching the completion page of a fully materialized lesson counts as done,
// without requiring every scene to have played through. Outside the window the
// strict full-playback semantics apply again.
export const DEMO_RELAXED_COMPLETION_START_MS = Date.UTC(2026, 6, 9, 16); // 2026-07-10T00:00+08:00
export const DEMO_RELAXED_COMPLETION_END_MS = Date.UTC(2026, 6, 21, 16); // 2026-07-22T00:00+08:00

export function isDemoRelaxedCompletionActive(now = Date.now()): boolean {
  return now >= DEMO_RELAXED_COMPLETION_START_MS && now < DEMO_RELAXED_COMPLETION_END_MS;
}

export function shouldRecordLessonPlaybackCompletion(args: {
  sceneIds: string[];
  completedSceneIds: string[];
  reachedCourseEnd: boolean;
  materializedSceneCount: number;
  outlineCount: number;
  generatingOutlineCount: number;
  generationComplete: boolean;
  isRevisit: boolean;
  now?: number;
}): boolean {
  if (args.isRevisit || !args.reachedCourseEnd || args.sceneIds.length === 0) return false;
  const courseFullyMaterialized =
    args.generationComplete ||
    (args.outlineCount > 0 &&
      args.materializedSceneCount === args.outlineCount &&
      args.generatingOutlineCount === 0);
  if (!courseFullyMaterialized) return false;
  if (isDemoRelaxedCompletionActive(args.now)) return true;
  return args.sceneIds.every((sceneId) => args.completedSceneIds.includes(sceneId));
}
