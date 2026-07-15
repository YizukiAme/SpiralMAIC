'use client';

import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  createArtifactGenerationQueue,
  type ArtifactGenerationJob,
  type ArtifactGenerationQueue,
  type ArtifactGenerationRequest,
} from '@/lib/revisit/artifact-queue';
import { parseRevisitScope } from '@/lib/revisit/scope';
import { getRevisitNow } from '@/lib/revisit/clock';

const ARTIFACT_QUEUE_STORAGE_KEY = 'spiral-study-artifact-queue-v1';

export interface ArtifactQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ArtifactGenerationStoreState {
  jobs: ArtifactGenerationJob[];
  enqueue: ArtifactGenerationQueue['enqueue'];
  retry: ArtifactGenerationQueue['retry'];
  cancel: ArtifactGenerationQueue['cancel'];
}

interface CreateArtifactGenerationStoreOptions {
  execute: (job: ArtifactGenerationJob, signal: AbortSignal) => Promise<{ artifactId: string }>;
  storage?: ArtifactQueueStorage;
  createId?: () => string;
  now?: () => number;
}

export function createArtifactGenerationStore({
  execute,
  storage,
  createId,
  now,
}: CreateArtifactGenerationStoreOptions): StoreApi<ArtifactGenerationStoreState> {
  const initialJobs = readStoredJobs(storage);
  const queue = createArtifactGenerationQueue({ execute, createId, now, initialJobs });
  const store = createStore<ArtifactGenerationStoreState>(() => ({
    jobs: queue.getJobs(),
    enqueue: (request: ArtifactGenerationRequest) => queue.enqueue(request),
    retry: (jobId: string) => queue.retry(jobId),
    cancel: (jobId: string) => queue.cancel(jobId),
  }));

  queue.subscribe((jobs) => {
    store.setState({ jobs });
    writeStoredJobs(storage, jobs);
  });
  writeStoredJobs(storage, queue.getJobs());

  return store;
}

async function executeArtifactGeneration(
  job: ArtifactGenerationJob,
  signal: AbortSignal,
): Promise<{ artifactId: string }> {
  const [stageStorage, revisitClient, settingsModule] = await Promise.all([
    import('@/lib/utils/stage-storage'),
    import('@/lib/revisit/client'),
    import('@/lib/store/settings'),
  ]);
  const stageData = await stageStorage.loadStageData(job.stageId);
  if (!stageData?.stage) throw new Error('Course data is unavailable.');

  const settings = settingsModule.useSettingsStore.getState();
  const scope = parseRevisitScope(job.scope);
  const artifact = await revisitClient.generateRevisitStudyArtifact({
    stage: stageData.stage,
    scenes: stageData.scenes,
    kind: job.kind,
    options: job.options,
    stableSuccessesRequired: settings.stableSuccessesRequired,
    scope,
    now: await getRevisitNow(scope),
    signal,
  });
  return { artifactId: artifact.id };
}

function resolveBrowserStorage(): ArtifactQueueStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.localStorage;
}

function readStoredJobs(storage?: ArtifactQueueStorage): ArtifactGenerationJob[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(ARTIFACT_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ArtifactGenerationJob[]) : [];
  } catch {
    return [];
  }
}

function writeStoredJobs(
  storage: ArtifactQueueStorage | undefined,
  jobs: ArtifactGenerationJob[],
): void {
  if (!storage) return;
  try {
    storage.setItem(ARTIFACT_QUEUE_STORAGE_KEY, JSON.stringify(jobs));
  } catch {
    // A full or unavailable localStorage must not break active generation.
  }
}

export const artifactGenerationStore = createArtifactGenerationStore({
  execute: executeArtifactGeneration,
  storage: resolveBrowserStorage(),
});

export function useArtifactGenerationStore<T>(
  selector: (state: ArtifactGenerationStoreState) => T,
): T {
  return useStore(artifactGenerationStore, selector);
}
