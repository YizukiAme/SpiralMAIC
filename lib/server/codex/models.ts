import packageMetadata from '../../../package.json';
import { createHash } from 'node:crypto';

import {
  CODEX_COMPATIBILITY_VERSION,
  CODEX_MODEL_CATALOG_LIMITS,
  buildCodexThinkingCapability,
  getBundledCodexModelCatalog,
  isCodexThinkingEffort,
  rebuildCodexModelCatalog,
} from '@/lib/ai/codex-catalog';
import type { ModelInfo, ModelServiceTier, ThinkingEffort } from '@/lib/types/provider';

import type { CodexModelCatalogStore } from './model-cache-store';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  acquireCodexCredentialLease,
  isCodexCredentialLeaseCurrent,
  refreshCodexCredentialLease,
  type CodexTokenProvider,
  type InternalCodexCapabilityLease,
  type InternalCodexCredentialLease,
} from './token-provider';
import { withCodexCredentialVaultMutation, type CodexCredentialVault } from './vault';

/**
 * Protocol compatibility advertised to the Codex models endpoint.
 *
 * This is intentionally independent from OpenMAIC's package version. Keep it
 * aligned with a verified official Codex release whose model schema and
 * minimal_client_version semantics this adapter supports.
 */
export { CODEX_COMPATIBILITY_VERSION } from '@/lib/ai/codex-catalog';
export const CODEX_MODELS_ENDPOINT = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_COMPATIBILITY_VERSION}`;
export const CODEX_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
export const CODEX_MODELS_REQUEST_TIMEOUT_MS = 5_000;

export function getCodexFallbackModels(): ModelInfo[] {
  return getBundledCodexModelCatalog();
}

export const CODEX_MODELS_ERROR_CODES = {
  INVALID_ENDPOINT: 'INVALID_ENDPOINT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const;

export type CodexModelsErrorCode =
  (typeof CODEX_MODELS_ERROR_CODES)[keyof typeof CODEX_MODELS_ERROR_CODES];

const SAFE_ERROR_MESSAGES: Record<CodexModelsErrorCode, string> = {
  INVALID_ENDPOINT: 'Codex model service rejected an unsupported endpoint',
  INVALID_REQUEST: 'Codex model service rejected an invalid request',
  AUTH_REQUIRED: 'Codex sign-in must be renewed',
  NETWORK_ERROR: 'Codex model service could not be reached',
  UPSTREAM_ERROR: 'Codex model service is temporarily unavailable',
  INVALID_RESPONSE: 'Codex model service returned an invalid response',
};

export class CodexModelsError extends Error {
  constructor(
    public readonly code: CodexModelsErrorCode,
    public readonly upstreamStatus?: number,
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'CodexModelsError';
  }
}

interface CreateCodexModelsTransportOptions {
  tokenProvider: CodexTokenProvider;
  upstreamFetch?: typeof globalThis.fetch;
}

interface CodexModelsRequestAuthOptions {
  allowAuthReplay: boolean;
  credentialLease?: InternalCodexCredentialLease;
  canAuthReplay?(): Promise<boolean>;
  onAuthReplay?(): void;
}

interface CodexModelsRequestResult {
  response: Response;
  credentialLease: InternalCodexCredentialLease;
}

type CodexModelsRequest = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  authOptions: CodexModelsRequestAuthOptions,
) => Promise<CodexModelsRequestResult>;

interface CodexModelsClock {
  now(): number;
}

interface CodexModelDiscoveryOptions extends CreateCodexModelsTransportOptions {
  /** A non-secret identity that changes on login, refresh rotation, and logout. */
  credentialGeneration(): Promise<string | null>;
  /** Server-only account lookup used when refresh fails but stored credentials remain. */
  credentialAccountId?(): Promise<string | null>;
  catalogStore?: CodexModelCatalogStore;
  clock?: CodexModelsClock;
  cacheTtlMs?: number;
}

interface CodexModelCacheEntry {
  accountScope: string;
  generation: string;
  models: ModelInfo[];
  etag?: string;
  fetchedAt: number;
}

interface CodexModelAuthReplayChain {
  activeCallers: number;
  authReplaysRemaining: number;
}

interface CodexModelDiscoveryRequestContext {
  authReplayChain?: CodexModelAuthReplayChain;
  authReplayChainKey?: string;
}

interface CodexModelFlight {
  promise: Promise<ModelInfo[]>;
  authReplayState: { used: boolean };
}

/** @internal Safe model metadata bound to one account/catalog capability. */
export interface InternalCodexModelCapability {
  modelInfo: ModelInfo;
  capabilityLease: InternalCodexCapabilityLease;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  const parsed = nonEmptyString(value);
  return parsed && parsed.length <= maxLength ? parsed : undefined;
}

function boundedContextWindow(value: unknown): number | undefined {
  return Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= CODEX_MODEL_CATALOG_LIMITS.maxContextWindow
    ? (value as number)
    : undefined;
}

function numericPriority(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function parseServiceTiers(model: Record<string, unknown>): ModelServiceTier[] | undefined {
  const currentTiers = model.service_tiers;
  const supportsPriority =
    Array.isArray(currentTiers) &&
    currentTiers.some((tier) => isRecord(tier) && tier.id === 'priority');
  const legacyTiers = model.additional_speed_tiers;
  const supportsLegacyFast =
    Array.isArray(legacyTiers) && legacyTiers.some((tier) => tier === 'fast');

  return supportsPriority || supportsLegacyFast ? ['priority'] : undefined;
}

function parseThinking(model: Record<string, unknown>) {
  if (!Array.isArray(model.supported_reasoning_levels)) return undefined;
  const efforts: ThinkingEffort[] = [];
  const seen = new Set<ThinkingEffort>();
  for (const level of model.supported_reasoning_levels) {
    if (!isRecord(level) || !isCodexThinkingEffort(level.effort) || seen.has(level.effort)) {
      continue;
    }
    seen.add(level.effort);
    efforts.push(level.effort);
  }
  const defaultEffort = isCodexThinkingEffort(model.default_reasoning_level)
    ? model.default_reasoning_level
    : undefined;
  return buildCodexThinkingCapability(efforts, defaultEffort);
}

interface SemanticVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[] | null;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemanticVersion(value: unknown): SemanticVersion | null {
  if (typeof value !== 'string') return null;
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;

  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }

  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

function comparePrerelease(left: string[] | null, right: string[] | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function supportsClientVersion(minimum: unknown, clientVersion: string): boolean {
  if (minimum === undefined || minimum === null) return true;
  const parsedMinimum = parseSemanticVersion(minimum);
  const parsedClient = parseSemanticVersion(clientVersion);
  if (!parsedMinimum || !parsedClient) return false;
  return compareSemanticVersions(parsedMinimum, parsedClient) <= 0;
}

/** Convert the upstream envelope to the only model fields safe for client sync. */
export function parseCodexModels(
  payload: unknown,
  clientVersion = CODEX_COMPATIBILITY_VERSION,
): ModelInfo[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_RESPONSE);
  }

  const records = payload.models
    .map((value, sourceIndex) => ({ value, sourceIndex }))
    .filter(
      (entry): entry is { value: Record<string, unknown>; sourceIndex: number } =>
        isRecord(entry.value) &&
        (boundedString(entry.value.slug, CODEX_MODEL_CATALOG_LIMITS.maxIdLength) !== undefined ||
          boundedString(entry.value.id, CODEX_MODEL_CATALOG_LIMITS.maxIdLength) !== undefined) &&
        entry.value.visibility === 'list' &&
        supportsClientVersion(entry.value.minimal_client_version, clientVersion),
    )
    .sort((left, right) => {
      const priority = numericPriority(left.value.priority) - numericPriority(right.value.priority);
      return Number.isNaN(priority) || priority === 0
        ? left.sourceIndex - right.sourceIndex
        : priority;
    });

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const { value } of records) {
    const id =
      boundedString(value.slug, CODEX_MODEL_CATALOG_LIMITS.maxIdLength) ??
      boundedString(value.id, CODEX_MODEL_CATALOG_LIMITS.maxIdLength);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      boundedString(value.display_name, CODEX_MODEL_CATALOG_LIMITS.maxNameLength) ??
      boundedString(value.name, CODEX_MODEL_CATALOG_LIMITS.maxNameLength) ??
      id;
    const contextWindow = boundedContextWindow(value.context_window);
    const vision =
      Array.isArray(value.input_modalities) && value.input_modalities.includes('image');
    const thinking = parseThinking(value);
    const serviceTiers = parseServiceTiers(value);
    models.push({
      id,
      name,
      ...(contextWindow ? { contextWindow } : {}),
      capabilities: {
        streaming: true,
        tools: true,
        ...(vision ? { vision: true } : {}),
        ...(thinking ? { thinking } : {}),
        ...(serviceTiers ? { serviceTiers } : {}),
      },
      source: 'probed',
    });
    if (models.length === CODEX_MODEL_CATALOG_LIMITS.maxModels) break;
  }

  if (models.length === 0) {
    throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_RESPONSE);
  }
  return models;
}

function createHeaders(
  inputHeaders: HeadersInit | undefined,
  credentials: { accessToken: string; accountId: string },
): Headers {
  const input = new Headers(inputHeaders);
  const headers = new Headers();
  const etag = input.get('if-none-match');
  if (etag) headers.set('if-none-match', etag);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${credentials.accessToken}`);
  headers.set('chatgpt-account-id', credentials.accountId);
  headers.set('originator', 'openmaic');
  headers.set('user-agent', `OpenMAIC/${packageMetadata.version} (native Codex OAuth)`);
  return headers;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function withModelsRequestTimeout<T>(
  inputSignal: AbortSignal | null | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: CodexModelsError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectAbort(new CodexModelsError(CODEX_MODELS_ERROR_CODES.NETWORK_ERROR));
  };
  const timer = setTimeout(abort, CODEX_MODELS_REQUEST_TIMEOUT_MS);

  if (inputSignal?.aborted) abort();
  else inputSignal?.addEventListener('abort', abort, { once: true });

  try {
    if (controller.signal.aborted) return await aborted;
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    inputSignal?.removeEventListener('abort', abort);
  }
}

function credentialsError(): CodexModelsError {
  return new CodexModelsError(CODEX_MODELS_ERROR_CODES.AUTH_REQUIRED);
}

function modelsErrorForCredentialFailure(error: unknown): CodexModelsError {
  if (error instanceof CodexModelsError) return error;
  if (error instanceof CodexOAuthError && error.retryable) {
    if (error.code === CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR) {
      return new CodexModelsError(CODEX_MODELS_ERROR_CODES.NETWORK_ERROR);
    }
    if (
      error.code === CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR &&
      error.upstreamStatus !== undefined &&
      error.upstreamStatus >= 500
    ) {
      return new CodexModelsError(CODEX_MODELS_ERROR_CODES.UPSTREAM_ERROR, error.upstreamStatus);
    }
  }
  return credentialsError();
}

function allowsCredentialCatalogFallback(error: unknown): boolean {
  return (
    error instanceof CodexOAuthError &&
    error.retryable &&
    (error.code === CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR ||
      error.code === CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR)
  );
}

function allowsLiveCatalogFallback(error: unknown): boolean {
  if (!(error instanceof CodexModelsError)) return false;
  if (
    error.code === CODEX_MODELS_ERROR_CODES.NETWORK_ERROR ||
    error.code === CODEX_MODELS_ERROR_CODES.INVALID_RESPONSE
  ) {
    return true;
  }
  return (
    error.code === CODEX_MODELS_ERROR_CODES.UPSTREAM_ERROR &&
    error.upstreamStatus !== undefined &&
    error.upstreamStatus >= 500
  );
}

function createCodexModelsRequest(options: CreateCodexModelsTransportOptions): CodexModelsRequest {
  const upstreamFetch = options.upstreamFetch ?? globalThis.fetch.bind(globalThis);

  return async (input, init, authOptions) => {
    if (typeof input !== 'string' || input !== CODEX_MODELS_ENDPOINT) {
      throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_ENDPOINT);
    }
    if (init?.method && init.method.toUpperCase() !== 'GET') {
      throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_REQUEST);
    }

    return withModelsRequestTimeout(init?.signal, async (signal) => {
      let credentialLease: InternalCodexCredentialLease;
      try {
        credentialLease =
          authOptions.credentialLease ?? (await acquireCodexCredentialLease(options.tokenProvider));
      } catch (error) {
        throw modelsErrorForCredentialFailure(error);
      }
      if (credentialLease.tokenProvider !== options.tokenProvider) throw credentialsError();

      const request = async (forceRefresh: boolean): Promise<Response> => {
        try {
          if (forceRefresh) {
            credentialLease = await refreshCodexCredentialLease(credentialLease);
          } else if (!(await isCodexCredentialLeaseCurrent(credentialLease))) {
            throw credentialsError();
          }
        } catch (error) {
          throw modelsErrorForCredentialFailure(error);
        }
        if (!(await isCodexCredentialLeaseCurrent(credentialLease))) throw credentialsError();

        try {
          return await upstreamFetch(CODEX_MODELS_ENDPOINT, {
            method: 'GET',
            headers: createHeaders(init?.headers, credentialLease.credentials),
            redirect: 'manual',
            signal,
          });
        } catch {
          throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.NETWORK_ERROR);
        }
      };

      let response = await request(false);
      if (response.status === 401 && authOptions.allowAuthReplay) {
        await cancelResponseBody(response);
        const canReplay = await authOptions.canAuthReplay?.().catch(() => false);
        if (signal.aborted || canReplay === false) {
          throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.AUTH_REQUIRED, response.status);
        }
        authOptions.onAuthReplay?.();
        response = await request(true);
      }

      if (response.status === 304 || response.ok) return { response, credentialLease };
      await cancelResponseBody(response);
      if (response.status === 401) {
        throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.AUTH_REQUIRED, response.status);
      }
      throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.UPSTREAM_ERROR, response.status);
    });
  };
}

/** The only authenticated network boundary for Codex model discovery. */
export function createCodexModelsTransport(
  options: CreateCodexModelsTransportOptions,
): typeof globalThis.fetch {
  const request = createCodexModelsRequest(options);
  return async (input, init) => (await request(input, init, { allowAuthReplay: true })).response;
}

function cloneModels(models: ModelInfo[]): ModelInfo[] {
  return rebuildCodexModelCatalog(models) ?? [];
}

export class CodexModelDiscovery {
  private readonly requestModels: CodexModelsRequest;
  private readonly tokenProvider: CodexTokenProvider;
  private readonly credentialGeneration: () => Promise<string | null>;
  private readonly credentialAccountId?: () => Promise<string | null>;
  private readonly catalogStore?: CodexModelCatalogStore;
  private readonly clock: CodexModelsClock;
  private readonly cacheTtlMs: number;
  private cache: CodexModelCacheEntry | null = null;
  private readonly inFlight = new Map<string, CodexModelFlight>();
  private readonly authReplayChains = new Map<string, CodexModelAuthReplayChain>();
  private invalidationGeneration = 0;
  private clearInFlight: Promise<void> | null = null;

  constructor(options: CodexModelDiscoveryOptions) {
    this.requestModels = createCodexModelsRequest(options);
    this.tokenProvider = options.tokenProvider;
    this.credentialGeneration = options.credentialGeneration;
    this.credentialAccountId = options.credentialAccountId;
    this.catalogStore = options.catalogStore;
    this.clock = options.clock ?? { now: Date.now };
    this.cacheTtlMs = options.cacheTtlMs ?? CODEX_MODELS_CACHE_TTL_MS;
  }

  invalidate(): void {
    this.cache = null;
    this.invalidationGeneration += 1;
  }

  clear(): Promise<void> {
    this.invalidate();
    const previousClear = this.clearInFlight;
    const operation = (async () => {
      await previousClear?.catch(() => undefined);
      await this.catalogStore?.clear();
    })();
    this.clearInFlight = operation;
    return operation.finally(() => {
      if (this.clearInFlight === operation) this.clearInFlight = null;
    });
  }

  async getModels(): Promise<ModelInfo[]> {
    await this.clearInFlight?.catch(() => undefined);
    const requestContext: CodexModelDiscoveryRequestContext = {};
    try {
      return await this.getModelsForCurrentCredentials(requestContext, true);
    } finally {
      this.releaseAuthReplayChain(requestContext);
    }
  }

  /** Resolve one model and retain the exact account/catalog lifecycle that authorized it. */
  async getModelCapability(modelId: string): Promise<InternalCodexModelCapability | null> {
    await this.clearInFlight?.catch(() => undefined);

    // A same-account 401 rotation can replace the exact access token while the
    // catalog lifecycle remains valid. Retry once so the returned credential
    // lease always contains the post-rotation token snapshot.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const invalidationGeneration = this.invalidationGeneration;
      const credentialLease = await acquireCodexCredentialLease(this.tokenProvider);

      const requestContext: CodexModelDiscoveryRequestContext = {};
      try {
        const models = await this.getModelsForCurrentCredentials(
          requestContext,
          true,
          credentialLease.credentials.accountId,
          credentialLease,
        );
        if (
          this.invalidationGeneration !== invalidationGeneration ||
          !(await isCodexCredentialLeaseCurrent(credentialLease))
        ) {
          continue;
        }
        const modelInfo = rebuildCodexModelCatalog(models)?.find((model) => model.id === modelId);
        if (!modelInfo) return null;

        const capabilityAccountScope = this.getAccountScope(credentialLease.credentials.accountId);
        const capabilityFingerprint = JSON.stringify(modelInfo);
        const isCatalogCurrent = () => {
          if (this.invalidationGeneration !== invalidationGeneration) return false;
          if (!this.cache) return true;
          if (this.cache.accountScope !== capabilityAccountScope) return false;
          const currentModel = this.cache.models.find((model) => model.id === modelId);
          return Boolean(currentModel && JSON.stringify(currentModel) === capabilityFingerprint);
        };
        if (!isCatalogCurrent()) return null;
        return {
          modelInfo,
          capabilityLease: Object.freeze({ credentialLease, isCatalogCurrent }),
        };
      } finally {
        this.releaseAuthReplayChain(requestContext);
      }
    }
    return null;
  }

  private async getModelsForCurrentCredentials(
    requestContext: CodexModelDiscoveryRequestContext,
    allowSameAccountRotationRetry: boolean,
    expectedAccountId?: string,
    initialCredentialLease?: InternalCodexCredentialLease,
  ): Promise<ModelInfo[]> {
    // Settle refresh rotation before deriving the cache generation. Otherwise
    // this very request could refresh the token inside the transport and make
    // its own valid response look stale.
    let credentialLease: InternalCodexCredentialLease;
    try {
      credentialLease =
        initialCredentialLease ?? (await acquireCodexCredentialLease(this.tokenProvider));
    } catch (error) {
      if (expectedAccountId) return [];
      if (!allowsCredentialCatalogFallback(error)) {
        this.invalidate();
        return [];
      }
      const preservedGeneration = await this.credentialGeneration().catch(() => null);
      if (!preservedGeneration) {
        this.invalidate();
        return [];
      }
      const invalidationGeneration = this.invalidationGeneration;
      if (this.cache?.generation === preservedGeneration) return cloneModels(this.cache.models);

      const accountId = await this.credentialAccountId?.().catch(() => null);
      if (!(await this.isCurrentGeneration(preservedGeneration, invalidationGeneration))) return [];
      if (!accountId) return getCodexFallbackModels();
      if (this.cache?.accountScope === this.getAccountScope(accountId)) {
        return cloneModels(this.cache.models);
      }
      const lkg = await this.catalogStore?.load(accountId, this.clock.now()).catch(() => null);
      if (!(await this.isCurrentGeneration(preservedGeneration, invalidationGeneration))) return [];
      return lkg ? cloneModels(lkg.models) : getCodexFallbackModels();
    }
    const settledCredentials = credentialLease.credentials;
    if (expectedAccountId && settledCredentials.accountId !== expectedAccountId) return [];

    const invalidationGeneration = this.invalidationGeneration;
    const generation = await this.credentialGeneration();
    if (!generation) {
      this.invalidate();
      return [];
    }
    if (!(await isCodexCredentialLeaseCurrent(credentialLease))) return [];
    if (
      !this.acquireAuthReplayChain(
        requestContext,
        settledCredentials.accountId,
        invalidationGeneration,
      )
    ) {
      return [];
    }

    const now = this.clock.now();
    const accountScope = this.getAccountScope(settledCredentials.accountId);
    const cacheAge = this.cache ? now - this.cache.fetchedAt : Number.POSITIVE_INFINITY;
    if (this.cache?.accountScope === accountScope && cacheAge >= 0 && cacheAge < this.cacheTtlMs) {
      // Refresh-token rotation changes the opaque generation but not the
      // account-scoped catalog. Retag the fresh entry without clearing it.
      this.cache = { ...this.cache, generation };
      return cloneModels(this.cache.models);
    }

    const flightKey = `${invalidationGeneration}:${generation}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) {
      const models = await existing.promise;
      if (existing.authReplayState.used && requestContext.authReplayChain) {
        requestContext.authReplayChain.authReplaysRemaining = 0;
      }
      return cloneModels(
        await this.retryAfterSameAccountRotation(models, {
          requestContext,
          allowRetry: allowSameAccountRotationRetry,
          accountId: settledCredentials.accountId,
          generation,
          invalidationGeneration,
        }),
      );
    }

    const authReplayState = { used: false };
    const operation = this.refresh(
      settledCredentials.accountId,
      accountScope,
      generation,
      now,
      invalidationGeneration,
      {
        credentialLease,
        allowAuthReplay: (requestContext.authReplayChain?.authReplaysRemaining ?? 0) > 0,
        canAuthReplay: () =>
          this.canAuthReplay(
            requestContext,
            settledCredentials.accountId,
            generation,
            invalidationGeneration,
          ),
        onAuthReplay: () => {
          authReplayState.used = true;
          if (requestContext.authReplayChain) {
            requestContext.authReplayChain.authReplaysRemaining = 0;
          }
        },
      },
    );
    const flight: CodexModelFlight = { promise: operation, authReplayState };
    this.inFlight.set(flightKey, flight);
    try {
      const models = await operation;
      return cloneModels(
        await this.retryAfterSameAccountRotation(models, {
          requestContext,
          allowRetry: allowSameAccountRotationRetry,
          accountId: settledCredentials.accountId,
          generation,
          invalidationGeneration,
        }),
      );
    } finally {
      if (this.inFlight.get(flightKey) === flight) this.inFlight.delete(flightKey);
    }
  }

  private acquireAuthReplayChain(
    requestContext: CodexModelDiscoveryRequestContext,
    accountId: string,
    invalidationGeneration: number,
  ): boolean {
    const chainKey = this.getAuthReplayChainKey(accountId, invalidationGeneration);
    if (requestContext.authReplayChain) {
      return (
        requestContext.authReplayChainKey === chainKey &&
        this.authReplayChains.get(chainKey) === requestContext.authReplayChain
      );
    }
    if (this.invalidationGeneration !== invalidationGeneration) return false;

    let chain = this.authReplayChains.get(chainKey);
    if (!chain) {
      chain = { activeCallers: 0, authReplaysRemaining: 1 };
      this.authReplayChains.set(chainKey, chain);
    }
    chain.activeCallers += 1;
    requestContext.authReplayChain = chain;
    requestContext.authReplayChainKey = chainKey;
    return true;
  }

  private async canAuthReplay(
    requestContext: CodexModelDiscoveryRequestContext,
    accountId: string,
    generation: string,
    invalidationGeneration: number,
  ): Promise<boolean> {
    if (!this.isAuthReplayChainCurrent(requestContext, accountId, invalidationGeneration)) {
      return false;
    }
    const currentGeneration = await this.credentialGeneration().catch(() => null);
    return (
      currentGeneration === generation &&
      this.isAuthReplayChainCurrent(requestContext, accountId, invalidationGeneration)
    );
  }

  private isAuthReplayChainCurrent(
    requestContext: CodexModelDiscoveryRequestContext,
    accountId: string,
    invalidationGeneration: number,
  ): boolean {
    const chain = requestContext.authReplayChain;
    const chainKey = this.getAuthReplayChainKey(accountId, invalidationGeneration);
    return Boolean(
      chain &&
      chain.authReplaysRemaining > 0 &&
      this.invalidationGeneration === invalidationGeneration &&
      requestContext.authReplayChainKey === chainKey &&
      this.authReplayChains.get(chainKey) === chain,
    );
  }

  private getAuthReplayChainKey(accountId: string, invalidationGeneration: number): string {
    return `${invalidationGeneration}:${this.getAccountScope(accountId)}`;
  }

  private getAccountScope(accountId: string): string {
    return createHash('sha256')
      .update('openmaic-codex-models-v1\0')
      .update(accountId)
      .digest('hex');
  }

  private releaseAuthReplayChain(requestContext: CodexModelDiscoveryRequestContext): void {
    const chain = requestContext.authReplayChain;
    const chainKey = requestContext.authReplayChainKey;
    if (!chain || !chainKey) return;

    chain.activeCallers = Math.max(0, chain.activeCallers - 1);
    if (chain.activeCallers === 0 && this.authReplayChains.get(chainKey) === chain) {
      this.authReplayChains.delete(chainKey);
    }
    delete requestContext.authReplayChain;
    delete requestContext.authReplayChainKey;
  }

  private async retryAfterSameAccountRotation(
    models: ModelInfo[],
    options: {
      requestContext: CodexModelDiscoveryRequestContext;
      allowRetry: boolean;
      accountId: string;
      generation: string;
      invalidationGeneration: number;
    },
  ): Promise<ModelInfo[]> {
    if (
      models.length > 0 ||
      !options.allowRetry ||
      this.invalidationGeneration !== options.invalidationGeneration
    ) {
      return models;
    }

    const nextGeneration = await this.credentialGeneration().catch(() => null);
    if (!nextGeneration || nextGeneration === options.generation) return models;

    let currentCredentials: { accessToken: string; accountId: string };
    try {
      currentCredentials = await this.tokenProvider.getValidCredentials();
    } catch {
      return [];
    }
    if (
      currentCredentials.accountId !== options.accountId ||
      this.invalidationGeneration !== options.invalidationGeneration
    ) {
      return [];
    }

    // A 401-triggered refresh rotates the credential generation after this
    // request chose its cache key. Discard that response, then discover once
    // under the new generation. The account check and one-shot retry prevent
    // an old request from publishing a different login's models or looping.
    return this.getModelsForCurrentCredentials(options.requestContext, false, options.accountId);
  }

  private async refresh(
    accountId: string,
    accountScope: string,
    generation: string,
    now: number,
    invalidationGeneration: number,
    authOptions: CodexModelsRequestAuthOptions,
  ): Promise<ModelInfo[]> {
    const safeStale = this.cache?.accountScope === accountScope ? this.cache : null;
    try {
      const requestResult = await this.requestModels(
        CODEX_MODELS_ENDPOINT,
        {
          method: 'GET',
          ...(safeStale?.etag ? { headers: { 'if-none-match': safeStale.etag } } : {}),
        },
        authOptions,
      );
      const { response, credentialLease } = requestResult;
      if (
        credentialLease.credentials.accountId !== accountId ||
        !(await isCodexCredentialLeaseCurrent(credentialLease))
      ) {
        return [];
      }
      if (response.status === 304) {
        if (!safeStale) {
          throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_RESPONSE);
        }
        if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
        const revalidatedModels = safeStale.models;
        this.cache = { ...safeStale, generation, fetchedAt: now };
        await this.persistCatalog(
          accountId,
          revalidatedModels,
          now,
          generation,
          invalidationGeneration,
        );
        if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
        return revalidatedModels;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_RESPONSE);
      }
      const models = parseCodexModels(payload);
      if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
      const etag = response.headers.get('etag') || undefined;
      this.cache = {
        accountScope,
        generation,
        models,
        ...(etag ? { etag } : {}),
        fetchedAt: now,
      };
      await this.persistCatalog(accountId, models, now, generation, invalidationGeneration);
      if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
      return models;
    } catch (error) {
      if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
      if (!allowsLiveCatalogFallback(error)) return [];
      if (safeStale) return safeStale.models;
      const lkg = await this.catalogStore?.load(accountId, now).catch(() => null);
      if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
      if (lkg) {
        this.cache = {
          accountScope,
          generation,
          models: lkg.models,
          fetchedAt: lkg.validatedAt,
        };
        return this.cache.models;
      }
      return getCodexFallbackModels();
    }
  }

  private async persistCatalog(
    accountId: string,
    models: ModelInfo[],
    validatedAt: number,
    generation: string,
    invalidationGeneration: number,
  ): Promise<void> {
    try {
      // Never acquire the credential-vault mutex from inside the store's
      // mutation queue: replacement holds vault -> clear waits store. Validate
      // the credential generation before entering the store, then use the
      // synchronously invalidated catalog lifecycle as the atomic commit guard.
      if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return;
      await this.catalogStore?.save(accountId, models, validatedAt, {
        shouldCommit: () => this.invalidationGeneration === invalidationGeneration,
      });
    } catch {
      // A durable LKG is optional. Live safe models remain usable when local
      // cache storage is unavailable or becomes unsafe.
    }
  }

  private async isCurrentGeneration(
    generation: string,
    invalidationGeneration: number,
  ): Promise<boolean> {
    if (this.invalidationGeneration !== invalidationGeneration) return false;
    return (await this.credentialGeneration()) === generation;
  }
}

/**
 * Return an opaque cache generation for the current credential file. The hash
 * changes for login and refresh rotation without retaining credential values.
 */
export async function getCodexCredentialGeneration(
  vault: CodexCredentialVault,
): Promise<string | null> {
  const credentials = await withCodexCredentialVaultMutation(vault, () => vault.load());
  if (!credentials) return null;
  return createHash('sha256')
    .update(credentials.accountId)
    .update('\0')
    .update(credentials.accessToken)
    .update('\0')
    .update(credentials.refreshToken)
    .update('\0')
    .update(String(credentials.updatedAt))
    .digest('hex');
}
