import packageMetadata from '../../../package.json';
import { createHash } from 'node:crypto';

import type { ModelInfo } from '@/lib/types/provider';

import type { CodexTokenProvider } from './token-provider';
import { withCodexCredentialVaultMutation, type CodexCredentialVault } from './vault';

export const CODEX_MODELS_ENDPOINT = `https://chatgpt.com/backend-api/codex/models?client_version=${packageMetadata.version}`;
export const CODEX_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

export const CODEX_FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', source: 'probed' },
  { id: 'gpt-5.4', name: 'GPT-5.4', source: 'probed' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', source: 'probed' },
];

export const CODEX_MODELS_ERROR_CODES = {
  INVALID_ENDPOINT: 'INVALID_ENDPOINT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const;

export type CodexModelsErrorCode =
  (typeof CODEX_MODELS_ERROR_CODES)[keyof typeof CODEX_MODELS_ERROR_CODES];

const SAFE_ERROR_MESSAGES: Record<CodexModelsErrorCode, string> = {
  INVALID_ENDPOINT: 'Codex model service rejected an unsupported endpoint',
  INVALID_REQUEST: 'Codex model service rejected an invalid request',
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

interface CodexModelsClock {
  now(): number;
}

interface CodexModelDiscoveryOptions extends CreateCodexModelsTransportOptions {
  /** A non-secret identity that changes on login, refresh rotation, and logout. */
  credentialGeneration(): Promise<string | null>;
  clock?: CodexModelsClock;
  cacheTtlMs?: number;
}

interface CodexModelCacheEntry {
  generation: string;
  models: ModelInfo[];
  etag?: string;
  fetchedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numericPriority(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** Convert the upstream envelope to the only model fields safe for client sync. */
export function parseCodexModels(payload: unknown): ModelInfo[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_RESPONSE);
  }

  const records = payload.models
    .map((value, sourceIndex) => ({ value, sourceIndex }))
    .filter(
      (entry): entry is { value: Record<string, unknown>; sourceIndex: number } =>
        isRecord(entry.value) &&
        nonEmptyString(entry.value.slug) !== undefined &&
        entry.value.supported_in_api !== false &&
        entry.value.visibility === 'list',
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
    const id = nonEmptyString(value.slug);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = nonEmptyString(value.display_name) ?? nonEmptyString(value.name) ?? id;
    models.push({ id, name, source: 'probed' });
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

/** The only authenticated network boundary for Codex model discovery. */
export function createCodexModelsTransport(
  options: CreateCodexModelsTransportOptions,
): typeof globalThis.fetch {
  const upstreamFetch = options.upstreamFetch ?? globalThis.fetch.bind(globalThis);

  return async (input, init) => {
    if (typeof input !== 'string' || input !== CODEX_MODELS_ENDPOINT) {
      throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_ENDPOINT);
    }
    if (init?.method && init.method.toUpperCase() !== 'GET') {
      throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_REQUEST);
    }

    const credentials = await options.tokenProvider.getValidCredentials();
    let response: Response;
    try {
      response = await upstreamFetch(CODEX_MODELS_ENDPOINT, {
        method: 'GET',
        headers: createHeaders(init?.headers, credentials),
        redirect: 'manual',
      });
    } catch {
      throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.NETWORK_ERROR);
    }

    if (response.status === 304 || response.ok) return response;
    await cancelResponseBody(response);
    throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.UPSTREAM_ERROR, response.status);
  };
}

function cloneModels(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    ...model,
    ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
  }));
}

export class CodexModelDiscovery {
  private readonly transport: typeof globalThis.fetch;
  private readonly tokenProvider: CodexTokenProvider;
  private readonly credentialGeneration: () => Promise<string | null>;
  private readonly clock: CodexModelsClock;
  private readonly cacheTtlMs: number;
  private cache: CodexModelCacheEntry | null = null;
  private readonly inFlight = new Map<string, Promise<ModelInfo[]>>();
  private invalidationGeneration = 0;

  constructor(options: CodexModelDiscoveryOptions) {
    this.transport = createCodexModelsTransport(options);
    this.tokenProvider = options.tokenProvider;
    this.credentialGeneration = options.credentialGeneration;
    this.clock = options.clock ?? { now: Date.now };
    this.cacheTtlMs = options.cacheTtlMs ?? CODEX_MODELS_CACHE_TTL_MS;
  }

  invalidate(): void {
    this.cache = null;
    this.invalidationGeneration += 1;
  }

  async getModels(): Promise<ModelInfo[]> {
    // Settle refresh rotation before deriving the cache generation. Otherwise
    // this very request could refresh the token inside the transport and make
    // its own valid response look stale.
    try {
      await this.tokenProvider.getValidCredentials();
    } catch {
      const preservedGeneration = await this.credentialGeneration().catch(() => null);
      if (!preservedGeneration) {
        this.invalidate();
        return [];
      }
      return cloneModels(
        this.cache?.generation === preservedGeneration ? this.cache.models : CODEX_FALLBACK_MODELS,
      );
    }
    const generation = await this.credentialGeneration();
    if (!generation) {
      this.invalidate();
      return [];
    }

    const now = this.clock.now();
    if (this.cache?.generation === generation && now - this.cache.fetchedAt < this.cacheTtlMs) {
      return cloneModels(this.cache.models);
    }

    const invalidationGeneration = this.invalidationGeneration;
    const flightKey = `${invalidationGeneration}:${generation}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) return cloneModels(await existing);

    const operation = this.refresh(generation, now, invalidationGeneration);
    this.inFlight.set(flightKey, operation);
    try {
      return cloneModels(await operation);
    } finally {
      if (this.inFlight.get(flightKey) === operation) this.inFlight.delete(flightKey);
    }
  }

  private async refresh(
    generation: string,
    now: number,
    invalidationGeneration: number,
  ): Promise<ModelInfo[]> {
    const safeStale = this.cache?.generation === generation ? this.cache : null;
    try {
      const response = await this.transport(CODEX_MODELS_ENDPOINT, {
        method: 'GET',
        ...(safeStale?.etag ? { headers: { 'if-none-match': safeStale.etag } } : {}),
      });
      if (response.status === 304) {
        if (!safeStale) {
          throw new CodexModelsError(CODEX_MODELS_ERROR_CODES.INVALID_RESPONSE);
        }
        if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
        this.cache = { ...safeStale, fetchedAt: now };
        return this.cache.models;
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
      this.cache = { generation, models, ...(etag ? { etag } : {}), fetchedAt: now };
      return models;
    } catch {
      if (!(await this.isCurrentGeneration(generation, invalidationGeneration))) return [];
      if (safeStale) return safeStale.models;
      return CODEX_FALLBACK_MODELS;
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
