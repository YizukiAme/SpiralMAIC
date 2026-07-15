import type { StudyArtifactKind, StudyArtifactOptions } from '@/lib/revisit/types';

export type ArtifactGenerationJobStatus =
  | 'queued'
  | 'generating'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ArtifactGenerationRequest {
  stageId: string;
  kind: StudyArtifactKind;
  options: StudyArtifactOptions;
  /** Serialized data scope captured when the job is enqueued. */
  scope?: string;
}

export interface ArtifactGenerationJob extends ArtifactGenerationRequest {
  id: string;
  status: ArtifactGenerationJobStatus;
  createdAt: number;
  updatedAt: number;
  artifactId?: string;
  error?: string;
}

interface ArtifactGenerationResult {
  artifactId: string;
}

type ExecuteArtifactGeneration = (
  job: ArtifactGenerationJob,
  signal: AbortSignal,
) => Promise<ArtifactGenerationResult>;

interface CreateArtifactGenerationQueueOptions {
  execute: ExecuteArtifactGeneration;
  createId?: () => string;
  now?: () => number;
  initialJobs?: ArtifactGenerationJob[];
}

export interface ArtifactGenerationQueue {
  enqueue(request: ArtifactGenerationRequest): string;
  retry(jobId: string): void;
  cancel(jobId: string): void;
  getJob(jobId: string): ArtifactGenerationJob | undefined;
  getJobs(): ArtifactGenerationJob[];
  subscribe(listener: (jobs: ArtifactGenerationJob[]) => void): () => void;
  setCreateId(createId: () => string): void;
}

const PENDING_STATUSES = new Set<ArtifactGenerationJobStatus>(['queued', 'generating']);

export function restoreArtifactGenerationJobs(
  jobs: ArtifactGenerationJob[],
): ArtifactGenerationJob[] {
  return jobs.map((job) =>
    PENDING_STATUSES.has(job.status) ? { ...job, status: 'interrupted' as const } : { ...job },
  );
}

export function createArtifactGenerationQueue({
  execute,
  createId: initialCreateId = () => crypto.randomUUID(),
  now = Date.now,
  initialJobs = [],
}: CreateArtifactGenerationQueueOptions): ArtifactGenerationQueue {
  let createId = initialCreateId;
  let jobs = restoreArtifactGenerationJobs(initialJobs);
  let activeJobId: string | undefined;
  let activeController: AbortController | undefined;
  const listeners = new Set<(nextJobs: ArtifactGenerationJob[]) => void>();

  const publish = () => {
    const snapshot = jobs.map((job) => ({ ...job }));
    for (const listener of listeners) listener(snapshot);
  };

  const updateJob = (
    jobId: string,
    update: Partial<ArtifactGenerationJob>,
  ): ArtifactGenerationJob | undefined => {
    let updated: ArtifactGenerationJob | undefined;
    jobs = jobs.map((job) => {
      if (job.id !== jobId) return job;
      updated = { ...job, ...update, updatedAt: now() };
      return updated;
    });
    if (updated) publish();
    return updated;
  };

  const runNext = () => {
    if (activeJobId) return;
    const next = jobs.find((job) => job.status === 'queued');
    if (!next) return;

    activeJobId = next.id;
    activeController = new AbortController();
    const running = updateJob(next.id, {
      status: 'generating',
      error: undefined,
      artifactId: undefined,
    });
    if (!running) return;

    void execute(running, activeController.signal)
      .then((result) => {
        if (jobs.find((job) => job.id === running.id)?.status === 'generating') {
          updateJob(running.id, {
            status: 'complete',
            artifactId: result.artifactId,
            error: undefined,
          });
        }
      })
      .catch((error: unknown) => {
        const current = jobs.find((job) => job.id === running.id);
        if (!current || current.status === 'cancelled') return;
        updateJob(running.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (activeJobId === running.id) {
          activeJobId = undefined;
          activeController = undefined;
        }
        runNext();
      });
  };

  return {
    enqueue(request) {
      const duplicate = jobs.find(
        (job) =>
          job.stageId === request.stageId &&
          job.kind === request.kind &&
          job.scope === request.scope &&
          PENDING_STATUSES.has(job.status),
      );
      if (duplicate) return duplicate.id;

      const timestamp = now();
      const job: ArtifactGenerationJob = {
        ...request,
        id: createId(),
        status: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      jobs = [...jobs, job];
      publish();
      runNext();
      return job.id;
    },

    retry(jobId) {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status)) return;
      updateJob(jobId, {
        status: 'queued',
        error: undefined,
        artifactId: undefined,
      });
      runNext();
    },

    cancel(jobId) {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || !PENDING_STATUSES.has(job.status)) return;
      updateJob(jobId, { status: 'cancelled', error: undefined });
      if (activeJobId === jobId) {
        activeController?.abort(new DOMException('Generation cancelled', 'AbortError'));
      } else {
        runNext();
      }
    },

    getJob(jobId) {
      const job = jobs.find((candidate) => candidate.id === jobId);
      return job ? { ...job } : undefined;
    },

    getJobs() {
      return jobs.map((job) => ({ ...job }));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setCreateId(nextCreateId) {
      createId = nextCreateId;
    },
  };
}
