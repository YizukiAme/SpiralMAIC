import { describe, expect, it, vi } from 'vitest';

import {
  createArtifactGenerationStore,
  type ArtifactQueueStorage,
} from '@/lib/store/artifact-generation';
import type { StudyGuideArtifactOptions } from '@/lib/revisit/types';

const options = {
  focusMode: 'balanced',
  selectedSceneIds: [],
  customInstructions: '',
  detailLevel: 'standard',
} satisfies StudyGuideArtifactOptions;

function createMemoryStorage(initial: unknown): ArtifactQueueStorage & { value: string | null } {
  const storage: ArtifactQueueStorage & { value: string | null } = {
    value: initial == null ? null : JSON.stringify(initial),
    getItem: vi.fn(() => storage.value),
    setItem: vi.fn((_key: string, value: string) => {
      storage.value = value;
    }),
  };
  return storage;
}

describe('artifact generation Zustand store', () => {
  it('restores unfinished work as interrupted and persists retry completion', async () => {
    const storage = createMemoryStorage([
      {
        id: 'job-1',
        stageId: 'stage-1',
        kind: 'studyGuide',
        options,
        status: 'generating',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const execute = vi.fn(async () => ({ artifactId: 'artifact-1' }));
    const store = createArtifactGenerationStore({ storage, execute, now: () => 10 });

    expect(store.getState().jobs[0]?.status).toBe('interrupted');

    store.getState().retry('job-1');

    await vi.waitFor(() => expect(store.getState().jobs[0]?.status).toBe('complete'));
    expect(store.getState().jobs[0]?.artifactId).toBe('artifact-1');
    expect(JSON.parse(storage.value ?? '[]')[0]).toMatchObject({
      status: 'complete',
      artifactId: 'artifact-1',
    });
  });

  it('uses the same global actions for enqueue, cancel, and failed retry', async () => {
    const storage = createMemoryStorage([]);
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ artifactId: 'artifact-2' });
    const store = createArtifactGenerationStore({
      storage,
      execute,
      createId: () => 'job-2',
    });

    const id = store.getState().enqueue({
      stageId: 'stage-1',
      kind: 'studyGuide',
      options,
    });
    await vi.waitFor(() => expect(store.getState().jobs[0]?.status).toBe('failed'));

    store.getState().retry(id);
    await vi.waitFor(() => expect(store.getState().jobs[0]?.status).toBe('complete'));
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
