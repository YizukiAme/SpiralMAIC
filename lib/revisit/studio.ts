import type { ArtifactGenerationJob } from '@/lib/revisit/artifact-queue';
import type { StudyArtifact, StudyArtifactKind } from '@/lib/revisit/types';

export type StudyArtifactGroupId = 'understanding' | 'structure' | 'practice';

export const STUDY_ARTIFACT_KINDS = [
  'briefing',
  'mindMap',
  'studyGuide',
  'faq',
  'flashcards',
  'quiz',
] as const satisfies readonly StudyArtifactKind[];

export const STUDY_ARTIFACT_GROUPS = [
  {
    id: 'understanding',
    kinds: ['briefing', 'studyGuide', 'faq'],
  },
  {
    id: 'structure',
    kinds: ['mindMap'],
  },
  {
    id: 'practice',
    kinds: ['flashcards', 'quiz'],
  },
] as const satisfies ReadonlyArray<{
  id: StudyArtifactGroupId;
  kinds: readonly StudyArtifactKind[];
}>;

export function latestStudyArtifactByKind(
  artifacts: StudyArtifact[],
): Partial<Record<StudyArtifactKind, StudyArtifact>> {
  const latest: Partial<Record<StudyArtifactKind, StudyArtifact>> = {};
  for (const artifact of sortArtifacts(artifacts)) {
    latest[artifact.kind] ??= artifact;
  }
  return latest;
}

export function groupStudyArtifacts(
  artifacts: StudyArtifact[],
): Record<StudyArtifactGroupId, StudyArtifact[]> {
  const sorted = sortArtifacts(artifacts);
  return {
    understanding: sorted.filter((artifact) =>
      STUDY_ARTIFACT_GROUPS[0].kinds.includes(
        artifact.kind as (typeof STUDY_ARTIFACT_GROUPS)[0]['kinds'][number],
      ),
    ),
    structure: sorted.filter((artifact) => artifact.kind === 'mindMap'),
    practice: sorted.filter((artifact) =>
      STUDY_ARTIFACT_GROUPS[2].kinds.includes(
        artifact.kind as (typeof STUDY_ARTIFACT_GROUPS)[2]['kinds'][number],
      ),
    ),
  };
}

export function groupArtifactGenerationJobs(
  jobs: ArtifactGenerationJob[],
): Record<StudyArtifactGroupId, ArtifactGenerationJob[]> {
  const sorted = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    understanding: sorted.filter((job) => getStudyArtifactGroupId(job.kind) === 'understanding'),
    structure: sorted.filter((job) => getStudyArtifactGroupId(job.kind) === 'structure'),
    practice: sorted.filter((job) => getStudyArtifactGroupId(job.kind) === 'practice'),
  };
}

export function latestVisibleArtifactJobs(
  jobs: ArtifactGenerationJob[],
): Partial<Record<StudyArtifactKind, ArtifactGenerationJob>> {
  const visibleStatuses = new Set(['queued', 'generating', 'failed', 'interrupted']);
  const seenKinds = new Set<StudyArtifactKind>();
  const result: Partial<Record<StudyArtifactKind, ArtifactGenerationJob>> = {};
  for (const job of [...jobs].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (seenKinds.has(job.kind)) continue;
    seenKinds.add(job.kind);
    if (visibleStatuses.has(job.status)) result[job.kind] = job;
  }
  return result;
}

export function getStudyArtifactGroupId(kind: StudyArtifactKind): StudyArtifactGroupId {
  if (kind === 'mindMap') return 'structure';
  if (kind === 'flashcards' || kind === 'quiz') return 'practice';
  return 'understanding';
}

function sortArtifacts(artifacts: StudyArtifact[]): StudyArtifact[] {
  return [...artifacts].sort(
    (a, b) => b.version - a.version || b.updatedAt - a.updatedAt || a.kind.localeCompare(b.kind),
  );
}
