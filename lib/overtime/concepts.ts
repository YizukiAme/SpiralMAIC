import type { OvertimeExtension, OvertimePlanDraft } from '@/lib/overtime/types';
import { simpleSourceHash } from '@/lib/revisit/blueprint';
import type { LessonConcept } from '@/lib/revisit/types';
import type { SceneOutline } from '@/lib/types/generation';

function normalizeLabel(label: string): string {
  return label.normalize('NFKC').trim().toLocaleLowerCase();
}

function slugify(label: string): string {
  return (
    normalizeLabel(label)
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'concept'
  );
}

function createOvertimeConceptId(stageId: string, label: string): string {
  const normalized = normalizeLabel(label);
  return `overtime-${slugify(label)}-${simpleSourceHash(`${stageId}:${normalized}`)}`;
}

export function materializeOvertimePlan(args: {
  extension: OvertimeExtension;
  plan: OvertimePlanDraft;
  knownConcepts: LessonConcept[];
  now: number;
}): {
  outline: SceneOutline;
  concepts: LessonConcept[];
  conceptIds: string[];
} {
  const sceneId = `overtime-${args.extension.id}`;
  const outline: SceneOutline = {
    ...args.plan.outline,
    id: sceneId,
    order: args.extension.reservedOrder,
  };
  const byId = new Map(args.knownConcepts.map((concept) => [concept.conceptId, concept]));
  const byLabel = new Map(
    args.knownConcepts.map((concept) => [normalizeLabel(concept.label), concept]),
  );
  const concepts = new Map<string, LessonConcept>();

  for (const draft of args.plan.concepts) {
    const existing =
      draft.kind === 'existing'
        ? byId.get(draft.conceptId)
        : byLabel.get(normalizeLabel(draft.label));
    let concept: LessonConcept;
    if (existing) {
      concept = {
        ...existing,
        sourceSceneIds: Array.from(new Set([...existing.sourceSceneIds, sceneId])),
        updatedAt: args.now,
      };
    } else {
      if (draft.kind !== 'new') {
        throw new Error(`Known overtime concept ${draft.conceptId} is missing from the catalog.`);
      }
      concept = {
        stageId: args.extension.stageId,
        conceptId: createOvertimeConceptId(args.extension.stageId, draft.label),
        label: draft.label.trim(),
        summary: draft.summary.trim(),
        origin: 'overtime',
        sourceSceneIds: [sceneId],
        introducedAt: args.now,
        createdAt: args.now,
        updatedAt: args.now,
      };
    }
    concepts.set(concept.conceptId, concept);
  }

  return {
    outline,
    concepts: [...concepts.values()],
    conceptIds: [...concepts.keys()],
  };
}
