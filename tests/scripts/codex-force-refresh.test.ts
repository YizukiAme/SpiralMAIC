import { describe, expect, it, vi } from 'vitest';

import {
  forceRefreshProductionCodexCredentials,
  parseOfflineRefreshArgs,
  probeApplicationState,
  runOfflineCodexRefresh,
} from '@/scripts/codex-force-refresh-lib';
import { formatSafeReport } from '@/scripts/codex-acceptance-lib';

describe('offline Codex force-refresh arguments', () => {
  it('requires an explicit stopped-app confirmation and one HTTP(S) origin', () => {
    expect(
      parseOfflineRefreshArgs(['--base-url', 'http://localhost:3000/', '--confirm-app-stopped']),
    ).toEqual({ baseUrl: 'http://localhost:3000', confirmedAppStopped: true });
    expect(
      parseOfflineRefreshArgs([
        '--',
        '--base-url',
        'http://localhost:3000',
        '--confirm-app-stopped',
      ]),
    ).toEqual({ baseUrl: 'http://localhost:3000', confirmedAppStopped: true });

    expect(parseOfflineRefreshArgs(['--base-url', 'http://localhost:3000'])).toEqual({
      baseUrl: 'http://localhost:3000',
      confirmedAppStopped: false,
    });
    expect(() => parseOfflineRefreshArgs([])).toThrowError('argument');
    expect(() =>
      parseOfflineRefreshArgs([
        '--base-url',
        'https://remote.example.test',
        '--confirm-app-stopped',
      ]),
    ).toThrowError('argument');
    expect(() =>
      parseOfflineRefreshArgs([
        '--base-url',
        'http://localhost:3000',
        '--confirm-app-stopped',
        '--confirm-app-stopped',
      ]),
    ).toThrowError('argument');
  });
});

describe('offline Codex force-refresh safety', () => {
  it('refuses without confirmation before probing or importing the production runtime', async () => {
    const probe = vi.fn();
    const refresh = vi.fn();
    const acquireLock = vi.fn();

    await expect(
      runOfflineCodexRefresh(
        { baseUrl: 'http://localhost:3000', confirmedAppStopped: false },
        { probe, refresh, acquireLock },
      ),
    ).resolves.toEqual({
      outcome: 'FAIL',
      stage: 'offline-force-refresh',
      errorCategory: 'confirmation-required',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['active', 'application-active'],
    ['unknown', 'application-state-unknown'],
  ] as const)('refuses when the application probe is %s', async (state, errorCategory) => {
    const refresh = vi.fn();
    const report = await runOfflineCodexRefresh(
      { baseUrl: 'http://localhost:3000', confirmedAppStopped: true },
      { probe: vi.fn(async () => state), refresh },
    );

    expect(report).toEqual({
      outcome: 'FAIL',
      stage: 'offline-force-refresh',
      applicationStopped: false,
      errorCategory,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('force-refreshes only after a confirmed stopped probe', async () => {
    const order: string[] = [];
    const release = vi.fn(() => order.push('release'));
    const refresh = vi.fn(async () => undefined);
    const report = await runOfflineCodexRefresh(
      { baseUrl: 'http://localhost:3000', confirmedAppStopped: true },
      {
        probe: vi.fn(async () => 'stopped' as const),
        acquireLock: vi.fn(() => {
          order.push('lock');
          return { release };
        }),
        refresh: vi.fn(async () => {
          order.push('refresh');
          await refresh();
        }),
      },
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['lock', 'refresh', 'release']);
    expect(report).toEqual({
      outcome: 'PASS',
      stage: 'offline-force-refresh',
      applicationStopped: true,
      refreshed: true,
    });
  });

  it('fails safely when another live process owns the runtime lock', async () => {
    const refresh = vi.fn();
    const report = await runOfflineCodexRefresh(
      { baseUrl: 'http://localhost:3000', confirmedAppStopped: true },
      {
        probe: vi.fn(async () => 'stopped' as const),
        acquireLock: vi.fn(() => {
          throw Object.assign(new Error('private owner details'), {
            code: 'CODEX_RUNTIME_LOCKED',
          });
        }),
        refresh,
      },
    );

    expect(report).toEqual({
      outcome: 'FAIL',
      stage: 'offline-force-refresh',
      applicationStopped: false,
      errorCategory: 'application-active',
    });
    expect(formatSafeReport(report)).not.toContain('private owner details');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('releases the helper lease when refresh fails', async () => {
    const release = vi.fn();
    await runOfflineCodexRefresh(
      { baseUrl: 'http://localhost:3000', confirmedAppStopped: true },
      {
        probe: vi.fn(async () => 'stopped' as const),
        acquireLock: vi.fn(() => ({ release })),
        refresh: vi.fn(async () => {
          throw new Error('refresh failed');
        }),
      },
    );

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never emits credentials or raw refresh failures', async () => {
    const release = vi.fn();
    const report = await runOfflineCodexRefresh(
      { baseUrl: 'http://localhost:3000', confirmedAppStopped: true },
      {
        probe: vi.fn(async () => 'stopped' as const),
        acquireLock: vi.fn(() => ({ release })),
        refresh: vi.fn(async () => {
          throw Object.assign(new Error('token-secret refresh-token-secret account-secret'), {
            code: 'UPSTREAM_ERROR',
            response: { body: 'raw-provider-secret' },
          });
        }),
      },
    );
    const output = formatSafeReport(report);

    expect(report).toMatchObject({ outcome: 'FAIL', errorCategory: 'upstream' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(output).not.toMatch(/token-secret|refresh-token|account-secret|raw-provider-secret/);
  });

  it('classifies only connection refusal as stopped and fails closed otherwise', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    await expect(
      probeApplicationState(
        'http://localhost:3000',
        vi.fn(async () => Promise.reject(refused)),
      ),
    ).resolves.toBe('stopped');
    await expect(
      probeApplicationState(
        'http://localhost:3000',
        vi.fn(async () => Promise.reject(new Error('timeout with private URL'))),
      ),
    ).resolves.toBe('unknown');
    await expect(
      probeApplicationState(
        'http://localhost:3000',
        vi.fn(async () => new Response(null, { status: 503 })),
      ),
    ).resolves.toBe('active');
  });

  it('reuses the production token provider with forceRefresh true without returning credentials', async () => {
    const getValidCredentials = vi.fn(async () => ({
      accessToken: 'access-token-secret',
      accountId: 'account-secret',
    }));
    const result = await forceRefreshProductionCodexCredentials(async () => ({
      getCodexAuthRuntime: () => ({ tokenProvider: { getValidCredentials } }),
    }));

    expect(getValidCredentials).toHaveBeenCalledWith({ forceRefresh: true });
    expect(result).toBeUndefined();
  });
});
