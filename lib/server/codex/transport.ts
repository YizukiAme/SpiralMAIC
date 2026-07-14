import { randomUUID } from 'node:crypto';

import packageMetadata from '../../../package.json';

import { CODEX_RESPONSES_ENDPOINT } from '@/lib/ai/codex-model';

import type { CodexTokenProvider } from './token-provider';

export { CODEX_RESPONSES_ENDPOINT } from '@/lib/ai/codex-model';

export const CODEX_RESPONSES_TRANSPORT_ERROR_CODES = {
  INVALID_ENDPOINT: 'INVALID_ENDPOINT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  WORKSPACE_FORBIDDEN: 'WORKSPACE_FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
} as const;

export type CodexResponsesTransportErrorCode =
  (typeof CODEX_RESPONSES_TRANSPORT_ERROR_CODES)[keyof typeof CODEX_RESPONSES_TRANSPORT_ERROR_CODES];

const SAFE_ERROR_MESSAGES: Record<CodexResponsesTransportErrorCode, string> = {
  INVALID_ENDPOINT: 'Codex transport rejected an unsupported endpoint',
  INVALID_REQUEST: 'Codex transport rejected an invalid request',
  AUTH_REQUIRED: 'Codex sign-in must be renewed',
  WORKSPACE_FORBIDDEN: 'This ChatGPT workspace does not have Codex access',
  RATE_LIMITED: 'The ChatGPT plan limit or Codex rate limit was reached',
  NETWORK_ERROR: 'Codex could not be reached',
  UPSTREAM_ERROR: 'Codex is temporarily unavailable',
};

export class CodexResponsesTransportError extends Error {
  constructor(
    public readonly code: CodexResponsesTransportErrorCode,
    public readonly upstreamStatus?: number,
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'CodexResponsesTransportError';
  }
}

interface CreateCodexResponsesTransportOptions {
  tokenProvider: CodexTokenProvider;
  upstreamFetch?: typeof globalThis.fetch;
}

const SESSION_ID_KEY = Symbol.for('openmaic.codex.responses.session-id.v1');
const sessionHost = globalThis as unknown as Record<PropertyKey, unknown>;

function getProcessSessionId(): string {
  const existing = sessionHost[SESSION_ID_KEY];
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const sessionId = randomUUID();
  Object.defineProperty(sessionHost, SESSION_ID_KEY, {
    value: sessionId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return sessionId;
}

const REMOVED_BODY_FIELDS = [
  'max_output_tokens',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'seed',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBody(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null || typeof body !== 'string') {
    throw new CodexResponsesTransportError(CODEX_RESPONSES_TRANSPORT_ERROR_CODES.INVALID_REQUEST);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CodexResponsesTransportError(CODEX_RESPONSES_TRANSPORT_ERROR_CODES.INVALID_REQUEST);
  }
  if (!isRecord(parsed)) {
    throw new CodexResponsesTransportError(CODEX_RESPONSES_TRANSPORT_ERROR_CODES.INVALID_REQUEST);
  }

  const normalized: Record<string, unknown> = { ...parsed, store: false };
  const include = Array.isArray(normalized.include)
    ? normalized.include.filter((value): value is string => typeof value === 'string')
    : [];
  if (!include.includes('reasoning.encrypted_content')) {
    include.push('reasoning.encrypted_content');
  }
  normalized.include = include;

  if (Array.isArray(normalized.input)) {
    normalized.input = normalized.input.map((item) =>
      isRecord(item) && item.role === 'system' ? { ...item, role: 'developer' } : item,
    );
  }

  for (const field of REMOVED_BODY_FIELDS) delete normalized[field];
  return JSON.stringify(normalized);
}

function createHeaders(
  inputHeaders: HeadersInit | undefined,
  credentials: { accessToken: string; accountId: string },
  sessionId: string,
): Headers {
  const input = new Headers(inputHeaders);
  const headers = new Headers();
  for (const name of ['accept', 'content-type'] as const) {
    const value = input.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');

  headers.set('authorization', `Bearer ${credentials.accessToken}`);
  headers.set('chatgpt-account-id', credentials.accountId);
  headers.set('originator', 'openmaic');
  headers.set('user-agent', `OpenMAIC/${packageMetadata.version} (native Codex OAuth)`);
  headers.set('session-id', sessionId);
  return headers;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function errorForStatus(status: number): CodexResponsesTransportError {
  if (status === 401) {
    return new CodexResponsesTransportError(
      CODEX_RESPONSES_TRANSPORT_ERROR_CODES.AUTH_REQUIRED,
      status,
    );
  }
  if (status === 403) {
    return new CodexResponsesTransportError(
      CODEX_RESPONSES_TRANSPORT_ERROR_CODES.WORKSPACE_FORBIDDEN,
      status,
    );
  }
  if (status === 429) {
    return new CodexResponsesTransportError(
      CODEX_RESPONSES_TRANSPORT_ERROR_CODES.RATE_LIMITED,
      status,
    );
  }
  return new CodexResponsesTransportError(
    CODEX_RESPONSES_TRANSPORT_ERROR_CODES.UPSTREAM_ERROR,
    status,
  );
}

/**
 * Creates the sole network boundary used by the native Codex language model.
 * The endpoint is validated as an exact string before credentials are loaded.
 */
export function createCodexResponsesTransport(
  options: CreateCodexResponsesTransportOptions,
): typeof globalThis.fetch {
  const upstreamFetch = options.upstreamFetch ?? globalThis.fetch.bind(globalThis);
  const sessionId = getProcessSessionId();

  return async (input, init) => {
    if (typeof input !== 'string' || input !== CODEX_RESPONSES_ENDPOINT) {
      throw new CodexResponsesTransportError(
        CODEX_RESPONSES_TRANSPORT_ERROR_CODES.INVALID_ENDPOINT,
      );
    }

    const body = normalizeBody(init?.body);
    const request = async (forceRefresh: boolean): Promise<Response> => {
      const credentials = forceRefresh
        ? await options.tokenProvider.getValidCredentials({ forceRefresh: true })
        : await options.tokenProvider.getValidCredentials();
      try {
        return await upstreamFetch(CODEX_RESPONSES_ENDPOINT, {
          ...init,
          body,
          headers: createHeaders(init?.headers, credentials, sessionId),
          redirect: 'manual',
        });
      } catch {
        throw new CodexResponsesTransportError(CODEX_RESPONSES_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
      }
    };

    let response = await request(false);
    if (response.status === 401) {
      await cancelResponseBody(response);
      response = await request(true);
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw errorForStatus(response.status);
    }

    return response;
  };
}
