import type { StudyArtifactKind } from '@/lib/revisit/types';

export function createStudyArtifactVersionId(
  stageId: string,
  kind: StudyArtifactKind,
  version: number,
): string {
  return `${stageId}:${kind}:v${version}`;
}
