export const CODEX_RESPONSE_LIMITS: {
  readonly totalTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxBytes: number;
} = {
  totalTimeoutMs: 15 * 60_000,
  idleTimeoutMs: 3 * 60_000,
  maxBytes: 32 * 1024 * 1024,
} as const;

export type CodexResponseGuardFailure =
  | 'caller-abort'
  | 'lifecycle-abort'
  | 'timeout'
  | 'idle-timeout'
  | 'body-too-large'
  | 'body-read-failed'
  | 'stale-at-eof';

export class CodexResponseGuardError extends Error {
  constructor(public readonly failure: CodexResponseGuardFailure) {
    super('Codex response transport failed');
    this.name = 'CodexResponseGuardError';
  }
}

export interface CodexResponseRequestGuard {
  readonly signal: AbortSignal;
  race<T>(operation: Promise<T>): Promise<T>;
  bind(
    response: Response,
    options: {
      assertCurrent: () => Promise<boolean>;
      errorForFailure: (failure: CodexResponseGuardFailure) => Error;
    },
  ): Response;
  dispose(): void;
}

async function cancelLateResponse(value: unknown): Promise<void> {
  if (!(value instanceof Response)) return;
  try {
    await value.body?.cancel();
  } catch {
    // A late or already-locked response is never published to the caller.
  }
}

export function createCodexResponseRequestGuard(options: {
  callerSignal?: AbortSignal;
  lifecycleSignal?: AbortSignal | null;
  deadlineAt: number;
  limits?: Partial<typeof CODEX_RESPONSE_LIMITS>;
}): CodexResponseRequestGuard {
  const limits = { ...CODEX_RESPONSE_LIMITS, ...options.limits };
  const controller = new AbortController();
  let disposed = false;
  let failure: CodexResponseGuardFailure | null = null;
  let resourcesCleared = false;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let boundFailureHandler: ((nextFailure: CodexResponseGuardFailure) => void) | null = null;
  const failureWaiters = new Set<(nextFailure: CodexResponseGuardFailure) => void>();

  const onCallerAbort = () => fail('caller-abort');
  const onLifecycleAbort = () => fail('lifecycle-abort');

  function clearResources(): void {
    if (resourcesCleared) return;
    resourcesCleared = true;
    if (totalTimer !== null) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    options.callerSignal?.removeEventListener('abort', onCallerAbort);
    options.lifecycleSignal?.removeEventListener('abort', onLifecycleAbort);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    boundFailureHandler = null;
    failureWaiters.clear();
    clearResources();
  }

  function fail(nextFailure: CodexResponseGuardFailure): void {
    if (disposed || failure !== null) return;
    failure = nextFailure;
    clearResources();
    for (const waiter of failureWaiters) waiter(nextFailure);
    failureWaiters.clear();
    controller.abort();
    boundFailureHandler?.(nextFailure);
  }

  function resetIdleTimer(): void {
    if (disposed || failure !== null) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail('idle-timeout'), Math.max(0, limits.idleTimeoutMs));
  }

  if (options.callerSignal?.aborted) {
    fail('caller-abort');
  } else if (options.lifecycleSignal?.aborted) {
    fail('lifecycle-abort');
  } else {
    options.callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    options.lifecycleSignal?.addEventListener('abort', onLifecycleAbort, { once: true });
    const remainingMs = options.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      fail('timeout');
    } else {
      totalTimer = setTimeout(() => fail('timeout'), remainingMs);
    }
  }

  function race<T>(operation: Promise<T>): Promise<T> {
    if (failure !== null) {
      void operation.then(cancelLateResponse, () => undefined);
      return Promise.reject(new CodexResponseGuardError(failure));
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onFailure = (nextFailure: CodexResponseGuardFailure) => {
        if (settled) return;
        settled = true;
        failureWaiters.delete(onFailure);
        reject(new CodexResponseGuardError(nextFailure));
      };
      failureWaiters.add(onFailure);

      void operation.then(
        (value) => {
          if (settled) {
            void cancelLateResponse(value);
            return;
          }
          settled = true;
          failureWaiters.delete(onFailure);
          if (failure !== null) {
            void cancelLateResponse(value);
            reject(new CodexResponseGuardError(failure));
            return;
          }
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          failureWaiters.delete(onFailure);
          if (failure !== null) {
            reject(new CodexResponseGuardError(failure));
            return;
          }
          reject(error);
        },
      );

      if (failure !== null) onFailure(failure);
    });
  }

  function bind(
    response: Response,
    bindOptions: {
      assertCurrent: () => Promise<boolean>;
      errorForFailure: (nextFailure: CodexResponseGuardFailure) => Error;
    },
  ): Response {
    const upstreamBody =
      response.body ??
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.close();
        },
      });
    const reader = upstreamBody.getReader();
    let bytesRead = 0;
    let terminated = false;
    let upstreamCancelled = false;
    let guardedController!: ReadableStreamDefaultController<Uint8Array>;

    function cancelUpstream(): Promise<void> {
      if (upstreamCancelled) return Promise.resolve();
      upstreamCancelled = true;
      return reader.cancel().catch(() => undefined);
    }

    function errorBody(nextFailure: CodexResponseGuardFailure): void {
      if (terminated) return;
      terminated = true;
      void cancelUpstream();
      guardedController.error(bindOptions.errorForFailure(nextFailure));
      dispose();
    }

    async function pull(): Promise<void> {
      while (!terminated) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await race(reader.read());
        } catch (error) {
          if (terminated) return;
          if (error instanceof CodexResponseGuardError) {
            fail(error.failure);
          } else {
            fail('body-read-failed');
          }
          return;
        }
        if (terminated) return;

        if (result.done) {
          let isCurrent = false;
          try {
            isCurrent = await race(
              Promise.resolve().then(() => (terminated ? false : bindOptions.assertCurrent())),
            );
          } catch (error) {
            if (terminated) return;
            if (error instanceof CodexResponseGuardError) {
              fail(error.failure);
            } else {
              fail('stale-at-eof');
            }
            return;
          }
          if (terminated) return;
          if (!isCurrent) {
            fail('stale-at-eof');
            return;
          }
          if (failure !== null || terminated) return;
          terminated = true;
          boundFailureHandler = null;
          dispose();
          guardedController.close();
          return;
        }

        const chunk = result.value;
        if (chunk.byteLength === 0) continue;
        bytesRead += chunk.byteLength;
        if (bytesRead > limits.maxBytes) {
          fail('body-too-large');
          return;
        }
        if (failure !== null || options.lifecycleSignal?.aborted) {
          fail(failure ?? 'lifecycle-abort');
          return;
        }
        guardedController.enqueue(chunk);
        resetIdleTimer();
        return;
      }
    }

    const guardedBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        guardedController = streamController;
      },
      pull,
      async cancel() {
        if (terminated) return;
        terminated = true;
        boundFailureHandler = null;
        dispose();
        await cancelUpstream();
      },
    });

    boundFailureHandler = errorBody;
    if (failure !== null) {
      errorBody(failure);
    } else {
      resetIdleTimer();
    }

    return new Response(guardedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return {
    bind,
    dispose,
    race,
    signal: controller.signal,
  };
}
