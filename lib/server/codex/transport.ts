import packageMetadata from '../../../package.json';

import { CODEX_RESPONSES_ENDPOINT } from '@/lib/ai/codex-model';

import {
  acquireCodexCredentialLease,
  isCodexCapabilityLifecycleCurrent,
  isCodexCapabilityLeaseCurrent,
  isCodexCredentialLeaseCurrent,
  isCodexCredentialLifecycleCurrent,
  isCodexCredentialsChangedError,
  refreshCodexCapabilityLease,
  refreshCodexCredentialLease,
  type CodexTokenProvider,
  type InternalCodexCapabilityLease,
  type InternalCodexCredentialLease,
} from './token-provider';
import {
  createEphemeralCodexLogicalSession,
  deriveCodexUpstreamSessionId,
  type CodexUpstreamSessionId,
} from './logical-session';
import {
  CODEX_RESPONSE_LIMITS,
  CodexResponseGuardError,
  createCodexResponseRequestGuard,
  type CodexResponseGuardFailure,
} from './response-guard';

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
  sessionId?: CodexUpstreamSessionId;
  /** @internal Account/catalog capability selected during model resolution. */
  capabilityLease?: InternalCodexCapabilityLease;
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

function normalizeBody(body: BodyInit | null | undefined, sessionId: string): string {
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

  const normalized: Record<string, unknown> = {
    ...parsed,
    store: false,
    prompt_cache_key: sessionId,
  };
  const include = Array.isArray(normalized.include)
    ? normalized.include.filter((value): value is string => typeof value === 'string')
    : [];
  if (!include.includes('reasoning.encrypted_content')) {
    include.push('reasoning.encrypted_content');
  }
  normalized.include = include;

  if (Array.isArray(normalized.input)) {
    normalized.input = normalized.input.map((item) => {
      if (!isRecord(item)) return item;
      const { id: _itemId, ...withoutItemId } = item;
      return item.role === 'system' ? { ...withoutItemId, role: 'developer' } : withoutItemId;
    });
  }

  delete normalized.thread_id;
  delete normalized['thread-id'];
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

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Response cleanup is best-effort and must never delay retry or classification.
  }
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

function errorForGuardFailure(failure: CodexResponseGuardFailure): CodexResponsesTransportError {
  if (failure === 'lifecycle-abort' || failure === 'stale-at-eof') {
    return errorForStatus(401);
  }
  if (failure === 'caller-abort') {
    return new CodexResponsesTransportError(CODEX_RESPONSES_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
  }
  return new CodexResponsesTransportError(CODEX_RESPONSES_TRANSPORT_ERROR_CODES.UPSTREAM_ERROR);
}

/**
 * Creates the sole network boundary used by the native Codex language model.
 * The endpoint is validated as an exact string before credentials are loaded.
 */
export function createCodexResponsesTransport(
  options: CreateCodexResponsesTransportOptions,
): typeof globalThis.fetch {
  const upstreamFetch = options.upstreamFetch ?? globalThis.fetch.bind(globalThis);
  const sessionId =
    options.sessionId ?? deriveCodexUpstreamSessionId(createEphemeralCodexLogicalSession());

  return async (input, init) => {
    if (typeof input !== 'string' || input !== CODEX_RESPONSES_ENDPOINT) {
      throw new CodexResponsesTransportError(
        CODEX_RESPONSES_TRANSPORT_ERROR_CODES.INVALID_ENDPOINT,
      );
    }

    const body = normalizeBody(init?.body, sessionId);
    const deadlineAt = Date.now() + CODEX_RESPONSE_LIMITS.totalTimeoutMs;
    let capabilityLease = options.capabilityLease;
    let credentialLease: InternalCodexCredentialLease;
    const acquisitionGuard = createCodexResponseRequestGuard({
      callerSignal: init?.signal ?? undefined,
      lifecycleSignal: capabilityLease?.credentialLease.lifecycleSignal,
      deadlineAt,
    });
    try {
      // Fail before starting vault/OAuth work when cancellation or the shared
      // absolute deadline was already published.
      await acquisitionGuard.race(Promise.resolve());
      acquisitionGuard.assertActive();
      if (capabilityLease) {
        if (capabilityLease.credentialLease.tokenProvider !== options.tokenProvider) {
          throw errorForStatus(401);
        }
        if (!(await acquisitionGuard.race(isCodexCapabilityLeaseCurrent(capabilityLease)))) {
          throw errorForStatus(401);
        }
        credentialLease = capabilityLease.credentialLease;
      } else {
        credentialLease = await acquisitionGuard.race(
          acquireCodexCredentialLease(options.tokenProvider),
        );
      }
    } catch (error) {
      if (error instanceof CodexResponseGuardError) {
        throw errorForGuardFailure(error.failure);
      }
      if (isCodexCredentialsChangedError(error)) throw errorForStatus(401);
      throw error;
    } finally {
      acquisitionGuard.dispose();
    }

    const assertSendCurrent = async (): Promise<boolean> =>
      capabilityLease
        ? capabilityLease.credentialLease.tokenProvider === options.tokenProvider &&
          (await isCodexCapabilityLeaseCurrent(capabilityLease))
        : isCodexCredentialLeaseCurrent(credentialLease);
    const assertResponseCurrent = async (): Promise<boolean> =>
      capabilityLease
        ? capabilityLease.credentialLease.tokenProvider === options.tokenProvider &&
          (await isCodexCapabilityLifecycleCurrent(capabilityLease))
        : isCodexCredentialLifecycleCurrent(credentialLease);

    type AttemptResult =
      | { readonly kind: 'retry-auth' }
      | { readonly kind: 'success'; readonly response: Response };

    const request = async (forceRefresh: boolean): Promise<AttemptResult> => {
      const guard = createCodexResponseRequestGuard({
        callerSignal: init?.signal ?? undefined,
        lifecycleSignal: credentialLease.lifecycleSignal,
        deadlineAt,
      });
      try {
        // The 401 cleanup path can synchronously publish caller cancellation.
        // Observe it before starting a shared refresh for the replay.
        await guard.race(Promise.resolve());
        guard.assertActive();
        if (forceRefresh) {
          if (capabilityLease) {
            capabilityLease = await guard.race(refreshCodexCapabilityLease(capabilityLease));
            credentialLease = capabilityLease.credentialLease;
          } else {
            credentialLease = await guard.race(refreshCodexCredentialLease(credentialLease));
          }
        }
      } catch (error) {
        guard.dispose();
        if (error instanceof CodexResponseGuardError) {
          throw errorForGuardFailure(error.failure);
        }
        if (isCodexCredentialsChangedError(error)) throw errorForStatus(401);
        throw error;
      }
      let sendCurrent = false;
      try {
        guard.assertActive();
        sendCurrent = await guard.race(assertSendCurrent());
        guard.assertActive();
      } catch (error) {
        guard.dispose();
        if (error instanceof CodexResponseGuardError) {
          throw errorForGuardFailure(error.failure);
        }
        if (isCodexCredentialsChangedError(error)) throw errorForStatus(401);
        throw error;
      }
      if (!sendCurrent) {
        guard.dispose();
        throw errorForStatus(401);
      }

      const credentials = credentialLease.credentials;
      let response: Response;
      try {
        const requestInit: RequestInit = {
          ...init,
          signal: guard.signal,
          body,
          headers: createHeaders(init?.headers, credentials, sessionId),
          redirect: 'manual',
        };
        // RequestInit/HeadersInit may contain user-controlled getters. If one
        // publishes cancellation, do not invoke the credential-bearing fetch.
        guard.assertActive();
        const upstreamRequest = upstreamFetch(CODEX_RESPONSES_ENDPOINT, requestInit);
        response = await guard.race(upstreamRequest);
      } catch (error) {
        guard.dispose();
        if (error instanceof CodexResponseGuardError) {
          throw errorForGuardFailure(error.failure);
        }
        throw new CodexResponsesTransportError(CODEX_RESPONSES_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
      }

      let current = false;
      try {
        guard.assertActive();
        current = await guard.race(assertResponseCurrent());
        guard.assertActive();
      } catch (error) {
        cancelResponseBody(response);
        guard.dispose();
        if (error instanceof CodexResponseGuardError) {
          throw errorForGuardFailure(error.failure);
        }
        throw errorForStatus(401);
      }
      if (!current) {
        cancelResponseBody(response);
        guard.dispose();
        throw errorForStatus(401);
      }

      if (response.status === 401) {
        cancelResponseBody(response);
        guard.dispose();
        return { kind: 'retry-auth' };
      }
      if (!response.ok) {
        cancelResponseBody(response);
        guard.dispose();
        throw errorForStatus(response.status);
      }

      if (!response.body) {
        try {
          guard.assertActive();
          current = await guard.race(assertResponseCurrent());
          guard.assertActive();
        } catch (error) {
          guard.dispose();
          if (error instanceof CodexResponseGuardError) {
            throw errorForGuardFailure(error.failure);
          }
          throw errorForStatus(401);
        }
        guard.dispose();
        if (!current) throw errorForStatus(401);
        return { kind: 'success', response };
      }

      return {
        kind: 'success',
        response: guard.bind(response, {
          assertCurrent: assertResponseCurrent,
          errorForFailure: errorForGuardFailure,
        }),
      };
    };

    let result = await request(false);
    if (result.kind === 'retry-auth') {
      result = await request(true);
      if (result.kind === 'retry-auth') throw errorForStatus(401);
    }

    return result.response;
  };
}
