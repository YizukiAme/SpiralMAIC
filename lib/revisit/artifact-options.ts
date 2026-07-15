import { z, type ZodType } from 'zod';

import type { StudyArtifactKind, StudyArtifactOptionsByKind } from '@/lib/revisit/types';

// Client-safe study-artifact option schemas and helpers. This module must stay
// free of server-only imports (the prompt loader reads templates with Node fs),
// so client components can consume option defaults without pulling the prompt
// pipeline into the browser bundle.

const commonOptionsSchema = z.object({
  focusMode: z.enum(['balanced', 'weak-points', 'selected-scenes']).default('balanced'),
  selectedSceneIds: z.array(z.string().trim().min(1)).default([]),
  customInstructions: z.string().max(800).default(''),
});

const briefingOptionsSchema = commonOptionsSchema.extend({
  orientation: z.enum(['portrait', 'landscape', 'square']).default('portrait'),
  detailLevel: z.enum(['standard', 'compact', 'detailed']).default('standard'),
});

const mindMapOptionsSchema = commonOptionsSchema.extend({
  depth: z.number().int().min(1).max(6).default(3),
  includeExamples: z.boolean().default(true),
});

const studyGuideOptionsSchema = commonOptionsSchema.extend({
  detailLevel: z.enum(['standard', 'compact', 'detailed']).default('standard'),
});

const faqOptionsSchema = commonOptionsSchema.extend({
  count: z.number().int().min(3).max(30).default(10),
});

const flashcardsOptionsSchema = commonOptionsSchema.extend({
  count: z.number().int().min(5).max(50).default(15),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
});

const quizOptionsSchema = commonOptionsSchema.extend({
  count: z.number().int().min(3).max(30).default(10),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  format: z.enum(['mcq']).default('mcq'),
});

export const studyArtifactOptionsSchemas: {
  [K in StudyArtifactKind]: ZodType<StudyArtifactOptionsByKind[K]>;
} = {
  briefing: briefingOptionsSchema,
  mindMap: mindMapOptionsSchema,
  studyGuide: studyGuideOptionsSchema,
  faq: faqOptionsSchema,
  flashcards: flashcardsOptionsSchema,
  quiz: quizOptionsSchema,
};

export function getDefaultStudyArtifactOptions<K extends StudyArtifactKind>(
  kind: K,
): StudyArtifactOptionsByKind[K] {
  return studyArtifactOptionsSchemas[kind].parse({});
}

export function normalizeStudyArtifactOptions<K extends StudyArtifactKind>(
  kind: K,
  value: unknown,
): StudyArtifactOptionsByKind[K] {
  const parsed = studyArtifactOptionsSchemas[kind].parse(value ?? {});
  return {
    ...parsed,
    selectedSceneIds: uniqueStrings(parsed.selectedSceneIds),
    customInstructions: parsed.customInstructions.trim(),
  };
}

export function buildStudyArtifactSceneChoices<T extends { order: number }>(
  scenes: readonly T[],
): Array<{ scene: T; number: number }> {
  return [...scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene, index) => ({ scene, number: index + 1 }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
