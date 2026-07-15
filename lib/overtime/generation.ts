'use client';

import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import {
  fetchSceneActions,
  fetchSceneContent,
  generateTTSForScene,
} from '@/lib/hooks/use-scene-generator';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { materializeOvertimePlan } from '@/lib/overtime/concepts';
import {
  checkpointOvertimeExtension,
  commitOvertimeExtension,
  getOvertimeExtension,
  markOvertimeExtensionFailed,
} from '@/lib/overtime/store';
import type { OvertimeExtension, OvertimePlanDraft } from '@/lib/overtime/types';
import { upsertLessonConcepts } from '@/lib/revisit/db';
import type { LessonConcept } from '@/lib/revisit/types';
import type { SceneOutline } from '@/lib/types/generation';
import { makeScene, type Scene, type Stage } from '@/lib/types/stage';
import { isAbortError } from '@/lib/generation/generation-retry';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

type ContentResult = Awaited<ReturnType<typeof fetchSceneContent>>;
type ActionsResult = Awaited<ReturnType<typeof fetchSceneActions>>;

export interface OvertimeGenerationDependencies {
  getExtension: (id: string) => Promise<OvertimeExtension | undefined>;
  requestPlan: (args: {
    stage: Stage;
    scenes: Scene[];
    extension: OvertimeExtension;
    knownConcepts: LessonConcept[];
    signal?: AbortSignal;
  }) => Promise<OvertimePlanDraft>;
  checkpoint: typeof checkpointOvertimeExtension;
  markFailed: typeof markOvertimeExtensionFailed;
  fetchContent: typeof fetchSceneContent;
  fetchActions: typeof fetchSceneActions;
  generateTTS: typeof generateTTSForScene;
  generateMedia: typeof generateMediaForOutlines;
  upsertConcepts: (concepts: LessonConcept[]) => Promise<void>;
  commit: typeof commitOvertimeExtension;
}

const defaultDependencies: OvertimeGenerationDependencies = {
  getExtension: getOvertimeExtension,
  requestPlan: requestOvertimePlan,
  checkpoint: checkpointOvertimeExtension,
  markFailed: markOvertimeExtensionFailed,
  fetchContent: fetchSceneContent,
  fetchActions: fetchSceneActions,
  generateTTS: generateTTSForScene,
  generateMedia: generateMediaForOutlines,
  upsertConcepts: (concepts) => upsertLessonConcepts(concepts),
  commit: commitOvertimeExtension,
};

function modelHeaders(): Record<string, string> {
  const config = getCurrentModelConfig();
  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
  };
}

export async function requestOvertimePlan(args: {
  stage: Stage;
  scenes: Scene[];
  extension: OvertimeExtension;
  knownConcepts: LessonConcept[];
  signal?: AbortSignal;
}): Promise<OvertimePlanDraft> {
  const response = await fetch('/api/overtime/plan', {
    method: 'POST',
    headers: modelHeaders(),
    signal: args.signal,
    body: JSON.stringify({
      stage: args.stage,
      scenes: args.scenes,
      request: args.extension.decision,
      knownConcepts: args.knownConcepts.map((concept) => ({
        conceptId: concept.conceptId,
        label: concept.label,
        summary: concept.summary,
        sourceSceneIds: concept.sourceSceneIds,
      })),
      ...(getCurrentModelConfig().thinkingConfig
        ? { thinkingConfig: getCurrentModelConfig().thinkingConfig }
        : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    plan?: OvertimePlanDraft;
    error?: string;
    details?: string;
  };
  if (!response.ok || !body.success || !body.plan) {
    throw new Error(
      body.details || body.error || `Overtime planning failed: HTTP ${response.status}`,
    );
  }
  return body.plan;
}

export async function runOvertimeGeneration(args: {
  extensionId: string;
  stage: Stage;
  scenes: Scene[];
  existingOutlines: SceneOutline[];
  knownConcepts: LessonConcept[];
  agents?: AgentInfo[];
  userProfile?: string;
  now?: () => number;
  signal?: AbortSignal;
  dependencies?: OvertimeGenerationDependencies;
  onProgress?: (extension: OvertimeExtension) => void;
  onReady?: (scene: Scene, outline: SceneOutline) => void;
}): Promise<OvertimeExtension> {
  const dependencies = args.dependencies ?? defaultDependencies;
  const now = args.now ?? Date.now;
  let extension = await dependencies.getExtension(args.extensionId);
  if (!extension) throw new Error(`Overtime extension ${args.extensionId} was not found.`);
  if (extension.status === 'ready') return extension;
  args.onProgress?.(extension);

  try {
    let plan = extension.plan;
    if (!plan) {
      plan = await dependencies.requestPlan({
        stage: args.stage,
        scenes: args.scenes,
        extension,
        knownConcepts: args.knownConcepts,
        signal: args.signal,
      });
    }

    const materialized = materializeOvertimePlan({
      extension,
      plan,
      knownConcepts: args.knownConcepts,
      now: now(),
    });
    let outline = extension.outline ?? materialized.outline;
    if (!extension.plan || !extension.outline) {
      extension = await dependencies.checkpoint(extension.id, {
        status: 'generating',
        phase: 'content',
        plan,
        outline,
        error: undefined,
        updatedAt: now(),
      });
      args.onProgress?.(extension);
    }

    const buildAllOutlines = () =>
      [...args.existingOutlines.filter((candidate) => candidate.id !== outline.id), outline].sort(
        (a, b) => a.order - b.order,
      );
    let allOutlines = buildAllOutlines();
    let content = extension.content;
    if (content === undefined) {
      const result: ContentResult = await dependencies.fetchContent(
        {
          outline,
          allOutlines,
          stageId: args.stage.id,
          stageInfo: {
            name: args.stage.name,
            description: args.stage.description,
            style: args.stage.style,
          },
          agents: args.agents,
          languageDirective: args.stage.languageDirective,
        },
        args.signal,
      );
      if (!result.success || result.content === undefined) {
        throw new Error(result.error || 'Overtime page content generation failed.');
      }
      content = result.content;
      if (result.effectiveOutline) {
        outline = {
          ...result.effectiveOutline,
          id: materialized.outline.id,
          order: materialized.outline.order,
        };
        allOutlines = buildAllOutlines();
      }
      extension = await dependencies.checkpoint(extension.id, {
        status: 'generating',
        phase: 'actions',
        plan,
        outline,
        content,
        error: undefined,
        updatedAt: now(),
      });
      args.onProgress?.(extension);
      await dependencies.generateMedia([outline], args.stage.id, args.signal);
    }

    let scene = extension.scene;
    if (!scene) {
      const previousSpeeches = args.scenes
        .flatMap((candidate) => candidate.actions ?? [])
        .filter((action) => action.type === 'speech')
        .map((action) => action.text)
        .slice(-6);
      const result: ActionsResult = await dependencies.fetchActions(
        {
          outline,
          allOutlines,
          content,
          stageId: args.stage.id,
          agents: args.agents,
          previousSpeeches,
          userProfile: args.userProfile,
          languageDirective: args.stage.languageDirective,
        },
        args.signal,
      );
      if (!result.success || !result.scene) {
        throw new Error(result.error || 'Overtime page actions generation failed.');
      }
      const generated = result.scene;
      const { type: _type, content: generatedContent, ...core } = generated;
      scene = makeScene(
        {
          ...core,
          id: outline.id,
          stageId: args.stage.id,
          title: outline.title,
          order: outline.order,
          outlineId: outline.id,
          overtime: {
            extensionId: extension.id,
            sequence: extension.sequence,
            teachingMove: extension.decision.teachingMove,
            conceptIds: materialized.conceptIds,
            sourceSceneIds: plan.sourceSceneIds,
          },
        },
        generatedContent,
      );
      extension = await dependencies.checkpoint(extension.id, {
        status: 'generating',
        phase: 'tts',
        plan,
        outline,
        content,
        scene,
        error: undefined,
        updatedAt: now(),
      });
      args.onProgress?.(extension);
    }

    if (extension.phase === 'tts') {
      const tts = await dependencies.generateTTS(scene, args.stage.languageDirective, args.signal);
      if (!tts.success) throw new Error(tts.error || 'Overtime page TTS generation failed.');
      extension = await dependencies.checkpoint(extension.id, {
        status: 'generating',
        phase: 'commit',
        scene,
        updatedAt: now(),
      });
      args.onProgress?.(extension);
    }

    await dependencies.upsertConcepts(materialized.concepts);
    const ready = await dependencies.commit({
      extensionId: extension.id,
      outline,
      scene,
      now: now(),
    });
    args.onProgress?.(ready);
    args.onReady?.(scene, outline);
    return ready;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAbortError(error)) {
      extension = await dependencies.checkpoint(extension.id, {
        status: 'interrupted',
        phase: extension.phase,
        updatedAt: now(),
      });
      args.onProgress?.(extension);
    } else {
      await dependencies.markFailed(extension.id, message, now());
      const failed = await dependencies.getExtension(extension.id);
      if (failed) args.onProgress?.(failed);
    }
    throw error;
  }
}
