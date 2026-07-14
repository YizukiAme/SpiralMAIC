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
  private generation = 0;
  private operationInFlight: ActiveCredentialOperation | null = null;
  private logoutInFlight: Promise<void> | null = null;

  constructor(options: ManagedCodexTokenProviderOptions) {
    this.vault = options.vault;
    this.tokenExchangeFetch = options.tokenExchangeFetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? { now: Date.now };
  }

  getValidCredentials(options?: { forceRefresh?: boolean }): Promise<ValidCredentials> {
    if (this.logoutInFlight) {
      return this.logoutInFlight.then(() => {
        throw signedOutError();
      });
    }

    const existing = this.operationInFlight;
    if (existing) {
      if (options?.forceRefresh === true) existing.state.forceRequested = true;
      return existing.promise.then((result) => {
        if (options?.forceRefresh !== true || existing.state.refreshed) return result;
        return this.getValidCredentials({ forceRefresh: true });
      });
    }

    const requestGeneration = this.generation;
    const state: CredentialOperationState = {
      forceRequested: options?.forceRefresh === true,
      refreshed: false,
    };
    const operation: ActiveCredentialOperation = {
      state,
      promise: this.resolveCredentials(state, requestGeneration),
    };
    this.operationInFlight = operation;
    void operation.promise.then(
      () => {
        if (this.operationInFlight === operation) this.operationInFlight = null;
      },
      () => {
        if (this.operationInFlight === operation) this.operationInFlight = null;
      },
    );
    return operation.promise;
  }

  logout(): Promise<void> {
    if (this.logoutInFlight) return this.logoutInFlight;

    this.generation += 1;
    const staleOperation = this.operationInFlight?.promise ?? null;
    const logout = this.finishLogout(staleOperation);
    this.logoutInFlight = logout;
    void logout.then(
      () => {
        if (this.logoutInFlight === logout) this.logoutInFlight = null;
      },
      () => {
        if (this.logoutInFlight === logout) this.logoutInFlight = null;
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

    if (requestGeneration !== this.generation) throw signedOutError();
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
      if (refreshGeneration !== this.generation) throw signedOutError();
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
    }

    if (refreshGeneration !== this.generation) throw signedOutError();

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Invalid bodies are classified below without retaining or exposing them.
    }

    if (refreshGeneration !== this.generation) throw signedOutError();

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
    if (refreshGeneration !== this.generation) throw signedOutError();

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

    if (refreshGeneration !== this.generation) throw signedOutError();

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
