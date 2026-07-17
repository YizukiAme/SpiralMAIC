import {
  ScanLine,
  Search,
  Bot,
  FileText,
  LayoutPanelLeft,
  Clapperboard,
  BrainCircuit,
} from 'lucide-react';
import { useSettingsStore } from '@/lib/store/settings';
import type {
  SceneOutline,
  UserRequirements,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
} from '@/lib/types/generation';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';

// Session state stored in sessionStorage
export interface GenerationSessionState {
  sessionId: string;
  mode?: 'course' | 'revisit';
  requirements: UserRequirements;
  pdfText: string;
  documentSources?: SessionDocumentSource[];
  pdfImages?: PdfImage[];
  imageStorageIds?: string[];
  imageMapping?: ImageMapping;
  sceneOutlines?: SceneOutline[] | null;
  currentStep: 'generating' | 'complete';
  previewPhase?: 'preparing' | 'outline-ready' | 'review' | 'generating-content';
  // PDF deferred parsing fields
  pdfStorageKey?: string;
  pdfFileName?: string;
  documentMimeType?: string;
  pdfProviderId?: string;
  pdfProviderConfig?: {
    apiKey?: string;
    baseUrl?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
  };
  // Web search context
  researchContext?: string;
  researchSources?: Array<{ title: string; url: string }>;
  // Language directive inferred from outline generation
  languageDirective?: string;
  // Concise course title inferred from outline generation (used as the stage name)
  courseTitle?: string;
  // Server-effective vocational mode from the outline generation done event.
  taskEngineMode?: boolean;
  // Reverse Challenge generation session. Course generation leaves this empty.
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

const MEDIA_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'mp3', 'wav', 'aac', 'm4a']);

/** True when the uploaded material is audio/video (extraction is transcription). */
function isMediaMaterial(session: GenerationSessionState | null): boolean {
  const mimeType = session?.documentMimeType;
  if (mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) return true;
  const extension = session?.pdfFileName?.split('.').pop()?.trim().toLowerCase();
  return !!extension && MEDIA_EXTENSIONS.has(extension);
}

export function getGenerationStepText(
  step: GenerationStep,
  session: GenerationSessionState | null,
) {
  if (step.id === 'pdf-analysis') {
    // Audio/video use a dedicated string ("Analyzing audio/video") — the
    // generic document copy ("Analyzing documents") would misdescribe them.
    if (isMediaMaterial(session)) {
      return {
        title: 'generation.analyzingMediaMaterial',
        titleValues: undefined,
        description: 'generation.analyzingCourseMaterialDesc',
      };
    }
    return {
      title: 'generation.analyzingCourseMaterial',
      titleValues: undefined,
      description: 'generation.analyzingCourseMaterialDesc',
    };
  }
  return {
    title: step.title,
    titleValues: undefined,
    description: step.description,
  };
}

export const ALL_STEPS: GenerationStep[] = [
  {
    id: 'pdf-analysis',
    title: 'generation.analyzingCourseMaterial',
    description: 'generation.analyzingCourseMaterialDesc',
    icon: ScanLine,
    type: 'analysis',
  },
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

export const getActiveSteps = (session: GenerationSessionState | null) => {
  if (session?.mode === 'revisit') {
    return REVISIT_STEPS.filter(
      (step) =>
        step.id !== 'agent-generation' || session.revisit?.showSpiralAgentGenerationStep === true,
    );
  }

  return ALL_STEPS.filter((step) => {
    if (step.id === 'pdf-analysis') {
      return Boolean(
        session?.pdfStorageKey ||
        ((session?.documentSources?.length ?? 0) > 0 && !session?.pdfText),
      );
    }
    if (step.id === 'web-search') return !!session?.requirements?.webSearch;
    if (step.id === 'agent-generation') return useSettingsStore.getState().agentMode === 'auto';
    return true;
  });
};

export function shouldAutoStartRevisitGeneration(runParam: string | null): boolean {
  return runParam === '1';
}
