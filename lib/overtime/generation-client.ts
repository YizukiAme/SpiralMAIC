'use client';

import type { AgentInfo } from '@openmaic/generation';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@openmaic/generation/browser';
import { generateAndStoreTTS } from '@/lib/audio/narration-tts';
import { ttsSelection } from '@/lib/audio/tts-selection';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { loadModelCapabilities } from '@/lib/model-settings/capabilities';
import type { SpeechAction } from '@/lib/types/action';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { Scene } from '@/lib/types/stage';
import { buildModelRequestHeaders, getCurrentModelConfig } from '@/lib/utils/model-config';

interface GenerationResult {
  success: boolean;
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

export interface SceneContentResult extends GenerationResult {
  content?: unknown;
  effectiveOutline?: SceneOutline;
}

export interface SceneActionsResult extends GenerationResult {
  scene?: Scene;
  previousSpeeches?: string[];
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

async function requestStep<T extends GenerationResult>(
  path: string,
  body: object,
  label: string,
  complete: (result: T) => boolean,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<T>,
): Promise<T> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            ...buildModelRequestHeaders(getCurrentModelConfig()),
          },
          body: JSON.stringify(body),
          signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(
            data.details || data.error || `${label} failed: HTTP ${response.status}`,
          ) as Error & { errorCode?: string; statusCode: number };
          error.statusCode = response.status;
          if (typeof data.errorCode === 'string') error.errorCode = data.errorCode;
          throw error;
        }
        return data as T;
      },
      { label, shouldRetryResult: (result) => !complete(result), ...retryOptions, signal },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    const failure = error as Error & { errorCode?: string; statusCode?: number };
    return {
      success: false,
      error: failure.message || `${label} failed`,
      ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
      ...(failure.statusCode ? { statusCode: failure.statusCode } : {}),
    } as T;
  }
}

/** The app's appended pages and review skeletons share the server content step. */
export function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    stageInfo: { name: string; description?: string; language?: string; style?: string };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: Partial<UserRequirements>;
    thinkingConfig?: ThinkingConfig;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  return requestStep(
    '/api/overtime/scene-content',
    params,
    `scene content "${params.outline.title}"`,
    (result: SceneContentResult) => result.success && result.content !== undefined,
    signal,
    retryOptions,
  );
}

export function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    userProfile?: string;
    languageDirective?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  return requestStep(
    '/api/overtime/scene-actions',
    params,
    `scene actions "${params.outline.title}"`,
    (result: SceneActionsResult) => result.success && !!result.scene,
    signal,
    retryOptions,
  );
}

/** Keep completed clips on the scene so the overtime checkpoint can resume without rebilling. */
export async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; failedCount: number; error?: string }> {
  const selection = ttsSelection(await loadModelCapabilities());
  if (!selection || selection.providerId === 'browser-native-tts') {
    return { success: true, failedCount: 0 };
  }
  scene.actions = (scene.actions ?? []).flatMap((action) =>
    action.type === 'speech' && action.audioId
      ? [action]
      : splitLongSpeechActions([action], selection.providerId),
  );
  const speeches = scene.actions.filter(
    (action): action is SpeechAction => action.type === 'speech' && !!action.text,
  );
  let failedCount = 0;
  let lastError: string | undefined;
  for (const action of speeches) {
    if (action.audioId) continue;
    try {
      const assetId = await generateAndStoreTTS(
        `tts_s${scene.order}_${action.id}`,
        action.text,
        language,
        signal,
        undefined,
        scene.stageId,
      );
      if (assetId) action.audioId = assetId;
    } catch (error) {
      if (isAbortError(error)) throw error;
      failedCount++;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { success: failedCount === 0, failedCount, ...(lastError ? { error: lastError } : {}) };
}
