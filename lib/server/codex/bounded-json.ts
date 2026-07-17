export const CODEX_OAUTH_JSON_MAX_BYTES = 1024 * 1024;

// Scheduler fairness only: chunk count is never a validity or rejection limit.
const STREAM_FAIRNESS_CHUNK_INTERVAL = 1024;

export type BoundedJsonResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'empty' | 'too-large' | 'invalid-json' };

export class BoundedJsonReadError extends Error {
  constructor() {
    super('Codex OAuth response body could not be read');
    this.name = 'BoundedJsonReadError';
  }
}

function cancelWithoutWaiting(cancel: () => Promise<unknown>): void {
  try {
    void cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never delay or replace a safe result.
  }
}

function growBuffer(
  current: Uint8Array,
  usedBytes: number,
  requiredBytes: number,
  maxBytes: number,
): Uint8Array {
  const doubledCapacity = current.byteLength === 0 ? 1024 : current.byteLength * 2;
  const nextCapacity = Math.min(maxBytes, Math.max(requiredBytes, doubledCapacity));
  const next = new Uint8Array(nextCapacity);
  next.set(current.subarray(0, usedBytes));
  return next;
}

function yieldToMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = CODEX_OAUTH_JSON_MAX_BYTES,
): Promise<BoundedJsonResult> {
  const declaredLengthHeader = response.headers.get('content-length');
  const hasDecimalDeclaredLength =
    declaredLengthHeader !== null && /^[0-9]+$/.test(declaredLengthHeader);
  const declaredLength = hasDecimalDeclaredLength ? Number(declaredLengthHeader) : undefined;
  if (
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes)
  ) {
    if (response.body) cancelWithoutWaiting(() => response.body!.cancel());
    return { ok: false, reason: 'too-large' };
  }

  if (!response.body) return { ok: false, reason: 'empty' };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new BoundedJsonReadError();
  }

  let bytes: Uint8Array = new Uint8Array(0);
  let totalBytes = 0;
  let chunksSinceYield = 0;
  let listeningForAbort = false;
  const cancelReader = () => {
    cancelWithoutWaiting(() => reader.cancel());
  };

  if (signal.aborted) {
    cancelReader();
  } else {
    signal.addEventListener('abort', cancelReader, { once: true });
    listeningForAbort = true;
  }

  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        if (signal.aborted) return { ok: false, reason: 'empty' };
        throw new BoundedJsonReadError();
      }
      if (next.done) break;

      const chunkBytes = next.value.byteLength;
      if (chunkBytes > 0) {
        const requiredBytes = totalBytes + chunkBytes;
        if (requiredBytes > maxBytes) {
          cancelReader();
          return { ok: false, reason: 'too-large' };
        }
        if (bytes.byteLength < requiredBytes) {
          bytes = growBuffer(bytes, totalBytes, requiredBytes, maxBytes);
        }
        bytes.set(next.value, totalBytes);
        totalBytes = requiredBytes;
      }

      chunksSinceYield += 1;
      if (chunksSinceYield >= STREAM_FAIRNESS_CHUNK_INTERVAL) {
        chunksSinceYield = 0;
        await yieldToMacrotask();
        if (signal.aborted) return { ok: false, reason: 'empty' };
      }
    }
  } finally {
    if (listeningForAbort) signal.removeEventListener('abort', cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A body lifecycle failure must not replace the already-safe result.
    }
  }

  if (totalBytes === 0) return { ok: false, reason: 'empty' };

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, totalBytes));
    return { ok: true, payload: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}
