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
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Revisit blueprint concept "${label}" is missing evaluation anchors`);
  }
  const record = raw as Record<string, unknown>;
  const anchors = {
    clarity: stringArray(record.clarity),
    doubtResolution: stringArray(record.doubtResolution),
    transfer: stringArray(record.transfer),
    errorCorrection: stringArray(record.errorCorrection),
  };
  for (const [dimension, values] of Object.entries(anchors)) {
    if (values.length === 0) {
      throw new Error(
        `Revisit blueprint concept "${label}" is missing ${dimension} evaluation anchors`,
      );
    }
  }
  return anchors;
}

function normalizeProbe(
  raw: unknown,
  conceptId: string,
  index: number,
  pageIndex?: number,
): RevisitProbe {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind = record.kind;
  if (
    kind !== 'confusion' &&
    kind !== 'misconception' &&
    kind !== 'transfer' &&
    kind !== 'correction'
  ) {
    throw new Error(`Revisit blueprint concept "${conceptId}" has an invalid probe kind`);
  }
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!prompt) {
    throw new Error(`Revisit blueprint concept "${conceptId}" has an empty probe prompt`);
  }
  return {
    id:
      typeof record.id === 'string' && record.id
        ? record.id
        : `${conceptId}-probe-${String(index + 1).padStart(2, '0')}`,
    conceptId,
    pageIndex,
    kind,
    prompt,
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
  meta: {
    stageId: string;
    generatedAt: number;
    sourceHash: string;
    maxCuesPerPage?: number;
    canonicalConcepts?: Array<{ id: string; label: string }>;
    requiredConceptIds?: string[];
  },
): RevisitExamBlueprint {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawOpeningBrief = record.openingBrief ?? record.opening_brief;
  const openingBrief =
    typeof rawOpeningBrief === 'string'
      ? rawOpeningBrief.replace(/\s+/g, ' ').trim().slice(0, 600)
      : '';
  const rawConcepts = Array.isArray(record.concepts) ? record.concepts : [];
  const canonicalById = new Map(
    (meta.canonicalConcepts ?? []).map((concept) => [concept.id, concept]),
  );
  const canonicalByLabel = new Map(
    (meta.canonicalConcepts ?? []).map((concept) => [concept.label.trim().toLowerCase(), concept]),
  );
  const conceptAliases = new Map<string, string>();
  const concepts: RevisitConcept[] = rawConcepts.map((item, index) => {
    const concept = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const label = String(concept.label || concept.name || '').trim();
    if (!label) throw new Error(`Revisit blueprint concept ${index + 1} has no label`);
    const summary = String(concept.summary || concept.description || '').trim();
    if (!summary) throw new Error(`Revisit blueprint concept "${label}" has no summary`);
    const generatedId =
      typeof concept.id === 'string' && concept.id
        ? slugify(concept.id, `concept-${index + 1}`)
        : slugify(label, `concept-${index + 1}`);
    const canonical = canonicalById.get(generatedId) ?? canonicalByLabel.get(label.toLowerCase());
    const id = canonical?.id ?? generatedId;
    conceptAliases.set(generatedId, id);
    return {
      id,
      label,
      summary,
      anchors: normalizeAnchors(concept.anchors, label),
      probes: [],
    };
  });

  if (concepts.length === 0) {
    throw new Error('Revisit blueprint response has no concepts');
  }
  const conceptIds = concepts.map((concept) => concept.id);
  if (new Set(conceptIds).size !== conceptIds.length) {
    throw new Error('Revisit blueprint response has a duplicate concept id');
  }
  const requiredConceptIds = Array.from(new Set(meta.requiredConceptIds ?? []));
  const unknownRequiredConceptIds = requiredConceptIds.filter((id) => !canonicalById.has(id));
  if (unknownRequiredConceptIds.length > 0) {
    throw new Error(
      `Revisit blueprint has unknown required concept ids: ${unknownRequiredConceptIds.join(', ')}`,
    );
  }
  const generatedIds = new Set(conceptIds);
  const missingRequiredConceptIds = requiredConceptIds.filter((id) => !generatedIds.has(id));
  if (missingRequiredConceptIds.length > 0) {
    throw new Error(
      `Revisit blueprint omitted required concept ids: ${missingRequiredConceptIds.join(', ')}`,
    );
  }

  const lookup = buildConceptLookup(concepts);
  for (const [alias, conceptId] of conceptAliases) lookup.set(alias, conceptId);
  const rawSkeleton =
    record.skeleton && typeof record.skeleton === 'object'
      ? (record.skeleton as Record<string, unknown>)
      : {};
  const rawPages = Array.isArray(rawSkeleton.pages) ? rawSkeleton.pages : [];
  const maxCuesPerPage = Number.isFinite(meta.maxCuesPerPage)
    ? Math.max(0, Math.min(6, Math.floor(meta.maxCuesPerPage!)))
    : 6;
  const pages: RevisitSkeletonPage[] = rawPages.map((item, index) => {
    const page = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const conceptLabels = stringArray(page.conceptLabels);
    const rawConceptIds = [...stringArray(page.conceptIds), ...conceptLabels];
    if (rawConceptIds.length === 0) {
      throw new Error(`Revisit blueprint page ${index + 1} has no concept references`);
    }
    const unknownConceptIds = rawConceptIds.filter(
      (id) => !lookup.has(id) && !lookup.has(id.toLowerCase()),
    );
    if (unknownConceptIds.length > 0) {
      throw new Error(
        `Revisit blueprint page ${index + 1} references an unknown concept: ${unknownConceptIds.join(', ')}`,
      );
    }
    const conceptIds = rawConceptIds
      .map((id) => lookup.get(id) ?? lookup.get(id.toLowerCase()))
      .filter((id): id is string => Boolean(id));
    const finalConceptIds = Array.from(new Set(conceptIds));
    const title = String(page.title || '').trim();
    const summary = String(page.summary || page.description || '').trim();
    if (!title) throw new Error(`Revisit blueprint page ${index + 1} has no title`);
    if (!summary) throw new Error(`Revisit blueprint page ${index + 1} has no summary`);
    return {
      id:
        typeof page.id === 'string' && page.id
          ? page.id
          : `page-${String(index + 1).padStart(2, '0')}`,
      title,
      summary,
      conceptIds: finalConceptIds,
      cues: stringArray(page.cues).slice(0, maxCuesPerPage),
    };
  });

  if (pages.length === 0) {
    throw new Error('Revisit blueprint response has no skeleton pages');
  }
  const skeletonConceptIds = new Set(pages.flatMap((page) => page.conceptIds));
  const requiredConceptsMissingFromSkeleton = requiredConceptIds.filter(
    (id) => !skeletonConceptIds.has(id),
  );
  if (requiredConceptsMissingFromSkeleton.length > 0) {
    throw new Error(
      `Revisit blueprint skeleton omitted required concept ids: ${requiredConceptsMissingFromSkeleton.join(', ')}`,
    );
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
    ...(openingBrief ? { openingBrief } : {}),
    concepts,
    skeleton: { pages },
  };
}

export function simpleSourceHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
