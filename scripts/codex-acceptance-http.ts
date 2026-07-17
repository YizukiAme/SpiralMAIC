import {
  errorCategoryForStatus,
  exactKeys,
  fail,
  isRecord,
  normalizePublicBaseUrl,
} from './codex-acceptance-report';
import type { AcceptanceOptions, Fetcher, SafeReport } from './codex-acceptance-types';
import { parseJsonSse } from './codex-acceptance-validators';
export {
  ACCEPTANCE_SSE_MAX_BYTES,
  ACCEPTANCE_SSE_MAX_DATA_LINES,
  ACCEPTANCE_SSE_MAX_EVENTS,
  ACCEPTANCE_SSE_MAX_FRAME_BYTES,
  ACCEPTANCE_SSE_MAX_FRAMES,
} from './codex-acceptance-validators';

export const ACCEPTANCE_JSON_MAX_BYTES = 1024 * 1024;
export const ACCEPTANCE_IMAGE_JSON_MAX_BYTES = 32 * 1024 * 1024;

function validateRequestOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('argument');
  }
  if (parsed.username || parsed.password) fail('argument');
  normalizePublicBaseUrl(parsed.origin);
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function safeFetch(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  validateRequestOrigin(url);
  const requestSignal = init.signal ?? AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(url, {
      ...init,
      // Never replay an access code, session cookie, or generation payload to
      // a redirect target. The configured origin is the full trust boundary.
      redirect: 'error',
      signal: requestSignal,
    });
  } catch {
    const reason = requestSignal.reason as { name?: unknown } | undefined;
    const source = requestSignal.aborted && reason?.name === 'TimeoutError' ? 'timeout' : 'network';
    fail('network', undefined, source);
  }
}

async function requireBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok) {
    await cancelResponseBody(response);
    fail(errorCategoryForStatus(response.status), response.status);
  }
  const rawDeclaredLength = response.headers.get('content-length');
  if (rawDeclaredLength !== null) {
    const normalizedLength = rawDeclaredLength.trim();
    const declaredLength = Number(normalizedLength);
    if (
      !/^\d{1,16}$/.test(normalizedLength) ||
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maxBytes
    ) {
      await cancelResponseBody(response);
      fail('invalid-json', response.status);
    }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
  } catch {
    fail('invalid-json', response.status);
  }
  if (!reader) fail('invalid-json', response.status);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail('invalid-json', response.status);
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    fail('invalid-json', response.status);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    fail('invalid-json', response.status);
  }
}

export async function requireJson(response: Response): Promise<unknown> {
  return requireBoundedJson(response, ACCEPTANCE_JSON_MAX_BYTES);
}

export async function requireCodexImageJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await cancelResponseBody(response);
    const source = response.headers.get('x-openmaic-codex-image-error-source');
    const safeSource =
      source === 'upstream-http' ||
      source === 'network' ||
      source === 'invalid-response' ||
      source === 'timeout'
        ? source
        : undefined;
    const rawUpstreamStatus = response.headers.get('x-openmaic-codex-image-upstream-status');
    const upstreamStatus = rawUpstreamStatus === null ? undefined : Number(rawUpstreamStatus);
    const safeUpstreamStatus =
      safeSource === 'upstream-http' &&
      /^\d{3}$/.test(rawUpstreamStatus ?? '') &&
      Number.isInteger(upstreamStatus) &&
      (upstreamStatus as number) >= 100 &&
      (upstreamStatus as number) <= 599
        ? upstreamStatus
        : undefined;
    fail(errorCategoryForStatus(response.status), response.status, safeSource, safeUpstreamStatus);
  }
  return requireBoundedJson(response, ACCEPTANCE_IMAGE_JSON_MAX_BYTES);
}

export function headers(cookie?: string, extra?: HeadersInit): Headers {
  const result = new Headers(extra);
  if (cookie) result.set('cookie', cookie);
  return result;
}

function accessCookie(response: Response): string {
  const raw = response.headers.get('set-cookie');
  const match = raw?.match(/(?:^|,\s*)openmaic_access=([^;,\s]+)/);
  if (!match || match[1].length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(match[1])) {
    fail('invalid-shape', response.status);
  }
  return `openmaic_access=${match[1]}`;
}

function validateAccessStatus(
  value: unknown,
  expectedAuthenticated?: boolean,
): {
  enabled: boolean;
  authenticated: boolean;
} {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['success', 'enabled', 'authenticated']) ||
    value.success !== true ||
    typeof value.enabled !== 'boolean' ||
    typeof value.authenticated !== 'boolean' ||
    (expectedAuthenticated !== undefined && value.authenticated !== expectedAuthenticated)
  ) {
    fail('invalid-shape');
  }
  return { enabled: value.enabled, authenticated: value.authenticated };
}

export async function establishAccess(
  options: AcceptanceOptions,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<{ cookie?: string; report: SafeReport }> {
  const statusResponse = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/access-code/status`,
    { method: 'GET', cache: 'no-store' },
    timeoutMs,
  );
  const status = validateAccessStatus(await requireJson(statusResponse));
  if (!status.enabled) {
    return {
      report: {
        outcome: 'PASS',
        stage: 'access-session',
        httpStatus: statusResponse.status,
        authenticated: true,
      },
    };
  }
  if (!options.accessCode) fail('auth');

  const verifyResponse = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/access-code/verify`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: options.accessCode }),
      cache: 'no-store',
    },
    timeoutMs,
  );
  const verify = await requireJson(verifyResponse);
  if (!isRecord(verify) || verify.success !== true || verify.valid !== true) {
    fail('invalid-shape', verifyResponse.status);
  }
  const cookie = accessCookie(verifyResponse);
  const confirmationResponse = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/access-code/status`,
    { method: 'GET', headers: headers(cookie), cache: 'no-store' },
    timeoutMs,
  );
  validateAccessStatus(await requireJson(confirmationResponse), true);
  return {
    cookie,
    report: {
      outcome: 'PASS',
      stage: 'access-session',
      httpStatus: confirmationResponse.status,
      authenticated: true,
    },
  };
}

export function validateAuthStatus(
  value: unknown,
  expectSignedOut: boolean,
): {
  available: true;
  connected: boolean;
} {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      typeof value.email === 'string'
        ? ['available', 'reason', 'methods', 'connected', 'email']
        : ['available', 'reason', 'methods', 'connected'],
    ) ||
    value.available !== true ||
    value.reason !== 'AVAILABLE' ||
    !Array.isArray(value.methods) ||
    !value.methods.every((method) => method === 'browser' || method === 'device') ||
    typeof value.connected !== 'boolean' ||
    value.connected === expectSignedOut ||
    (value.connected === false && Object.prototype.hasOwnProperty.call(value, 'email'))
  ) {
    fail('invalid-shape');
  }
  return { available: true, connected: value.connected };
}

export async function responseEvents(response: Response): Promise<unknown[]> {
  if (!response.ok) {
    await cancelResponseBody(response);
    fail(errorCategoryForStatus(response.status), response.status);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    await cancelResponseBody(response);
    fail('invalid-sse', response.status);
  }
  if (!response.body) fail('invalid-sse', response.status);
  const reader = response.body.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          return;
        }
        if (value) yield value;
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
    }
  }
  try {
    return await parseJsonSse(chunks());
  } catch {
    await reader.cancel().catch(() => undefined);
    fail('invalid-sse', response.status);
  }
}
