import { describe, expect, it, vi } from 'vitest';

import {
  BoundedJsonReadError,
  CODEX_OAUTH_JSON_MAX_BYTES,
  readBoundedJson,
} from '@/lib/server/codex/bounded-json';

function responseFromChunks(
  chunks: Uint8Array[],
  cancelled = vi.fn(),
  headers?: HeadersInit,
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
      },
      cancel: cancelled,
    }),
    { headers },
  );
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('readBoundedJson', () => {
  it('parses a normal JSON body within the default byte budget', async () => {
    const response = responseFromChunks([utf8('{"ok":true,"count":2}')]);

    await expect(readBoundedJson(response, new AbortController().signal)).resolves.toEqual({
      ok: true,
      payload: { ok: true, count: 2 },
    });
    expect(CODEX_OAUTH_JSON_MAX_BYTES).toBe(1024 * 1024);
    expect(response.body?.locked).toBe(false);
  });

  it('accepts an actual body exactly at the byte budget', async () => {
    const body = '{"a":1}';

    await expect(
      readBoundedJson(
        responseFromChunks([utf8(body)], undefined, {
          'content-length': String(utf8(body).byteLength),
        }),
        new AbortController().signal,
        utf8(body).byteLength,
      ),
    ).resolves.toEqual({ ok: true, payload: { a: 1 } });
  });

  it('accepts primitive JSON for caller-owned shape validation', async () => {
    await expect(
      readBoundedJson(responseFromChunks([utf8('42')]), new AbortController().signal),
    ).resolves.toEqual({ ok: true, payload: 42 });
  });

  it('rejects a valid declared length over the limit without acquiring a reader', async () => {
    const cancelled = vi.fn();
    const response = responseFromChunks([utf8('{"private":"body"}')], cancelled, {
      'content-length': '7',
    });
    const getReader = vi.spyOn(response.body!, 'getReader');

    await expect(readBoundedJson(response, new AbortController().signal, 6)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('rejects an unrepresentably large decimal length without acquiring a reader', async () => {
    const cancelled = vi.fn();
    const response = responseFromChunks([utf8('{}')], cancelled, {
      'content-length': '9'.repeat(400),
    });
    const getReader = vi.spyOn(response.body!, 'getReader');

    await expect(readBoundedJson(response, new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('treats a leading-zero decimal length as authoritative', async () => {
    const cancelled = vi.fn();
    const response = responseFromChunks([utf8('{}')], cancelled, {
      'content-length': '0000007',
    });
    const getReader = vi.spyOn(response.body!, 'getReader');

    await expect(readBoundedJson(response, new AbortController().signal, 6)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('settles a declared overflow even if body cancellation never settles', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => undefined));
    const response = responseFromChunks([utf8('{"private":"body"}')], cancelled, {
      'content-length': '7',
    });
    const pending = Symbol('pending');
    const reading = readBoundedJson(response, new AbortController().signal, 6);

    const result = await Promise.race([reading, Promise.resolve(pending)]);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('rejects a chunked body as soon as it exceeds the byte budget', async () => {
    const cancelled = vi.fn();
    const response = responseFromChunks(
      [Uint8Array.of(123, 34, 97, 34), Uint8Array.of(58, 49, 125)],
      cancelled,
    );

    await expect(readBoundedJson(response, new AbortController().signal, 6)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('lets a parent timer abort a high-churn zero-length stream', async () => {
    const zeroChunk = new Uint8Array(0);
    const totalZeroChunks = 25_000;
    const cancelled = vi.fn();
    let pullCount = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          if (pullCount <= totalZeroChunks) {
            controller.enqueue(zeroChunk);
            return;
          }
          controller.enqueue(utf8('{}'));
          controller.close();
        },
        cancel: cancelled,
      }),
    );
    const parent = new AbortController();
    const abortFired = new Promise<void>((resolve) => {
      setTimeout(() => {
        parent.abort();
        resolve();
      }, 1);
    });

    const result = await readBoundedJson(response, parent.signal);
    const abortedBeforeSettlement = parent.signal.aborted;
    await abortFired;

    expect(abortedBeforeSettlement).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(pullCount).toBeLessThan(totalZeroChunks);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('snapshots non-empty chunk bytes before the producer can reuse them', async () => {
    const chunk = utf8('{}');
    const mutated = utf8('[]');
    let sent = false;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent) return;
            sent = true;
            controller.enqueue(chunk);
            queueMicrotask(() => {
              chunk.set(mutated);
              controller.close();
            });
          },
        },
        { highWaterMark: 0 },
      ),
    );

    await expect(readBoundedJson(response, new AbortController().signal)).resolves.toEqual({
      ok: true,
      payload: {},
    });
  });

  it.each([
    ['malformed', 'not-a-length'],
    ['negative', '-1'],
  ])('does not trust a %s Content-Length and counts actual bytes', async (_name, value) => {
    const cancelled = vi.fn();
    const response = responseFromChunks([utf8('{"too":"large"}')], cancelled, {
      'content-length': value,
    });

    await expect(readBoundedJson(response, new AbortController().signal, 6)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['hexadecimal', '0x7'],
    ['scientific notation', '1e1'],
  ])('treats a %s Content-Length as untrusted syntax', async (_name, value) => {
    const cancelled = vi.fn();
    const response = responseFromChunks([utf8('{}')], cancelled, {
      'content-length': value,
    });
    const getReader = vi.spyOn(response.body!, 'getReader');

    await expect(readBoundedJson(response, new AbortController().signal, 6)).resolves.toEqual({
      ok: true,
      payload: {},
    });
    expect(getReader).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('returns a safe empty result for a missing or empty body', async () => {
    await expect(
      readBoundedJson(new Response(null), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      reason: 'empty',
    });
    await expect(
      readBoundedJson(responseFromChunks([]), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it.each([
    ['malformed JSON', utf8('{"private":"unterminated"')],
    ['invalid UTF-8', Uint8Array.of(0xc3, 0x28)],
    ['whitespace-only JSON', utf8(' \n\t ')],
  ])('returns a content-free invalid result for %s', async (_name, bytes) => {
    const result = await readBoundedJson(responseFromChunks([bytes]), new AbortController().signal);

    expect(result).toEqual({ ok: false, reason: 'invalid-json' });
    expect(JSON.stringify(result)).not.toMatch(/private|unterminated/);
  });

  it('wraps stream read failures without retaining response content', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(utf8('{"private":"oauth-body"}'));
          controller.error(new Error('private transport detail'));
        },
      }),
    );

    const error = await readBoundedJson(response, new AbortController().signal).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BoundedJsonReadError);
    expect(String(error)).toBe('BoundedJsonReadError: Codex OAuth response body could not be read');
    expect(JSON.stringify(error)).not.toMatch(/private|oauth-body|transport detail/);
    expect(response.body?.locked).toBe(false);
  });

  it('wraps a pre-locked body without exposing the lock failure', async () => {
    const response = responseFromChunks([utf8('{"private":"locked"}')]);
    const externalReader = response.body!.getReader();

    const error = await readBoundedJson(response, new AbortController().signal).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BoundedJsonReadError);
    expect(String(error)).not.toMatch(/locked|private/);
    externalReader.releaseLock();
  });

  it('cancels a pending reader on parent abort without replacing the parent outcome', async () => {
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel: cancelled,
      }),
    );
    const parent = new AbortController();
    const reading = readBoundedJson(response, parent.signal);

    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    parent.abort();

    await expect(reading).resolves.toEqual({ ok: false, reason: 'empty' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('removes its abort listener after a successful read', async () => {
    const parent = new AbortController();
    const addListener = vi.spyOn(parent.signal, 'addEventListener');
    const removeListener = vi.spyOn(parent.signal, 'removeEventListener');

    await readBoundedJson(responseFromChunks([utf8('{}')]), parent.signal);

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('returns too-large even if cancelling an overflowing reader rejects', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(utf8('{"too":"large"}'));
        },
        cancel() {
          throw new Error('private cancellation failure');
        },
      }),
    );

    const result = await readBoundedJson(response, new AbortController().signal, 6);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(JSON.stringify(result)).not.toContain('private cancellation failure');
    expect(response.body?.locked).toBe(false);
  });

  it('settles and releases an overflowing reader when cancellation never settles', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(utf8('{"too":"large"}'));
        },
        cancel: cancelled,
      }),
    );
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, 'removeEventListener');
    const pending = Symbol('pending');
    const reading = readBoundedJson(response, parent.signal, 6);

    const result = await Promise.race([
      reading,
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 0)),
    ]);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });
});
