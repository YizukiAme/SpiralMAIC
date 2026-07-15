import type {
  StudyArtifactKind,
  StudyArtifactFaqItem,
  StudyArtifactReferenceFields,
  StudyArtifactRichBlock,
} from '@/lib/revisit/types';
import { buildStudyArtifactSceneChoices } from '@/lib/revisit/artifact-options';

export interface StudyGuideSection {
  id: string;
  title: string;
  blocks: StudyArtifactRichBlock[];
}

export interface ResolvedStudyArtifactSourceScene {
  id: string;
  pageNumber: number | null;
  title: string | null;
  missing: boolean;
}

export type StudyArtifactViewerLayout = 'paper' | 'canvas' | 'document' | 'practice';

export function getStudyArtifactViewerLayout(kind: StudyArtifactKind): StudyArtifactViewerLayout {
  switch (kind) {
    case 'briefing':
      return 'paper';
    case 'mindMap':
      return 'canvas';
    case 'studyGuide':
    case 'faq':
      return 'document';
    case 'flashcards':
    case 'quiz':
      return 'practice';
  }
}

export function resolveStudyArtifactSourceScenes<
  T extends { id: string; order: number; title: string },
>(sourceSceneIds: string[], scenes: readonly T[]): ResolvedStudyArtifactSourceScene[] {
  const sceneById = new Map(
    buildStudyArtifactSceneChoices(scenes).map(({ scene, number }) => [
      scene.id,
      { pageNumber: number, title: scene.title },
    ]),
  );

  return sourceSceneIds.map((id) => {
    const scene = sceneById.get(id);
    return scene
      ? { id, pageNumber: scene.pageNumber, title: scene.title, missing: false }
      : { id, pageNumber: null, title: null, missing: true };
  });
}

export function buildStudyGuideSections(
  blocks: StudyArtifactRichBlock[],
  overviewTitle: string,
): StudyGuideSection[] {
  const sections: StudyGuideSection[] = [];
  const seenIds = new Map<string, number>();
  let current: StudyGuideSection = {
    id: 'overview',
    title: overviewTitle,
    blocks: [],
  };

  const commit = () => {
    if (current.blocks.length > 0) {
      sections.push(current);
      if (current.id === 'overview') seenIds.set('overview', 1);
    }
  };

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2) {
      commit();
      current = {
        id: uniqueSlug(block.text, seenIds),
        title: block.text,
        blocks: [],
      };
      continue;
    }
    current.blocks.push(block);
  }
  commit();
  return sections;
}

export function collectStudyArtifactReferences(blocks: StudyArtifactRichBlock[]): {
  conceptIds: string[];
  sourceSceneIds: string[];
} {
  const conceptIds = new Set<string>();
  const sourceSceneIds = new Set<string>();
  const collect = (value: StudyArtifactReferenceFields) => {
    value.conceptIds?.forEach((id) => conceptIds.add(id));
    value.sourceSceneIds?.forEach((id) => sourceSceneIds.add(id));
  };

  for (const block of blocks) {
    collect(block);
    if (block.type === 'list') block.items.forEach(collect);
    if (block.type === 'timeline') block.entries.forEach(collect);
    if (block.type === 'table') block.rows.forEach(collect);
  }

  return {
    conceptIds: [...conceptIds].sort((a, b) => a.localeCompare(b)),
    sourceSceneIds: [...sourceSceneIds].sort((a, b) => a.localeCompare(b)),
  };
}

export function filterStudyArtifactFaqItems(
  items: StudyArtifactFaqItem[],
  query: string,
  conceptId: string | null,
): StudyArtifactFaqItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const matchesTopic = !conceptId || item.conceptIds?.includes(conceptId);
    const matchesQuery =
      !normalizedQuery ||
      `${item.question}\n${item.answer}`.toLocaleLowerCase().includes(normalizedQuery);
    return matchesTopic && matchesQuery;
  });
}

function uniqueSlug(value: string, seen: Map<string, number>): string {
  const base =
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}
