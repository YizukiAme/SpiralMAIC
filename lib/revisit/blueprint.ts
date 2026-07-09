import type {
  RevisitConcept,
  RevisitExamBlueprint,
  RevisitProbe,
  RevisitSkeletonPage,
} from '@/lib/revisit/types';

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
    throw new Error('Revisit blueprint response has no concepts');
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
    throw new Error('Revisit blueprint response has no skeleton pages');
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
    if (rawProbes.length === 0) {
      throw new Error(`Revisit blueprint concept "${concept.label}" has no probes`);
    }
    concept.probes = rawProbes.map((probe, probeIndex) =>
      normalizeProbe(probe, concept.id, probeIndex, pageIndexByConcept.get(concept.id)),
    );
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

export function simpleSourceHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
