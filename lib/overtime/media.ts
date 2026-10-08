'use client';

import { generateMediaForScene } from '@/lib/media/media-orchestrator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';

/** The appended page is durable before media writes its allocated references into it. */
export async function generateOvertimeMedia(
  outlines: SceneOutline[],
  stageId: string,
  signal?: AbortSignal,
): Promise<void> {
  const requests = outlines.flatMap((outline) => outline.mediaGenerations ?? []);
  if (!requests.length || signal?.aborted) return;
  useMediaGenerationStore.getState().enqueueTasks(stageId, requests);
  for (const request of requests) {
    if (signal?.aborted) return;
    await generateMediaForScene(request, stageId, signal);
  }
}
