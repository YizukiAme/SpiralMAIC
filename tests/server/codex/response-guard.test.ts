import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CodexResponseGuardError,
  createCodexResponseRequestGuard,
  type CodexResponseGuardFailure,
} from '@/lib/server/codex/response-guard';

const NOW = 1_700_000_000_000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function controllableByteStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const cancel = vi.fn(() => {
    cancelled = true;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
    cancel,
  });

  return {
    cancel,
    close() {
      if (!cancelled) controller.close();
    },
    enqueue(chunk: Uint8Array) {
      if (!cancelled) controller.enqueue(chunk);
    },
    error(error: unknown) {
      if (!cancelled) controller.error(error);
    },
    stream,
  };
}

function churningByteStream(chunk: Uint8Array, chunkCount: number) {
  let pulls = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls <= chunkCount) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel,
  });
  return {
    cancel,
    get pulls() {
      return pulls;
    },
    stream,
  };
}

function neverSettlingCancelByteStream() {
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const stream = new ReadableStream<Uint8Array>({
    cancel,
  });
  return { cancel, stream };
}

function bindGuard(
  guard: ReturnType<typeof createCodexResponseRequestGuard>,
  response: Response,
  assertCurrent: () => Promise<boolean> = async () => true,
) {
  return guard.bind(response, {
    assertCurrent,
    errorForFailure: (failure) => new CodexResponseGuardError(failure),
  });
}

function testGuardOptions(
  overrides: Partial<Parameters<typeof createCodexResponseRequestGuard>[0]> = {},
): Parameters<typeof createCodexResponseRequestGuard>[0] {
  return {
    deadlineAt: Date.now() + 1_000,
    limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 500, maxBytes: 32 },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Codex response request guard', () => {
  it('rejects before headers and cancels a late response when lifecycle invalidation wins', async () => {
    const lifecycle = new AbortController();
    const late = deferred<Response>();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ lifecycleSignal: lifecycle.signal }),
    );

    const raced = guard.race(late.promise);
    lifecycle.abort('account-id access-token');

    await expect(raced).rejects.toMatchObject({ failure: 'lifecycle-abort' });

    const source = controllableByteStream();
    late.resolve(new Response(source.stream));
    await vi.waitFor(() => expect(source.cancel).toHaveBeenCalledTimes(1));
  });

  it('stops before the first chunk after lifecycle invalidation', async () => {
    const lifecycle = new AbortController();
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ lifecycleSignal: lifecycle.signal }),
    );
    const reader = bindGuard(guard, new Response(source.stream)).body!.getReader();

    const read = reader.read();
    lifecycle.abort();

    await expect(read).rejects.toMatchObject({ failure: 'lifecycle-abort' });
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('stops before the next chunk after lifecycle invalidation', async () => {
    const lifecycle = new AbortController();
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ lifecycleSignal: lifecycle.signal }),
    );
    const reader = bindGuard(guard, new Response(source.stream)).body!.getReader();

    source.enqueue(Uint8Array.of(1));
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: Uint8Array.of(1),
    });

    const nextRead = reader.read();
    lifecycle.abort();

    await expect(nextRead).rejects.toMatchObject({ failure: 'lifecycle-abort' });
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('classifies an already-aborted caller without exposing its reason', async () => {
    const caller = new AbortController();
    caller.abort('secret caller reason');
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ callerSignal: caller.signal }),
    );

    const error = await guard.race(new Promise<never>(() => undefined)).catch((caught) => caught);

    expect(error).toBeInstanceOf(CodexResponseGuardError);
    expect(error).toMatchObject({ failure: 'caller-abort' });
    expect(String(error)).not.toContain('secret caller reason');
  });

  it('enforces the absolute total deadline while an operation is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const guard = createCodexResponseRequestGuard({
      deadlineAt: NOW + 100,
      limits: { totalTimeoutMs: 100, idleTimeoutMs: 50, maxBytes: 32 },
    });
    const raced = guard.race(new Promise<never>(() => undefined));

    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void raced.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(raced).rejects.toMatchObject({ failure: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('synchronously observes cancellation published after a completed race', async () => {
    const caller = new AbortController();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ callerSignal: caller.signal }),
    );

    await expect(guard.race(Promise.resolve('complete'))).resolves.toBe('complete');
    caller.abort('late-secret');

    expect(() => guard.assertActive()).toThrow(
      expect.objectContaining({ failure: 'caller-abort' }),
    );
  });

  it('synchronously enforces the absolute deadline even before its timer callback runs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const guard = createCodexResponseRequestGuard({
      deadlineAt: NOW + 100,
      limits: { totalTimeoutMs: 100, idleTimeoutMs: 50, maxBytes: 32 },
    });

    vi.setSystemTime(NOW + 100);

    expect(() => guard.assertActive()).toThrow(expect.objectContaining({ failure: 'timeout' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts idle time only after a successful response body is bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const guard = createCodexResponseRequestGuard({
      deadlineAt: NOW + 1_000,
      limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 50, maxBytes: 32 },
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(guard.race(Promise.resolve('headers'))).resolves.toBe('headers');

    const source = controllableByteStream();
    const read = bindGuard(guard, new Response(source.stream)).body!.getReader().read();
    await vi.advanceTimersByTimeAsync(49);
    let settled = false;
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(read).rejects.toMatchObject({ failure: 'idle-timeout' });
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets idle time only after a non-empty upstream chunk', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard({
      deadlineAt: NOW + 1_000,
      limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 50, maxBytes: 32 },
    });
    const reader = bindGuard(guard, new Response(source.stream)).body!.getReader();

    await vi.advanceTimersByTimeAsync(40);
    source.enqueue(new Uint8Array());
    source.enqueue(Uint8Array.of(1));
    await expect(reader.read()).resolves.toMatchObject({ value: Uint8Array.of(1) });

    const nextRead = reader.read();
    await vi.advanceTimersByTimeAsync(49);
    source.enqueue(Uint8Array.of(2));
    await expect(nextRead).resolves.toMatchObject({ value: Uint8Array.of(2) });

    const finalRead = reader.read();
    const finalExpectation = expect(finalRead).rejects.toMatchObject({
      failure: 'idle-timeout',
    });
    await vi.advanceTimersByTimeAsync(50);
    await finalExpectation;
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('yields during zero-byte churn so the idle timeout can run', async () => {
    const source = churningByteStream(new Uint8Array(), 50_000);
    const guard = createCodexResponseRequestGuard({
      deadlineAt: Date.now() + 1_000,
      limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 1, maxBytes: 32 },
    });
    const reader = bindGuard(guard, new Response(source.stream)).body!.getReader();

    await expect(reader.read()).rejects.toMatchObject({ failure: 'idle-timeout' });
    expect(source.pulls).toBeLessThan(50_000);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('yields across non-empty pulls so the absolute deadline can run', async () => {
    const source = churningByteStream(Uint8Array.of(1), 50_000);
    const guard = createCodexResponseRequestGuard({
      deadlineAt: Date.now() + 1,
      limits: { totalTimeoutMs: 1, idleTimeoutMs: 1_000, maxBytes: 100_000 },
    });
    const guarded = bindGuard(guard, new Response(source.stream));

    await expect(guarded.arrayBuffer()).rejects.toMatchObject({ failure: 'timeout' });
    expect(source.pulls).toBeLessThan(50_000);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not forward a first chunk whose source microtasks outlive the total deadline', async () => {
    const startedAt = Date.now();
    const deadlineAt = startedAt + 10;
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (Date.now() <= deadlineAt + 5) await Promise.resolve();
          controller.enqueue(Uint8Array.of(1));
        },
      },
      { highWaterMark: 0 },
    );
    const guard = createCodexResponseRequestGuard({
      deadlineAt,
      limits: { totalTimeoutMs: 10, idleTimeoutMs: 1_000, maxBytes: 32 },
    });
    const reader = bindGuard(guard, new Response(source)).body!.getReader();

    await expect(reader.read()).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('rechecks the total deadline in the microtask gap after a raw read resolves', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(Uint8Array.of(1));
          queueMicrotask(() => queueMicrotask(() => (now = 100)));
        },
      },
      { highWaterMark: 0 },
    );
    const guard = createCodexResponseRequestGuard({
      deadlineAt: 100,
      limits: { totalTimeoutMs: 100, idleTimeoutMs: 1_000, maxBytes: 32 },
    });
    const reader = bindGuard(guard, new Response(source)).body!.getReader();

    await expect(reader.read()).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('rechecks the total deadline after the fairness macrotask before enqueueing', async () => {
    let now = 0;
    let pullCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1024) setTimeout(() => (now = 100), 0);
          controller.enqueue(Uint8Array.of(1));
        },
      },
      { highWaterMark: 0 },
    );
    const guard = createCodexResponseRequestGuard({
      deadlineAt: 100,
      limits: { totalTimeoutMs: 100, idleTimeoutMs: 1_000, maxBytes: 2_000 },
    });
    const reader = bindGuard(guard, new Response(source)).body!.getReader();

    for (let index = 0; index < 1023; index += 1) {
      await expect(reader.read()).resolves.toMatchObject({ done: false });
    }
    await expect(reader.read()).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('does not forward a first chunk whose source microtasks outlive the idle deadline', async () => {
    const startedAt = Date.now();
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (Date.now() <= startedAt + 15) await Promise.resolve();
          controller.enqueue(Uint8Array.of(1));
        },
      },
      { highWaterMark: 0 },
    );
    const guard = createCodexResponseRequestGuard({
      deadlineAt: startedAt + 1_000,
      limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 10, maxBytes: 32 },
    });
    const reader = bindGuard(guard, new Response(source)).body!.getReader();

    await expect(reader.read()).rejects.toMatchObject({ failure: 'idle-timeout' });
  });

  it('accepts exactly maxBytes and validates the credential lifecycle at EOF', async () => {
    const assertCurrent = vi.fn(async () => true);
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 500, maxBytes: 4 } }),
    );
    const upstream = new Response(source.stream, {
      headers: { 'x-upstream': 'preserved' },
      status: 201,
      statusText: 'Created',
    });
    const guarded = bindGuard(guard, upstream, assertCurrent);

    source.enqueue(Uint8Array.of(1, 2, 3, 4));
    source.close();

    await expect(guarded.arrayBuffer()).resolves.toHaveProperty('byteLength', 4);
    expect(guarded.status).toBe(201);
    expect(guarded.statusText).toBe('Created');
    expect(guarded.headers.get('x-upstream')).toBe('preserved');
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it('rejects before enqueueing one byte beyond maxBytes', async () => {
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 500, maxBytes: 4 } }),
    );
    const reader = bindGuard(guard, new Response(source.stream)).body!.getReader();

    source.enqueue(Uint8Array.of(1, 2, 3));
    await expect(reader.read()).resolves.toMatchObject({ value: Uint8Array.of(1, 2, 3) });
    source.enqueue(Uint8Array.of(4, 5));

    await expect(reader.read()).rejects.toMatchObject({ failure: 'body-too-large' });
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale completion after checking currentness at EOF', async () => {
    const assertCurrent = vi.fn(async () => false);
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(testGuardOptions());
    const reader = bindGuard(guard, new Response(source.stream), assertCurrent).body!.getReader();

    source.close();

    await expect(reader.read()).rejects.toMatchObject({ failure: 'stale-at-eof' });
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  });

  it('refuses EOF after currentness microtasks outlive the absolute deadline', async () => {
    const deadlineAt = Date.now() + 10;
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard({
      deadlineAt,
      limits: { totalTimeoutMs: 10, idleTimeoutMs: 1_000, maxBytes: 32 },
    });
    const guarded = bindGuard(guard, new Response(source.stream), async () => {
      while (Date.now() <= deadlineAt + 5) await Promise.resolve();
      return true;
    });

    source.close();

    await expect(guarded.arrayBuffer()).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('forwards consumer cancellation to the upstream source exactly once', async () => {
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(testGuardOptions());
    const guarded = bindGuard(guard, new Response(source.stream));

    await guarded.body!.cancel('consumer secret');
    await guarded.body!.cancel('consumer secret again');

    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('settles consumer cancellation and releases the source when upstream cancel never settles', async () => {
    const source = neverSettlingCancelByteStream();
    const guard = createCodexResponseRequestGuard(testGuardOptions());
    const guarded = bindGuard(guard, new Response(source.stream));

    const outcome = await Promise.race([
      guarded.body!.cancel().then(() => 'cancelled' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).toBe('cancelled');
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.stream.locked).toBe(false);
  });

  it('does not start EOF currentness I/O after consumer cancellation wins the microtask race', async () => {
    const assertCurrent = vi.fn(async () => true);
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(testGuardOptions());
    const reader = bindGuard(guard, new Response(source.stream), assertCurrent).body!.getReader();

    const read = reader.read();
    await Promise.resolve();
    source.close();
    const cancel = Promise.resolve().then(() => Promise.resolve().then(() => reader.cancel()));

    await cancel;
    await expect(read).resolves.toMatchObject({ done: true });
    expect(assertCurrent).not.toHaveBeenCalled();
  });

  it('disposes parent listeners and timers after normal EOF', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const caller = new AbortController();
    const lifecycle = new AbortController();
    const callerAdd = vi.spyOn(caller.signal, 'addEventListener');
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const lifecycleAdd = vi.spyOn(lifecycle.signal, 'addEventListener');
    const lifecycleRemove = vi.spyOn(lifecycle.signal, 'removeEventListener');
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({
        callerSignal: caller.signal,
        deadlineAt: NOW + 1_000,
        lifecycleSignal: lifecycle.signal,
      }),
    );
    const guarded = bindGuard(guard, new Response(source.stream));

    source.close();
    await expect(guarded.arrayBuffer()).resolves.toHaveProperty('byteLength', 0);

    expect(callerAdd).toHaveBeenCalledTimes(1);
    expect(callerRemove).toHaveBeenCalledTimes(1);
    expect(lifecycleAdd).toHaveBeenCalledTimes(1);
    expect(lifecycleRemove).toHaveBeenCalledTimes(1);
    expect(source.stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps a source read failure and disposes parent listeners and timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lifecycle = new AbortController();
    const remove = vi.spyOn(lifecycle.signal, 'removeEventListener');
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ deadlineAt: NOW + 1_000, lifecycleSignal: lifecycle.signal }),
    );
    const reader = bindGuard(guard, new Response(source.stream)).body!.getReader();

    source.error(new Error('upstream body account-id access-token'));

    const error = await reader.read().catch((caught) => caught);
    expect(error).toBeInstanceOf(CodexResponseGuardError);
    expect(error).toMatchObject({ failure: 'body-read-failed' });
    expect(String(error)).not.toContain('account-id');
    expect(String(error)).not.toContain('access-token');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes parent listeners and timers after abort', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lifecycle = new AbortController();
    const remove = vi.spyOn(lifecycle.signal, 'removeEventListener');
    const source = controllableByteStream();
    const guard = createCodexResponseRequestGuard(
      testGuardOptions({ deadlineAt: NOW + 1_000, lifecycleSignal: lifecycle.signal }),
    );
    const reader = bindGuard(guard, new Response(source.stream)).body!.getReader();

    const read = reader.read();
    lifecycle.abort();

    await expect(read).rejects.toMatchObject({
      failure: 'lifecycle-abort' satisfies CodexResponseGuardFailure,
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
