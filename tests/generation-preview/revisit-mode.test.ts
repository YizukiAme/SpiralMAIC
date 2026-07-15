import { describe, expect, it } from 'vitest';

import {
  getActiveSteps,
  getGenerationStepText,
  shouldAutoStartRevisitGeneration,
  type GenerationSessionState,
} from '@/app/generation-preview/types';

const revisitSession: GenerationSessionState = {
  sessionId: 'session-1',
  mode: 'revisit',
  requirements: { requirement: 'Reverse Challenge: Fallacies' },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
  previewPhase: 'preparing',
  revisit: {
    stageId: 'stage-1',
    attemptId: 'attempt-1',
    forceRegenerate: true,
  },
};

describe('generation preview revisit mode', () => {
  it('uses revisit-only steps and text', () => {
    const steps = getActiveSteps(revisitSession);
    expect(steps.map((step) => step.id)).toEqual(['revisit-prepare', 'revisit-page']);

    expect(getGenerationStepText(steps[0], revisitSession)).toMatchObject({
      title: 'generation.revisitPreparingPath',
      description: 'generation.revisitPreparingPathDesc',
    });
    expect(getGenerationStepText(steps[1], revisitSession)).toMatchObject({
      title: 'generation.revisitGeneratingPage',
      description: 'generation.revisitGeneratingPageDesc',
    });
  });

  it('only starts preparation from an explicit one-shot request', () => {
    expect(shouldAutoStartRevisitGeneration('1')).toBe(true);
    expect(shouldAutoStartRevisitGeneration(null)).toBe(false);
    expect(shouldAutoStartRevisitGeneration('0')).toBe(false);
  });
});
