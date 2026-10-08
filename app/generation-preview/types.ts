import { Search, Bot, FileText, LayoutPanelLeft, Clapperboard, BrainCircuit } from 'lucide-react';

import { useSettingsStore } from '@/lib/store/settings';
import type { SceneOutline, UserRequirements, PdfImage } from '@/lib/types/generation';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';

/** Recovered challenge state; overtime also uses its requirement to start a server run. */
export interface GenerationSessionState {
  sessionId: string;
  mode?: 'course' | 'revisit';
  requirements: UserRequirements;
  pdfText: string;
  pdfImages?: PdfImage[];
  imageStorageIds?: string[];
  sceneOutlines?: SceneOutline[] | null;
  currentStep: 'generating' | 'complete';
  previewPhase?: 'preparing' | 'outline-ready' | 'review' | 'generating-content';
  revisit?: {
    stageId: string;
    attemptId: string;
    forceRegenerate: boolean;
    scope?: string;
    blueprint?: RevisitExamBlueprint;
    showSpiralAgentGenerationStep: boolean;
  };
}

export type GenerationStep = {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  type: 'analysis' | 'writing' | 'visual';
};

export const ALL_STEPS: GenerationStep[] = [
  {
    id: 'web-search',
    title: 'generation.webSearching',
    description: 'generation.webSearchingDesc',
    icon: Search,
    type: 'analysis',
  },
  {
    id: 'outline',
    title: 'generation.generatingOutlines',
    description: 'generation.generatingOutlinesDesc',
    icon: FileText,
    type: 'writing',
  },
  {
    id: 'agent-generation',
    title: 'generation.agentGeneration',
    description: 'generation.agentGenerationDesc',
    icon: Bot,
    type: 'writing',
  },
  {
    id: 'slide-content',
    title: 'generation.generatingSlideContent',
    description: 'generation.generatingSlideContentDesc',
    icon: LayoutPanelLeft,
    type: 'visual',
  },
  {
    id: 'actions',
    title: 'generation.generatingActions',
    description: 'generation.generatingActionsDesc',
    icon: Clapperboard,
    type: 'visual',
  },
];
export const REVISIT_STEPS: GenerationStep[] = [
  {
    id: 'revisit-prepare',
    title: 'generation.revisitPreparingPath',
    description: 'generation.revisitPreparingPathDesc',
    icon: BrainCircuit,
    type: 'analysis',
  },
  {
    id: 'agent-generation',
    title: 'generation.agentGeneration',
    description: 'generation.agentGenerationDesc',
    icon: Bot,
    type: 'writing',
  },
  {
    id: 'revisit-page',
    title: 'generation.revisitGeneratingPage',
    description: 'generation.revisitGeneratingPageDesc',
    icon: LayoutPanelLeft,
    type: 'visual',
  },
];

export function getGenerationStepText(
  step: GenerationStep,
  _session: GenerationSessionState | null,
) {
  return { title: step.title, titleValues: undefined, description: step.description };
}

export const getActiveSteps = (session: GenerationSessionState | null) => {
  if (session?.mode === 'revisit') {
    return REVISIT_STEPS.filter(
      (step) =>
        step.id !== 'agent-generation' || session.revisit?.showSpiralAgentGenerationStep === true,
    );
  }
  return ALL_STEPS.filter((step) =>
    step.id === 'web-search'
      ? !!session?.requirements.webSearch
      : step.id === 'agent-generation'
        ? useSettingsStore.getState().agentMode === 'auto'
        : true,
  );
};

export function shouldAutoStartRevisitGeneration(runParam: string | null): boolean {
  return runParam === '1';
}
