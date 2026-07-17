export const CODEX_OAUTH_JSON_MAX_BYTES = 1024 * 1024;

export type BoundedJsonResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'empty' | 'too-large' | 'invalid-json' };

export class BoundedJsonReadError extends Error {
  constructor() {
    super('Codex OAuth response body could not be read');
    this.name = 'BoundedJsonReadError';
  }
}

export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = CODEX_OAUTH_JSON_MAX_BYTES,
): Promise<BoundedJsonResult> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too-large' };
  }

  if (!response.body) return { ok: false, reason: 'empty' };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new BoundedJsonReadError();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let listeningForAbort = false;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
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

      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(next.value);
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

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, payload: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}
