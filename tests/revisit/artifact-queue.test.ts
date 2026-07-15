import { describe, expect, it, vi } from 'vitest';

import {
  createArtifactGenerationQueue,
  restoreArtifactGenerationJobs,
  type ArtifactGenerationJob,
} from '@/lib/revisit/artifact-queue';
import type {
  FaqStudyArtifactOptions,
  QuizStudyArtifactOptions,
  StudyGuideArtifactOptions,
} from '@/lib/revisit/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const options = {
  focusMode: 'balanced',
  selectedSceneIds: [],
  customInstructions: '',
  detailLevel: 'standard',
} satisfies StudyGuideArtifactOptions;

const faqOptions = {
  focusMode: 'balanced',
  selectedSceneIds: [],
  customInstructions: '',
  count: 10,
} satisfies FaqStudyArtifactOptions;

const quizOptions = {
  focusMode: 'balanced',
  selectedSceneIds: [],
  customInstructions: '',
  count: 10,
  difficulty: 'medium',
  format: 'mcq',
} satisfies QuizStudyArtifactOptions;

describe('study artifact generation queue', () => {
  it('runs jobs sequentially while exposing queued and generating states', async () => {
    const first = deferred<{ artifactId: string }>();
    const second = deferred<{ artifactId: string }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const queue = createArtifactGenerationQueue({ execute, createId: vi.fn(() => 'job-1') });

    const firstId = queue.enqueue({ stageId: 'stage-1', kind: 'studyGuide', options });
    queue.setCreateId(() => 'job-2');
    const secondId = queue.enqueue({
      stageId: 'stage-1',
      kind: 'quiz',
      options: quizOptions,
    });

    expect(firstId).toBe('job-1');
    expect(secondId).toBe('job-2');
    expect(queue.getJob(firstId)?.status).toBe('generating');
    expect(queue.getJob(secondId)?.status).toBe('queued');
    expect(execute).toHaveBeenCalledTimes(1);

    first.resolve({ artifactId: 'artifact-1' });
    await vi.waitFor(() => expect(queue.getJob(firstId)?.status).toBe('complete'));
    expect(queue.getJob(secondId)?.status).toBe('generating');
    expect(execute).toHaveBeenCalledTimes(2);

    second.resolve({ artifactId: 'artifact-2' });
    await vi.waitFor(() => expect(queue.getJob(secondId)?.status).toBe('complete'));
  });

  it('deduplicates pending jobs by course and material kind', () => {
    const active = deferred<{ artifactId: string }>();
    const queue = createArtifactGenerationQueue({
      execute: () => active.promise,
      createId: () => 'job-1',
    });

    const firstId = queue.enqueue({ stageId: 'stage-1', kind: 'studyGuide', options });
    const duplicateId = queue.enqueue({ stageId: 'stage-1', kind: 'studyGuide', options });

    expect(duplicateId).toBe(firstId);
    expect(queue.getJobs()).toHaveLength(1);
  });

  it('keeps formal and demo jobs separate and captures their original scope', () => {
    const active = deferred<{ artifactId: string }>();
    let nextId = 0;
    const queue = createArtifactGenerationQueue({
      execute: () => active.promise,
      createId: () => `job-${++nextId}`,
    });

    const formalId = queue.enqueue({
      stageId: 'stage-1',
      kind: 'studyGuide',
      options,
      scope: 'formal',
    });
    const demoId = queue.enqueue({
      stageId: 'stage-1',
      kind: 'studyGuide',
      options,
      scope: 'demo:batch-1',
    });

    expect(demoId).not.toBe(formalId);
    expect(queue.getJob(demoId)?.scope).toBe('demo:batch-1');
  });

  it('keeps a failed job retryable with the same request', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ artifactId: 'artifact-1' });
    const queue = createArtifactGenerationQueue({ execute, createId: () => 'job-1' });
    const jobId = queue.enqueue({ stageId: 'stage-1', kind: 'studyGuide', options });

    await vi.waitFor(() => expect(queue.getJob(jobId)?.status).toBe('failed'));
    expect(queue.getJob(jobId)?.error).toContain('provider unavailable');

    queue.retry(jobId);
    await vi.waitFor(() => expect(queue.getJob(jobId)?.status).toBe('complete'));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('cancels a running job through its AbortSignal and advances the queue', async () => {
    const second = deferred<{ artifactId: string }>();
    const execute = vi.fn((job: ArtifactGenerationJob, signal: AbortSignal) => {
      if (job.id === 'job-1') {
        return new Promise<{ artifactId: string }>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return second.promise;
    });
    let nextId = 0;
    const queue = createArtifactGenerationQueue({
      execute,
      createId: () => `job-${++nextId}`,
    });
    const firstId = queue.enqueue({ stageId: 'stage-1', kind: 'studyGuide', options });
    const secondId = queue.enqueue({
      stageId: 'stage-1',
      kind: 'faq',
      options: faqOptions,
    });

    queue.cancel(firstId);

    await vi.waitFor(() => expect(queue.getJob(firstId)?.status).toBe('cancelled'));
    await vi.waitFor(() => expect(queue.getJob(secondId)?.status).toBe('generating'));
  });

  it('does not overlap the next model task while cancellation is still settling', async () => {
    const cancellationSettled = deferred<{ artifactId: string }>();
    const second = deferred<{ artifactId: string }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(() => cancellationSettled.promise)
      .mockImplementationOnce(() => second.promise);
    let nextId = 0;
    const queue = createArtifactGenerationQueue({
      execute,
      createId: () => `job-${++nextId}`,
    });
    const firstId = queue.enqueue({ stageId: 'stage-1', kind: 'studyGuide', options });
    const secondId = queue.enqueue({ stageId: 'stage-1', kind: 'faq', options: faqOptions });

    queue.cancel(firstId);

    expect(queue.getJob(firstId)?.status).toBe('cancelled');
    expect(queue.getJob(secondId)?.status).toBe('queued');
    expect(execute).toHaveBeenCalledTimes(1);

    cancellationSettled.reject(new DOMException('Generation cancelled', 'AbortError'));
    await vi.waitFor(() => expect(queue.getJob(secondId)?.status).toBe('generating'));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('marks queued and generating jobs interrupted after a full refresh', () => {
    const jobs = restoreArtifactGenerationJobs([
      {
        id: 'queued',
        stageId: 'stage-1',
        kind: 'studyGuide',
        options,
        status: 'queued',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'active',
        stageId: 'stage-1',
        kind: 'quiz',
        options: quizOptions,
        status: 'generating',
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'done',
        stageId: 'stage-1',
        kind: 'faq',
        options: faqOptions,
        status: 'complete',
        artifactId: 'artifact-1',
        createdAt: 3,
        updatedAt: 3,
      },
    ]);

    expect(jobs.map((job) => job.status)).toEqual(['interrupted', 'interrupted', 'complete']);
  });
});
