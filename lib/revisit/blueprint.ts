import type { Scene, Stage } from '@/lib/types/stage';
import type {
  RevisitConcept,
  RevisitDimension,
  RevisitExamBlueprint,
  RevisitProbe,
  RevisitSkeletonPage,
} from '@/lib/revisit/types';

const DIMENSIONS: RevisitDimension[] = [
  'clarity',
  'doubtResolution',
  'transfer',
  'errorCorrection',
];

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeAnchors(raw: unknown, label: string): RevisitConcept['anchors'] {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    clarity: stringArray(record.clarity).length
      ? stringArray(record.clarity)
      : [`Explain ${label} clearly without reading from the skeleton.`],
    doubtResolution: stringArray(record.doubtResolution).length
      ? stringArray(record.doubtResolution)
      : [`Answer a student's doubt about ${label}.`],
    transfer: stringArray(record.transfer).length
      ? stringArray(record.transfer)
      : [`Apply ${label} to a new example.`],
    errorCorrection: stringArray(record.errorCorrection).length
      ? stringArray(record.errorCorrection)
      : [`Notice and correct a mistaken statement about ${label}.`],
  };
}

function normalizeProbe(
  raw: unknown,
  conceptId: string,
  index: number,
  pageIndex?: number,
): RevisitProbe {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind = record.kind;
  return {
    id:
      typeof record.id === 'string' && record.id
        ? record.id
        : `${conceptId}-probe-${String(index + 1).padStart(2, '0')}`,
    conceptId,
    pageIndex,
    kind:
      kind === 'misconception' || kind === 'transfer' || kind === 'correction' ? kind : 'confusion',
    prompt: String(record.prompt || `Can you explain ${conceptId} in another way?`),
    expectedAnswer: typeof record.expectedAnswer === 'string' ? record.expectedAnswer : undefined,
    expectedCorrection:
      typeof record.expectedCorrection === 'string' ? record.expectedCorrection : undefined,
  };
}

function buildConceptLookup(concepts: RevisitConcept[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const concept of concepts) {
    map.set(concept.id, concept.id);
    map.set(concept.label.toLowerCase(), concept.id);
  }
  return map;
}

function fallbackConcept(label: string, stageId: string, generatedAt: number): RevisitConcept {
  const id = slugify(label, `concept-${generatedAt}`);
  return {
    id,
    label,
    summary: label,
    anchors: normalizeAnchors({}, label),
    probes: [
      {
        id: `${id}-probe-01`,
        conceptId: id,
        pageIndex: 0,
        kind: 'confusion',
        prompt: `I am not sure I can tell the key idea of ${label} apart from a nearby idea. Could you compare them?`,
      },
    ],
  };
}

export function normalizeBlueprint(
  raw: unknown,
  meta: { stageId: string; generatedAt: number; sourceHash: string },
): RevisitExamBlueprint {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawConcepts = Array.isArray(record.concepts) ? record.concepts : [];
  const concepts: RevisitConcept[] = rawConcepts.map((item, index) => {
    const concept = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const label = String(concept.label || concept.name || `Concept ${index + 1}`);
    const id =
      typeof concept.id === 'string' && concept.id
        ? slugify(concept.id, `concept-${index + 1}`)
        : slugify(label, `concept-${index + 1}`);
    return {
      id,
      label,
      summary: String(concept.summary || concept.description || label),
      anchors: normalizeAnchors(concept.anchors, label),
      probes: [],
    };
  });

  if (concepts.length === 0) {
    concepts.push(fallbackConcept('Core idea', meta.stageId, meta.generatedAt));
  }

  const lookup = buildConceptLookup(concepts);
  const rawSkeleton =
    record.skeleton && typeof record.skeleton === 'object'
      ? (record.skeleton as Record<string, unknown>)
      : {};
  const rawPages = Array.isArray(rawSkeleton.pages) ? rawSkeleton.pages : [];
  const pages: RevisitSkeletonPage[] = rawPages.map((item, index) => {
    const page = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const conceptLabels = stringArray(page.conceptLabels);
    const rawConceptIds = [...stringArray(page.conceptIds), ...conceptLabels];
    const conceptIds = rawConceptIds
      .map((id) => lookup.get(id) ?? lookup.get(id.toLowerCase()))
      .filter((id): id is string => Boolean(id));
    const finalConceptIds = conceptIds.length ? Array.from(new Set(conceptIds)) : [concepts[0].id];
    return {
      id:
        typeof page.id === 'string' && page.id
          ? page.id
          : `page-${String(index + 1).padStart(2, '0')}`,
      title: String(page.title || concepts[index]?.label || `Review page ${index + 1}`),
      summary: String(page.summary || page.description || ''),
      conceptIds: finalConceptIds,
      cues: stringArray(page.cues).slice(0, 6),
    };
  });

  if (pages.length === 0) {
    pages.push({
      id: 'page-01',
      title: concepts[0].label,
      summary: concepts[0].summary,
      conceptIds: [concepts[0].id],
      cues: DIMENSIONS.map((dimension) => concepts[0].anchors[dimension][0]).filter(Boolean),
    });
  }

  const pageIndexByConcept = new Map<string, number>();
  for (const [pageIndex, page] of pages.entries()) {
    for (const conceptId of page.conceptIds) {
      if (!pageIndexByConcept.has(conceptId)) pageIndexByConcept.set(conceptId, pageIndex);
    }
  }

  for (const [conceptIndex, concept] of concepts.entries()) {
    const rawConcept = rawConcepts[conceptIndex] as Record<string, unknown> | undefined;
    const rawProbes = Array.isArray(rawConcept?.probes) ? rawConcept.probes : [];
    concept.probes = rawProbes.length
      ? rawProbes.map((probe, probeIndex) =>
          normalizeProbe(probe, concept.id, probeIndex, pageIndexByConcept.get(concept.id)),
        )
      : [
          normalizeProbe(
            {
              prompt: `I think I understand ${concept.label}, but could you show how it works in a new example?`,
              kind: 'transfer',
            },
            concept.id,
            0,
            pageIndexByConcept.get(concept.id),
          ),
        ];
  }

  return {
    id: `${meta.stageId}:${meta.sourceHash}`,
    stageId: meta.stageId,
    generatedAt: meta.generatedAt,
    language: String(record.language || 'auto'),
    sourceHash: meta.sourceHash,
    concepts,
    skeleton: { pages },
    raw,
  };
}

function extractSlideText(scene: Scene): string {
  if (scene.content.type !== 'slide') return '';
  const elements = scene.content.canvas.elements as Array<{ type?: string; content?: unknown }>;
  return elements
    .filter((element) => element.type === 'text')
    .map((element) => String(element.content || ''))
    .filter(Boolean)
    .join(' ');
}

export function createFallbackBlueprint(
  stage: Stage,
  scenes: Scene[],
  generatedAt = Date.now(),
): RevisitExamBlueprint {
  const sourceHash = simpleSourceHash(`${stage.id}:${stage.updatedAt}:${scenes.length}`);
  const learningScenes = scenes.filter((scene) => scene.type === 'slide' || scene.type === 'quiz');
  const seedScenes = learningScenes.length ? learningScenes : scenes;
  const concepts = seedScenes.slice(0, 6).map((scene, index) => {
    const label = scene.title?.trim() || `Concept ${index + 1}`;
    const id = slugify(label, `concept-${index + 1}`);
    const text = extractSlideText(scene);
    return {
      id,
      label,
      summary: text || label,
      anchors: normalizeAnchors({}, label),
      probes: [
        {
          id: `${id}-probe-01`,
          conceptId: id,
          pageIndex: index,
          kind: 'confusion',
          prompt: `Can you explain the important point of "${label}" without reading the page?`,
        },
      ],
    } satisfies RevisitConcept;
  });

  const finalConcepts = concepts.length
    ? concepts
    : [fallbackConcept(stage.name || 'Core idea', stage.id, generatedAt)];
  const pages = finalConcepts.map((concept, index) => ({
    id: `page-${String(index + 1).padStart(2, '0')}`,
    title: concept.label,
    summary: concept.summary,
    conceptIds: [concept.id],
    cues: [concept.anchors.clarity[0], concept.anchors.transfer[0]].filter(Boolean),
  }));

  return {
    id: `${stage.id}:${sourceHash}`,
    stageId: stage.id,
    generatedAt,
    language: stage.languageDirective || 'auto',
    sourceHash,
    concepts: finalConcepts,
    skeleton: { pages },
    raw: { fallback: true },
  };
}

export function simpleSourceHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
