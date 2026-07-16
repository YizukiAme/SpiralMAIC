import {
  normalizePublicBaseUrl,
  type SafeErrorCategory,
  type SafeReport,
} from './codex-acceptance-lib';

export interface OfflineRefreshOptions {
  baseUrl: string;
  confirmedAppStopped: boolean;
}

export type ApplicationState = 'active' | 'stopped' | 'unknown';
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RuntimeLoader = () => Promise<{
  getCodexAuthRuntime(): {
    tokenProvider: {
      getValidCredentials(options: { forceRefresh: true }): Promise<unknown>;
    };
  };
}>;

interface OfflineRefreshDependencies {
  probe?: (baseUrl: string) => Promise<ApplicationState>;
  refresh?: () => Promise<void>;
}

function argumentError(): never {
  throw new Error('argument');
}

export function parseOfflineRefreshArgs(argv: readonly string[]): OfflineRefreshOptions {
  let baseUrl: string | undefined;
  let confirmedAppStopped = false;
  const startIndex = argv[0] === '--' ? 1 : 0;
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base-url') {
      if (baseUrl !== undefined || index + 1 >= argv.length) argumentError();
      try {
        baseUrl = normalizePublicBaseUrl(argv[++index]);
      } catch {
        argumentError();
      }
      const hostname = new URL(baseUrl).hostname;
      if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
        argumentError();
      }
    } else if (argument === '--confirm-app-stopped') {
      if (confirmedAppStopped) argumentError();
      confirmedAppStopped = true;
    } else {
      argumentError();
    }
  }
  if (!baseUrl) argumentError();
  return { baseUrl, confirmedAppStopped };
}

function nestedErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return undefined;
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return undefined;
}

export async function probeApplicationState(
  baseUrl: string,
  fetcher: Fetcher = fetch,
): Promise<ApplicationState> {
  try {
    await fetcher(`${baseUrl}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    return 'active';
  } catch (error) {
    return nestedErrorCode(error) === 'ECONNREFUSED' ? 'stopped' : 'unknown';
  }
}

export async function forceRefreshProductionCodexCredentials(
  loadRuntime: RuntimeLoader = () => import('../lib/server/codex/runtime'),
): Promise<void> {
  const { getCodexAuthRuntime } = await loadRuntime();
  await getCodexAuthRuntime().tokenProvider.getValidCredentials({ forceRefresh: true });
}

function refreshErrorCategory(error: unknown): SafeErrorCategory {
  const code = nestedErrorCode(error);
  if (
    code === 'CREDENTIALS_MISSING' ||
    code === 'SIGNED_OUT' ||
    code === 'INVALID_GRANT' ||
    code === 'REFRESH_REJECTED'
  ) {
    return 'auth';
  }
  if (code === 'NETWORK_ERROR') return 'network';
  if (code === 'UPSTREAM_ERROR') return 'upstream';
  if (code === 'INVALID_RESPONSE') return 'invalid-json';
  if (code === 'STORAGE_ERROR') return 'storage';
  return 'unexpected';
}

export async function runOfflineCodexRefresh(
  options: OfflineRefreshOptions,
  dependencies: OfflineRefreshDependencies = {},
): Promise<SafeReport> {
  if (!options.confirmedAppStopped) {
    return {
      outcome: 'FAIL',
      stage: 'offline-force-refresh',
      errorCategory: 'confirmation-required',
    };
  }

  const probe = dependencies.probe ?? probeApplicationState;
  const state = await probe(options.baseUrl).catch(() => 'unknown' as const);
  if (state !== 'stopped') {
    return {
      outcome: 'FAIL',
      stage: 'offline-force-refresh',
      applicationStopped: false,
      errorCategory: state === 'active' ? 'application-active' : 'application-state-unknown',
    };
  }

  try {
    await (dependencies.refresh ?? forceRefreshProductionCodexCredentials)();
    return {
      outcome: 'PASS',
      stage: 'offline-force-refresh',
      applicationStopped: true,
      refreshed: true,
    };
  } catch (error) {
    return {
      outcome: 'FAIL',
      stage: 'offline-force-refresh',
      applicationStopped: true,
      errorCategory: refreshErrorCategory(error),
    };
  }
}
