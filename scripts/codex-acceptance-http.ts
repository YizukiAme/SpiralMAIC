import { errorCategoryForStatus, exactKeys, fail, isRecord } from './codex-acceptance-report';
import type { AcceptanceOptions, Fetcher, SafeReport } from './codex-acceptance-types';
import { parseJsonSse } from './codex-acceptance-validators';

export async function safeFetch(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      // Never replay an access code, session cookie, or generation payload to
      // a redirect target. The configured origin is the full trust boundary.
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail('network');
  }
}

export async function requireJson(response: Response): Promise<unknown> {
  if (!response.ok) fail(errorCategoryForStatus(response.status), response.status);
  try {
    return await response.json();
  } catch {
    fail('invalid-json', response.status);
  }
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
  if (!response.ok) fail(errorCategoryForStatus(response.status), response.status);
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    fail('invalid-sse', response.status);
  }
  if (!response.body) fail('invalid-sse', response.status);
  const reader = response.body.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }
  return parseJsonSse(chunks());
}
