import { readBoundedJson } from './bounded-json';
import { extractCodexJwtIdentity, parseJwtPayload } from './jwt';
import { codexCredentialsEqual, withCodexCredentialVaultMutation } from './vault';
import type { CodexCredentialVault, CodexOAuthCredentials } from './vault';

export const CODEX_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_REVOKE_ENDPOINT = 'https://auth.openai.com/oauth/revoke';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_REQUEST_TIMEOUT_MS = 10_000;
export const CODEX_OAUTH_REVOKE_TIMEOUT_MS = 10_000;

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

export interface CodexOAuthRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const OAUTH_REQUEST_TIMEOUT_MARKER = Symbol.for('openmaic.codex.oauth.request-timeout-error.v1');

class CodexOAuthRequestAbortError extends CodexOAuthError {
  constructor(timedOut: boolean) {
    super(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
    this.name = 'CodexOAuthRequestAbortError';
    if (timedOut) {
      Object.defineProperty(this, OAUTH_REQUEST_TIMEOUT_MARKER, { value: true });
    }
  }
}

/** Recognize request-deadline expiry without exposing an abort reason. */
export function isCodexOAuthRequestTimeoutError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as Record<PropertyKey, unknown>)[OAUTH_REQUEST_TIMEOUT_MARKER] === true,
  );
}

/**
 * Bound a complete OAuth request operation, including any response parsing.
 * The explicit race guarantees settlement even for injected fetch functions
 * that ignore AbortSignal.
 */
export async function withCodexOAuthRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: CodexOAuthRequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = Math.max(0, options.timeoutMs ?? CODEX_OAUTH_REQUEST_TIMEOUT_MS);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let parentAbortListener: (() => void) | undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (timedOut: boolean) => {
      if (!controller.signal.aborted) controller.abort();
      reject(new CodexOAuthRequestAbortError(timedOut));
    };

    if (options.signal) {
      parentAbortListener = () => abort(false);
      if (options.signal.aborted) parentAbortListener();
      else options.signal.addEventListener('abort', parentAbortListener, { once: true });
    }

    if (!controller.signal.aborted) {
      timeoutHandle = setTimeout(() => abort(true), timeoutMs);
    }
  });

  try {
    if (controller.signal.aborted) return await aborted;
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (options.signal && parentAbortListener) {
      options.signal.removeEventListener('abort', parentAbortListener);
    }
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
  oauthRequestTimeoutMs?: number;
  revokeTimeoutMs?: number;
  onCredentialsCleared?: () => void | Promise<void>;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  email?: string;
}

type ValidCredentials = { accessToken: string; accountId: string };

/** @internal Server-only credential snapshot; never expose through API DTOs. */
export interface InternalCodexCredentialLease {
  readonly tokenProvider: CodexTokenProvider;
  readonly credentials: ValidCredentials;
  readonly lifecycleGeneration: number | null;
  readonly lifecycleSignal: AbortSignal | null;
}

/** @internal Binds one resolved catalog capability to its credential lifecycle. */
export interface InternalCodexCapabilityLease {
  readonly credentialLease: InternalCodexCredentialLease;
  readonly isCatalogCurrent: () => boolean | Promise<boolean>;
}

interface CredentialOperationState {
  forceRequested: boolean;
  refreshed: boolean;
  refreshCommitted: boolean;
  source: ValidCredentials | null;
  expected: ValidCredentials | null;
}

interface RefreshResult {
  credentials: ValidCredentials;
  committed: boolean;
}

interface ConditionalCodexTokenProvider {
  refreshIfCurrent(expected: ValidCredentials): Promise<ValidCredentials>;
}

interface ActiveCredentialOperation {
  state: CredentialOperationState;
  promise: Promise<ValidCredentials>;
  abortController: AbortController;
}

interface SharedCredentialState {
  generation: number;
  catalogGeneration: number;
  lifecycleController: AbortController;
  operationInFlight: ActiveCredentialOperation | null;
  logoutInFlight: Promise<void> | null;
}

interface CredentialLeaseAuthority {
  vault: CodexCredentialVault;
  sharedState: SharedCredentialState;
}

const coordinatorHost = globalThis as unknown as Record<PropertyKey, unknown>;

// Runtime v6 survives development module reloads, so its retained provider's
// authority must survive with it for reloaded lease helpers to stay managed.
const CREDENTIAL_LEASE_AUTHORITIES_KEY = Symbol.for(
  'openmaic.codex.oauth.credential-lease-authorities.v1',
);
const existingCredentialLeaseAuthorities = coordinatorHost[CREDENTIAL_LEASE_AUTHORITIES_KEY];
const credentialLeaseAuthorities =
  existingCredentialLeaseAuthorities instanceof WeakMap
    ? (existingCredentialLeaseAuthorities as WeakMap<CodexTokenProvider, CredentialLeaseAuthority>)
    : new WeakMap<CodexTokenProvider, CredentialLeaseAuthority>();

if (!(existingCredentialLeaseAuthorities instanceof WeakMap)) {
  Object.defineProperty(coordinatorHost, CREDENTIAL_LEASE_AUTHORITIES_KEY, {
    value: credentialLeaseAuthorities,
    enumerable: false,
    configurable: false,
    writable: false,
  });
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

// v4 is the lifecycle-signal boundary: a v3 registry has no controller that
// can synchronously tell already-issued leases that their lifecycle ended.
const SHARED_STATE_REGISTRY_KEY = Symbol.for('openmaic.codex.oauth.shared-credential-state.v4');
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
    if (existing) return normalizeSharedCredentialState(existing);

    const state = createSharedCredentialState();
    sharedStateRegistry.byCoordinationKey.set(coordinationKey, state);
    return state;
  }

  const existing = sharedStateRegistry.byVault.get(vault);
  if (existing) return normalizeSharedCredentialState(existing);

  const state = createSharedCredentialState();
  sharedStateRegistry.byVault.set(vault, state);
  return state;
}

function normalizeSharedCredentialState(state: SharedCredentialState): SharedCredentialState {
  // Dev HMR can retain a malformed or partially initialized v4 entry.
  // Normalize it in place so existing refresh/logout coordination survives
  // while every retained lifecycle still gains an abortable controller.
  if (!Number.isSafeInteger(state.catalogGeneration) || state.catalogGeneration < 0) {
    state.catalogGeneration = 0;
  }
  if (!(state.lifecycleController instanceof AbortController)) {
    state.lifecycleController = new AbortController();
  }
  return state;
}

function createSharedCredentialState(): SharedCredentialState {
  return {
    generation: 0,
    catalogGeneration: 0,
    lifecycleController: new AbortController(),
    operationInFlight: null,
    logoutInFlight: null,
  };
}

function advanceCodexCredentialLifecycle(state: SharedCredentialState): void {
  const staleController = state.lifecycleController;
  state.catalogGeneration += 1;
  state.lifecycleController = new AbortController();
  staleController.abort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizedErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function extractRefreshErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.error)) {
    const nested = normalizedErrorCode(payload.error.code);
    if (nested) return nested;
  }
  const stringError = normalizedErrorCode(payload.error);
  if (stringError) return stringError;
  return normalizedErrorCode(payload.code);
}

const TERMINAL_REFRESH_ERROR_CODES = new Set([
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);

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

const CREDENTIALS_CHANGED_ERROR_MARKER = Symbol.for(
  'openmaic.codex.oauth.credentials-changed-error.v1',
);

class CodexCredentialsChangedError extends CodexOAuthError {
  constructor() {
    super(CODEX_OAUTH_ERROR_CODES.SIGNED_OUT, false);
    this.name = 'CodexCredentialsChangedError';
    Object.defineProperty(this, CREDENTIALS_CHANGED_ERROR_MARKER, { value: true });
  }
}

function credentialsChangedError(): CodexOAuthError {
  return new CodexCredentialsChangedError();
}

/** Recognize the stale-request sentinel across development module reloads. */
export function isCodexCredentialsChangedError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as Record<PropertyKey, unknown>)[CREDENTIALS_CHANGED_ERROR_MARKER] === true,
  );
}

function credentialsMatch(left: ValidCredentials | null, right: ValidCredentials): boolean {
  return left?.accountId === right.accountId && left.accessToken === right.accessToken;
}

async function managedLeaseCredentialsMatch(
  authority: CredentialLeaseAuthority,
  credentials: ValidCredentials,
): Promise<boolean> {
  try {
    const current = await withCodexCredentialVaultMutation(authority.vault, () =>
      authority.vault.load(),
    );
    return Boolean(
      current &&
      current.accountId === credentials.accountId &&
      current.accessToken === credentials.accessToken,
    );
  } catch {
    return false;
  }
}

async function managedLeaseAccountMatches(
  authority: CredentialLeaseAuthority,
  accountId: string,
): Promise<boolean> {
  try {
    const current = await withCodexCredentialVaultMutation(authority.vault, () =>
      authority.vault.load(),
    );
    return current?.accountId === accountId;
  } catch {
    return false;
  }
}

/** @internal Acquire an account/lifecycle snapshot without changing CodexTokenProvider. */
export async function acquireCodexCredentialLease(
  tokenProvider: CodexTokenProvider,
): Promise<InternalCodexCredentialLease> {
  const authority = credentialLeaseAuthorities.get(tokenProvider);
  if (!authority) {
    const credentials = await tokenProvider.getValidCredentials();
    return Object.freeze({
      tokenProvider,
      credentials: { ...credentials },
      lifecycleGeneration: null,
      lifecycleSignal: null,
    });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lifecycleGeneration = authority.sharedState.catalogGeneration;
    const lifecycleSignal = authority.sharedState.lifecycleController.signal;
    const credentials = await tokenProvider.getValidCredentials();
    if (
      !lifecycleSignal.aborted &&
      lifecycleGeneration === authority.sharedState.catalogGeneration &&
      lifecycleSignal === authority.sharedState.lifecycleController.signal &&
      (await managedLeaseCredentialsMatch(authority, credentials)) &&
      !lifecycleSignal.aborted &&
      lifecycleGeneration === authority.sharedState.catalogGeneration &&
      lifecycleSignal === authority.sharedState.lifecycleController.signal
    ) {
      return Object.freeze({
        tokenProvider,
        credentials: { ...credentials },
        lifecycleGeneration,
        lifecycleSignal,
      });
    }
  }
  throw credentialsChangedError();
}

/** @internal Validate immediately before each account-bound upstream send. */
export async function isCodexCredentialLeaseCurrent(
  lease: InternalCodexCredentialLease,
): Promise<boolean> {
  const authority = credentialLeaseAuthorities.get(lease.tokenProvider);
  if (authority) {
    const lifecycleSignal = lease.lifecycleSignal;
    return (
      lease.lifecycleGeneration !== null &&
      lifecycleSignal !== null &&
      lifecycleSignal === authority.sharedState.lifecycleController.signal &&
      !lifecycleSignal.aborted &&
      lease.lifecycleGeneration === authority.sharedState.catalogGeneration &&
      (await managedLeaseCredentialsMatch(authority, lease.credentials)) &&
      lifecycleSignal === authority.sharedState.lifecycleController.signal &&
      !lifecycleSignal.aborted &&
      lease.lifecycleGeneration === authority.sharedState.catalogGeneration
    );
  }

  try {
    const current = await lease.tokenProvider.getValidCredentials();
    return credentialsMatch(current, lease.credentials);
  } catch {
    return false;
  }
}

/**
 * @internal Validate response publication/completion against the account
 * lifecycle without rejecting an allowed same-account access-token rotation.
 */
export async function isCodexCredentialLifecycleCurrent(
  lease: InternalCodexCredentialLease,
): Promise<boolean> {
  const authority = credentialLeaseAuthorities.get(lease.tokenProvider);
  if (authority) {
    const lifecycleSignal = lease.lifecycleSignal;
    return (
      lease.lifecycleGeneration !== null &&
      lifecycleSignal !== null &&
      lifecycleSignal === authority.sharedState.lifecycleController.signal &&
      !lifecycleSignal.aborted &&
      lease.lifecycleGeneration === authority.sharedState.catalogGeneration &&
      (await managedLeaseAccountMatches(authority, lease.credentials.accountId)) &&
      lifecycleSignal === authority.sharedState.lifecycleController.signal &&
      !lifecycleSignal.aborted &&
      lease.lifecycleGeneration === authority.sharedState.catalogGeneration
    );
  }

  try {
    const current = await lease.tokenProvider.getValidCredentials();
    return current.accountId === lease.credentials.accountId;
  } catch {
    return false;
  }
}

/** @internal Rotate one lease only while its account/catalog lifecycle remains current. */
export async function refreshCodexCredentialLease(
  lease: InternalCodexCredentialLease,
): Promise<InternalCodexCredentialLease> {
  if (!(await isCodexCredentialLeaseCurrent(lease))) throw credentialsChangedError();
  const credentials = await refreshCodexCredentialsIfCurrent(
    lease.tokenProvider,
    lease.credentials,
  );
  if (credentials.accountId !== lease.credentials.accountId) throw credentialsChangedError();

  const refreshed = Object.freeze({
    tokenProvider: lease.tokenProvider,
    credentials: { ...credentials },
    lifecycleGeneration: lease.lifecycleGeneration,
    lifecycleSignal: lease.lifecycleSignal,
  });
  if (!(await isCodexCredentialLeaseCurrent(refreshed))) throw credentialsChangedError();
  return refreshed;
}

/** @internal Invalidate capabilities before a login replacement becomes visible. */
export function invalidateCodexCredentialLeases(tokenProvider: CodexTokenProvider): void {
  const authority = credentialLeaseAuthorities.get(tokenProvider);
  if (authority) advanceCodexCredentialLifecycle(authority.sharedState);
}

/** @internal Validate both credential and catalog generations. */
export async function isCodexCapabilityLeaseCurrent(
  lease: InternalCodexCapabilityLease,
): Promise<boolean> {
  try {
    if (!(await lease.isCatalogCurrent())) return false;
    if (!(await isCodexCredentialLeaseCurrent(lease.credentialLease))) return false;
    return await lease.isCatalogCurrent();
  } catch {
    return false;
  }
}

/** @internal Validate response lifecycle/account plus the selected catalog capability. */
export async function isCodexCapabilityLifecycleCurrent(
  lease: InternalCodexCapabilityLease,
): Promise<boolean> {
  try {
    if (!(await lease.isCatalogCurrent())) return false;
    if (!(await isCodexCredentialLifecycleCurrent(lease.credentialLease))) return false;
    return await lease.isCatalogCurrent();
  } catch {
    return false;
  }
}

/** @internal Preserve the catalog guard across an allowed same-account rotation. */
export async function refreshCodexCapabilityLease(
  lease: InternalCodexCapabilityLease,
): Promise<InternalCodexCapabilityLease> {
  if (!(await lease.isCatalogCurrent())) throw credentialsChangedError();
  const credentialLease = await refreshCodexCredentialLease(lease.credentialLease);
  if (!(await lease.isCatalogCurrent())) throw credentialsChangedError();
  return Object.freeze({ credentialLease, isCatalogCurrent: lease.isCatalogCurrent });
}

/** Fail closed unless the provider supports an atomic account/token-scoped refresh. */
export function refreshCodexCredentialsIfCurrent(
  tokenProvider: CodexTokenProvider,
  expected: ValidCredentials,
): Promise<ValidCredentials> {
  const conditional = tokenProvider as CodexTokenProvider & Partial<ConditionalCodexTokenProvider>;
  if (typeof conditional.refreshIfCurrent !== 'function') {
    return Promise.reject(credentialsChangedError());
  }
  return conditional.refreshIfCurrent(expected);
}

export class ManagedCodexTokenProvider implements CodexTokenProvider {
  private readonly vault: CodexCredentialVault;
  private readonly tokenExchangeFetch: TokenExchangeFetch;
  private readonly clock: CodexClock;
  private readonly sharedState: SharedCredentialState;
  private readonly oauthRequestTimeoutMs: number;
  private readonly revokeTimeoutMs: number;
  private readonly onCredentialsCleared?: () => void | Promise<void>;

  constructor(options: ManagedCodexTokenProviderOptions) {
    this.vault = options.vault;
    this.tokenExchangeFetch = options.tokenExchangeFetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? { now: Date.now };
    this.sharedState = getSharedCredentialState(options.vault);
    this.oauthRequestTimeoutMs = Math.max(
      0,
      options.oauthRequestTimeoutMs ?? CODEX_OAUTH_REQUEST_TIMEOUT_MS,
    );
    this.revokeTimeoutMs = Math.min(
      CODEX_OAUTH_REVOKE_TIMEOUT_MS,
      Math.max(0, options.revokeTimeoutMs ?? CODEX_OAUTH_REVOKE_TIMEOUT_MS),
    );
    this.onCredentialsCleared = options.onCredentialsCleared;
    credentialLeaseAuthorities.set(this, { vault: this.vault, sharedState: this.sharedState });
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

    return this.startCredentialOperation(options?.forceRefresh === true, null);
  }

  /**
   * Refresh only if the vault still contains the exact credentials used by
   * the request that received a 401. This is intentionally not part of the
   * public CodexTokenProvider contract; transports reach it through the
   * fail-closed structural helper above.
   */
  refreshIfCurrent(expected: ValidCredentials): Promise<ValidCredentials> {
    if (this.sharedState.logoutInFlight) {
      return this.sharedState.logoutInFlight.then(() => {
        throw signedOutError();
      });
    }

    const existing = this.sharedState.operationInFlight;
    if (existing) {
      return existing.promise.then((result) => {
        if (!credentialsMatch(existing.state.source, expected)) throw credentialsChangedError();
        if (existing.state.refreshed) {
          if (!existing.state.refreshCommitted || result.accountId !== expected.accountId) {
            throw credentialsChangedError();
          }
          return result;
        }
        return this.refreshIfCurrent(expected);
      });
    }

    return this.startCredentialOperation(true, expected);
  }

  private startCredentialOperation(
    forceRequested: boolean,
    expected: ValidCredentials | null,
  ): Promise<ValidCredentials> {
    const requestGeneration = this.sharedState.generation;
    const state: CredentialOperationState = {
      forceRequested,
      refreshed: false,
      refreshCommitted: false,
      source: null,
      expected,
    };
    const abortController = new AbortController();
    const operation: ActiveCredentialOperation = {
      state,
      promise: this.resolveCredentials(state, requestGeneration, abortController.signal),
      abortController,
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
    advanceCodexCredentialLifecycle(this.sharedState);
    const activeOperation = this.sharedState.operationInFlight;
    const staleOperation = activeOperation?.promise ?? null;
    activeOperation?.abortController.abort();
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
    signal: AbortSignal,
  ): Promise<ValidCredentials> {
    let credentials: CodexOAuthCredentials | null;

    try {
      credentials = await withCodexCredentialVaultMutation(this.vault, () => this.vault.load());
    } catch {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
    }

    if (requestGeneration !== this.sharedState.generation) throw signedOutError();
    if (!credentials) {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false);
    }

    const source = { accessToken: credentials.accessToken, accountId: credentials.accountId };
    state.source = source;
    if (state.expected && !credentialsMatch(source, state.expected)) {
      throw credentialsChangedError();
    }

    const shouldRefresh =
      state.forceRequested || credentials.expiresAt - this.clock.now() <= REFRESH_EARLY_MS;
    if (!shouldRefresh) {
      return source;
    }

    state.refreshed = true;
    const result = await this.refreshCredentials(
      credentials,
      requestGeneration,
      state.expected,
      signal,
    );
    state.refreshCommitted = result.committed;
    if (
      state.expected &&
      (!result.committed || result.credentials.accountId !== state.expected.accountId)
    ) {
      throw credentialsChangedError();
    }
    return result.credentials;
  }

  private async finishLogout(staleOperation: Promise<ValidCredentials> | null): Promise<void> {
    let captured: CodexOAuthCredentials | null;
    try {
      captured = await withCodexCredentialVaultMutation(this.vault, async () => {
        let current: CodexOAuthCredentials | null = null;
        try {
          current = await this.vault.load();
        } catch {
          // Clearing local credentials remains authoritative even if a corrupt
          // or unavailable vault cannot provide a revocation snapshot.
        }
        await this.vault.clear();
        return current;
      });
    } catch {
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
    }

    await this.notifyCredentialsCleared();
    await staleOperation?.catch(() => undefined);
    if (!captured) return;

    try {
      await withCodexOAuthRequestTimeout(
        async (signal) => {
          await this.tokenExchangeFetch(CODEX_OAUTH_REVOKE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              token: captured.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: CODEX_OAUTH_CLIENT_ID,
            }),
            redirect: 'error',
            signal,
          });
        },
        { timeoutMs: this.revokeTimeoutMs },
      );
    } catch {
      // Revocation is best-effort. Local logout already committed and must not
      // be rolled back or failed by network, timeout, or upstream status.
    }
  }

  private async notifyCredentialsCleared(): Promise<void> {
    try {
      await this.onCredentialsCleared?.();
    } catch {
      // Lifecycle listeners are internal invalidation notifications. They must
      // never restore credentials or turn a committed local clear into failure.
    }
  }

  private async refreshCredentials(
    credentials: CodexOAuthCredentials,
    refreshGeneration: number,
    expected: ValidCredentials | null,
    signal: AbortSignal,
  ): Promise<RefreshResult> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: credentials.refreshToken,
    });

    let requestResult: { response: Response; payload: unknown };
    try {
      requestResult = await withCodexOAuthRequestTimeout(
        async (requestSignal) => {
          const response = await this.tokenExchangeFetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
            redirect: 'error',
            signal: requestSignal,
          });
          if (response.status === 401 || response.status >= 500) {
            return { response, payload: null };
          }
          const json = await readBoundedJson(response, requestSignal);
          return { response, payload: json.ok ? json.payload : null };
        },
        { signal, timeoutMs: this.oauthRequestTimeoutMs },
      );
    } catch {
      if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
    }

    if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
    const { response, payload } = requestResult;

    if (!response.ok) {
      if (response.status >= 500) {
        throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR, true, response.status);
      }

      const errorCode = extractRefreshErrorCode(payload);
      if (response.status === 401 || (errorCode && TERMINAL_REFRESH_ERROR_CODES.has(errorCode))) {
        let clearResult: { replacement: CodexOAuthCredentials | null; cleared: boolean };
        try {
          clearResult = await withCodexCredentialVaultMutation(this.vault, async () => {
            if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
            const current = await this.vault.load();
            if (!codexCredentialsEqual(current, credentials)) {
              return { replacement: current, cleared: false };
            }
            await this.vault.clear();
            return { replacement: null, cleared: true };
          });
        } catch (error) {
          if (error instanceof CodexOAuthError) throw error;
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
        }
        if (clearResult.cleared) {
          advanceCodexCredentialLifecycle(this.sharedState);
          await this.notifyCredentialsCleared();
        }
        if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
        if (clearResult.replacement) {
          return {
            credentials: {
              accessToken: clearResult.replacement.accessToken,
              accountId: clearResult.replacement.accountId,
            },
            committed: false,
          };
        }
        throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_GRANT, false);
      }

      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED, false, response.status);
    }

    const parsed = this.parseTokenResponse(payload, credentials);
    if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
    if (expected && parsed.accountId !== expected.accountId) throw credentialsChangedError();

    const nextCredentials: CodexOAuthCredentials = {
      version: 1,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      accountId: parsed.accountId,
      ...(parsed.email ? { email: parsed.email } : {}),
      updatedAt: this.clock.now(),
    };

    let commitResult: { credentials: CodexOAuthCredentials; committed: boolean };
    try {
      commitResult = await withCodexCredentialVaultMutation(this.vault, async () => {
        if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
        const current = await this.vault.load();
        if (!codexCredentialsEqual(current, credentials)) {
          if (!current) {
            throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING, false);
          }
          return { credentials: current, committed: false };
        }
        await this.vault.save(nextCredentials);
        if (refreshGeneration !== this.sharedState.generation) throw signedOutError();
        return { credentials: nextCredentials, committed: true };
      });
    } catch (error) {
      if (error instanceof CodexOAuthError) throw error;
      throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR, false);
    }

    if (refreshGeneration !== this.sharedState.generation) throw signedOutError();

    return {
      credentials: {
        accessToken: commitResult.credentials.accessToken,
        accountId: commitResult.credentials.accountId,
      },
      committed: commitResult.committed,
    };
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
