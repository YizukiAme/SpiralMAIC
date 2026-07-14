import { extractCodexJwtIdentity, parseJwtPayload } from './jwt';
import type { CodexCredentialVault, CodexOAuthCredentials } from './vault';

export const CODEX_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const REFRESH_EARLY_MS = 60_000;

export const CODEX_OAUTH_ERROR_CODES = {
  CREDENTIALS_MISSING: 'CREDENTIALS_MISSING',
  SIGNED_OUT: 'SIGNED_OUT',
  INVALID_GRANT: 'INVALID_GRANT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  REFRESH_REJECTED: 'REFRESH_REJECTED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  STORAGE_ERROR: 'STORAGE_ERROR',
} as const;

export type CodexOAuthErrorCode =
  (typeof CODEX_OAUTH_ERROR_CODES)[keyof typeof CODEX_OAUTH_ERROR_CODES];

const SAFE_ERROR_MESSAGES: Record<CodexOAuthErrorCode, string> = {
  CREDENTIALS_MISSING: 'Codex credentials are unavailable',
  SIGNED_OUT: 'Codex credentials were cleared',
  INVALID_GRANT: 'Codex authorization is no longer valid',
  NETWORK_ERROR: 'Codex token refresh could not reach the authorization server',
  UPSTREAM_ERROR: 'Codex authorization server is temporarily unavailable',
  REFRESH_REJECTED: 'Codex token refresh was rejected',
  INVALID_RESPONSE: 'Codex authorization server returned an invalid response',
  STORAGE_ERROR: 'Codex credentials could not be stored securely',
};

export class CodexOAuthError extends Error {
  constructor(
    public readonly code: CodexOAuthErrorCode,
    public readonly retryable: boolean,
    public readonly upstreamStatus?: number,
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'CodexOAuthError';
  }
}

export interface CodexTokenProvider {
  getValidCredentials(options?: {
    forceRefresh?: boolean;
  }): Promise<{ accessToken: string; accountId: string }>;
}

export interface CodexClock {
  now(): number;
}

export type TokenExchangeFetch = (input: string, init: RequestInit) => Promise<Response>;

interface ManagedCodexTokenProviderOptions {
  vault: CodexCredentialVault;
  tokenExchangeFetch?: TokenExchangeFetch;
  clock?: CodexClock;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  email?: string;
}

type ValidCredentials = { accessToken: string; accountId: string };

interface CredentialOperationState {
  forceRequested: boolean;
  refreshed: boolean;
}

interface ActiveCredentialOperation {
  state: CredentialOperationState;
  promise: Promise<ValidCredentials>;
}

interface SharedCredentialState {
  generation: number;
  operationInFlight: ActiveCredentialOperation | null;
  logoutInFlight: Promise<void> | null;
}

interface SharedCredentialStateRegistry {
  byCoordinationKey: Map<string, SharedCredentialState>;
  byVault: WeakMap<CodexCredentialVault, SharedCredentialState>;
}

function isSharedCredentialStateRegistry(value: unknown): value is SharedCredentialStateRegistry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SharedCredentialStateRegistry>;
  return candidate.byCoordinationKey instanceof Map && candidate.byVault instanceof WeakMap;
}

const SHARED_STATE_REGISTRY_KEY = Symbol.for('openmaic.codex.oauth.shared-credential-state.v2');
const coordinatorHost = globalThis as unknown as Record<PropertyKey, unknown>;
const existingSharedStateRegistry = coordinatorHost[SHARED_STATE_REGISTRY_KEY];
const sharedStateRegistry = isSharedCredentialStateRegistry(existingSharedStateRegistry)
  ? existingSharedStateRegistry
  : {
      byCoordinationKey: new Map<string, SharedCredentialState>(),
      byVault: new WeakMap<CodexCredentialVault, SharedCredentialState>(),
    };

if (!isSharedCredentialStateRegistry(existingSharedStateRegistry)) {
  Object.defineProperty(coordinatorHost, SHARED_STATE_REGISTRY_KEY, {
    value: sharedStateRegistry,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function getSharedCredentialState(vault: CodexCredentialVault): SharedCredentialState {
  const coordinationKey = vault.coordinationKey;
  if (typeof coordinationKey === 'string' && coordinationKey.length > 0) {
    const existing = sharedStateRegistry.byCoordinationKey.get(coordinationKey);
    if (existing) return existing;

    const state = createSharedCredentialState();
    sharedStateRegistry.byCoordinationKey.set(coordinationKey, state);
    return state;
  }

  const existing = sharedStateRegistry.byVault.get(vault);
  if (existing) return existing;

  const state = createSharedCredentialState();
  sharedStateRegistry.byVault.set(vault, state);
  return state;
}

function createSharedCredentialState(): SharedCredentialState {
  return { generation: 0, operationInFlight: null, logoutInFlight: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function expiresAtFromJwt(token: string): number | undefined {
  const exp = parseJwtPayload(token)?.exp;
  const seconds =
    typeof exp === 'number'
      ? exp
      : typeof exp === 'string' && exp.trim() !== ''
        ? Number(exp)
        : Number.NaN;

  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

function parseExpiresIn(value: unknown): number | undefined {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function signedOutError(): CodexOAuthError {
  return new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.SIGNED_OUT, false);
}

export class ManagedCodexTokenProvider implements CodexTokenProvider {
  private readonly vault: CodexCredentialVault;
  private readonly tokenExchangeFetch: TokenExchangeFetch;
  private readonly clock: CodexClock;
  private readonly sharedState: SharedCredentialState;

  constructor(options: ManagedCodexTokenProviderOptions) {
    this.vault = options.vault;
    this.tokenExchangeFetch = options.tokenExchangeFetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? { now: Date.now };
    this.sharedState = getSharedCredentialState(options.vault);
  }

  getValidCredentials(options?: { forceRefresh?: boolean }): Promise<ValidCredentials> {
    if (this.sharedState.logoutInFlight) {
      return this.sharedState.logoutInFlight.then(() => {
        throw signedOutError();
      });
    }

    const existing = this.sharedState.operationInFlight;
    if (existing) {
      if (options?.forceRefresh === true) existing.state.forceRequested = true;
      return existing.promise.then((result) => {
        if (options?.forceRefresh !== true || existing.state.refreshed) return result;
        return this.getValidCredentials({ forceRefresh: true });
      });
    }

    const requestGeneration = this.sharedState.generation;
    const state: CredentialOperationState = {
      forceRequested: options?.forceRefresh === true,
      refreshed: false,
    };
    const operation: ActiveCredentialOperation = {
      state,
      promise: this.resolveCredentials(state, requestGeneration),
    };
    this.sharedState.operationInFlight = operation;
    void operation.promise.then(
      () => {
        if (this.sharedState.operationInFlight === operation) {
          this.sharedState.operationInFlight = null;
        }
      },
      () => {
        if (this.sharedState.operationInFlight === operation) {
          this.sharedState.operationInFlight = null;
        }
      },
    );
    return operation.promise;
  }

  logout(): Promise<void> {
    if (this.sharedState.logoutInFlight) return this.sharedState.logoutInFlight;

    this.sharedState.generation += 1;
    const staleOperation = this.sharedState.operationInFlight?.promise ?? null;
    const logout = this.finishLogout(staleOperation);
    this.sharedState.logoutInFlight = logout;
    void logout.then(
      () => {
        if (this.sharedState.logoutInFlight === logout) this.sharedState.logoutInFlight = null;
      },
      () => {
        if (this.sharedState.logoutInFlight === logout) this.sharedState.logoutInFlight = null;
      },
    );
    return logout;
  }

  private async resolveCredentials(
    state: CredentialOperationState,
    requestGeneration: number,
  ): Promise<ValidCredentials> {
    let credentials: CodexOAuthCredentials | null;

    try {
      credentials = await this.vault.load();
    } catch {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
    }

    if (requestGeneration !== this.sharedState.generation) throw signedOutError();
    if (!credentials) {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false);
    }

    const shouldRefresh =
      state.forceRequested || credentials.expiresAt - this.clock.now() <= REFRESH_EARLY_MS;
    if (!shouldRefresh) {
      return { accessToken: credentials.accessToken, accountId: credentials.accountId };
    }

    state.refreshed = true;
    return this.refreshCredentials(credentials, requestGeneration);
  }

  private async finishLogout(staleOperation: Promise<ValidCredentials> | null): Promise<void> {
    await this.vault.clear().catch(() => undefined);
    await staleOperation?.catch(() => undefined);

    try {
      await this.vault.clear();
    } catch {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
    }
  }

  private async refreshCredentials(
    credentials: CodexOAuthCredentials,
    refreshGeneration: number,
  ): Promise<{ accessToken: string; accountId: string }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: credentials.refreshToken,
    });

    let response: Response;
    try {
      response = await this.tokenExchangeFetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
    }

    if (refreshGeneration !== this.sharedState.generation) throw signedOutError();

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Invalid bodies are classified below without retaining or exposing them.
    }

    if (refreshGeneration !== this.sharedState.generation) throw signedOutError();

    if (!response.ok) {
      if (response.status >= 500) {
        throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR, true, response.status);
      }

      const errorCode = isRecord(payload) ? nonEmptyString(payload.error) : undefined;
      if (errorCode === 'invalid_grant') {
        try {
          await this.vault.clear();
        } catch {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
        }
        throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_GRANT, false);
      }

      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED, false, response.status);
    }

    const parsed = this.parseTokenResponse(payload, credentials);
    if (refreshGeneration !== this.sharedState.generation) throw signedOutError();

    const nextCredentials: CodexOAuthCredentials = {
      version: 1,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      accountId: parsed.accountId,
      ...(parsed.email ? { email: parsed.email } : {}),
      updatedAt: this.clock.now(),
    };

    try {
      await this.vault.save(nextCredentials);
    } catch {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
    }

    if (refreshGeneration !== this.sharedState.generation) throw signedOutError();

    return { accessToken: nextCredentials.accessToken, accountId: nextCredentials.accountId };
  }

  private parseTokenResponse(payload: unknown, credentials: CodexOAuthCredentials): TokenResponse {
    if (!isRecord(payload)) {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false);
    }

    const accessToken = nonEmptyString(payload.access_token);
    if (!accessToken) {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false);
    }

    const now = this.clock.now();
    const expiresIn = parseExpiresIn(payload.expires_in);
    const expiresAt =
      (expiresIn ? now + expiresIn * 1000 : undefined) ?? expiresAtFromJwt(accessToken);
    if (!expiresAt || expiresAt <= now) {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false);
    }

    const accessIdentity = extractCodexJwtIdentity(accessToken);
    const idToken = nonEmptyString(payload.id_token);
    const idIdentity = idToken ? extractCodexJwtIdentity(idToken) : {};

    return {
      accessToken,
      refreshToken: nonEmptyString(payload.refresh_token) ?? credentials.refreshToken,
      expiresAt,
      accountId: idIdentity.accountId ?? accessIdentity.accountId ?? credentials.accountId,
      email: idIdentity.email ?? accessIdentity.email ?? credentials.email,
    };
  }
}
