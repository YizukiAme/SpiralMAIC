import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { extractJsonObject } from '@/lib/revisit/prompt-builders';
import { buildSceneDigestWithStableIds } from '@/lib/revisit/source';
import type { RequestLearningExtensionParams, OvertimePlanDraft } from './types';
import { parseOvertimePlanDraft } from './types';
import type { Scene, Stage } from '@/lib/types/stage';

export interface OvertimeKnownConcept {
  conceptId: string;
  label: string;
  summary: string;
  sourceSceneIds: string[];
}

export interface BuildOvertimePlanPromptArgs {
  stage: Pick<Stage, 'name' | 'description' | 'languageDirective'>;
  scenes: Scene[];
  request: RequestLearningExtensionParams;
  knownConcepts: OvertimeKnownConcept[];
}

export function buildOvertimePlanPrompt(args: BuildOvertimePlanPromptArgs): {
  system: string;
  user: string;
} {
  const prompt = buildPrompt(PROMPT_IDS.OVERTIME_EXTENSION_OUTLINE, {
    languageDirective: args.stage.languageDirective || 'Follow the classroom language.',
    stageTitle: args.stage.name,
    stageSummary: args.stage.description || 'No separate course summary.',
    topic: args.request.topic,
    teachingMove: args.request.teachingMove,
    reason: args.request.reason || 'No additional reason provided.',
    sceneDigest: buildSceneDigestWithStableIds(args.scenes),
    knownConceptsJson: JSON.stringify(args.knownConcepts, null, 2),
  });
  if (!prompt) throw new Error('Overtime extension outline prompt is unavailable.');
  return prompt;
}

export function parseOvertimePlannerResponse(args: {
  text: string;
  knownSceneIds: ReadonlySet<string>;
  knownConceptIds: ReadonlySet<string>;
}): OvertimePlanDraft {
  return parseOvertimePlanDraft(extractJsonObject(args.text), {
    knownSceneIds: args.knownSceneIds,
    knownConceptIds: args.knownConceptIds,
  });
}
