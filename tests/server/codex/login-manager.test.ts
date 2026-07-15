import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_OAUTH_DEVICE_REDIRECT_URI,
  CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT,
  CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT,
  CODEX_OAUTH_BROWSER_REDIRECT_URI,
} from '@/lib/server/codex/oauth';
import { CodexLoginManager } from '@/lib/server/codex/login-manager';
import type { CodexLoginAttempt } from '@/lib/types/codex-auth';
import {
  CODEX_OAUTH_TOKEN_ENDPOINT,
  ManagedCodexTokenProvider,
} from '@/lib/server/codex/token-provider';
import type { CodexCredentialVault, CodexOAuthCredentials } from '@/lib/server/codex/vault';

const NOW = 1_700_000_000_000;

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.login-output`;
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryVault implements CodexCredentialVault {
  current: CodexOAuthCredentials | null = null;
  readonly saved: CodexOAuthCredentials[] = [];

  async load(): Promise<CodexOAuthCredentials | null> {
    return this.current;
  }

  async save(credentials: CodexOAuthCredentials): Promise<void> {
    this.saved.push(credentials);
    this.current = credentials;
  }

  async clear(): Promise<void> {
    this.current = null;
  }
}

class FailingSaveVault extends MemoryVault {
  override async save(): Promise<void> {
    throw new Error('private storage detail');
  }
}

class DeferredSaveVault extends MemoryVault {
  readonly saveStarted = deferred<void>();
  readonly releaseFirstSave = deferred<void>();
  clearCount = 0;
  private saveCount = 0;

  override async save(credentials: CodexOAuthCredentials): Promise<void> {
    this.saved.push(credentials);
    this.saveCount += 1;
    if (this.saveCount === 1) {
      this.saveStarted.resolve();
      await this.releaseFirstSave.promise;
    }
    this.current = credentials;
  }

  override async clear(): Promise<void> {
    this.clearCount += 1;
    await super.clear();
  }
}

class ManualScheduler {
  private readonly callbacks = new Set<() => void>();

  setTimeout(callback: () => void): object {
    this.callbacks.add(callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as () => void);
  }

  async runAll(): Promise<void> {
    const callbacks = [...this.callbacks];
    this.callbacks.clear();
    await Promise.all(callbacks.map(async (callback) => callback()));
  }
}

const managers: CodexLoginManager[] = [];
const extraServers: Server[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.cancel()));
  await Promise.all(
    extraServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('CodexLoginManager browser flow', () => {
  it('completes a real loopback callback and persists only vault-safe credentials', async () => {
    const vault = new MemoryVault();
    const idToken = unsignedJwt({
      chatgpt_account_id: 'browser-account',
      email: 'browser@example.com',
    });
    const accessToken = unsignedJwt({ chatgpt_account_id: 'access-account' });
    const tokenRequests: Array<{ input: string; init: RequestInit }> = [];
    const randomValues = [Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22)];
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => NOW },
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async (input, init) => {
        tokenRequests.push({ input, init });
        return jsonResponse({
          access_token: accessToken,
          refresh_token: 'browser-refresh',
          expires_in: 3600,
          id_token: idToken,
        });
      },
    });
    managers.push(manager);

    const started: CodexLoginAttempt = await manager.begin('browser');
    expect(started).toEqual({
      method: 'browser',
      status: 'pending',
      authorizationUrl: expect.stringContaining('https://auth.openai.com/oauth/authorize?'),
      expiresAt: NOW + 5 * 60_000,
    });
    expect(Object.keys(started)).not.toEqual(
      expect.arrayContaining(['verifier', 'state', 'accountId', 'accessToken', 'refreshToken']),
    );

    const authorizationUrl = new URL(started.authorizationUrl!);
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'browser-code');
    callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
    const callbackResponse = await fetch(callbackUrl);

    expect(callbackResponse.status).toBe(200);
    await expect(callbackResponse.text()).resolves.toContain('complete');
    await expect(manager.poll()).resolves.toEqual({
      method: 'browser',
      status: 'complete',
    });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].input).toBe(CODEX_OAUTH_TOKEN_ENDPOINT);
    expect(vault.current).toEqual({
      version: 1,
      accessToken,
      refreshToken: 'browser-refresh',
      expiresAt: NOW + 3_600_000,
      accountId: 'browser-account',
      email: 'browser@example.com',
      updatedAt: NOW,
    });
    expect(JSON.stringify(vault.current)).not.toContain(idToken);
  });

  it('rejects a mismatched callback state without exchanging the code', async () => {
    const vault = new MemoryVault();
    let tokenRequestCount = 0;
    const randomValues = [Buffer.alloc(32, 0x31), Buffer.alloc(32, 0x32)];
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => NOW },
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        tokenRequestCount += 1;
        return jsonResponse({});
      },
    });
    managers.push(manager);

    await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'must-not-be-exchanged');
    callbackUrl.searchParams.set('state', 'attacker-state');
    const callbackResponse = await fetch(callbackUrl);

    expect(callbackResponse.status).toBe(400);
    expect(tokenRequestCount).toBe(0);
    expect(vault.current).toBeNull();
    await expect(manager.poll()).resolves.toEqual({
      method: 'browser',
      status: 'failed',
      errorCode: 'STATE_MISMATCH',
    });
  });

  it('accepts callbacks only on the exact configured path', async () => {
    const vault = new MemoryVault();
    let tokenRequestCount = 0;
    const randomValues = [Buffer.alloc(32, 0x41), Buffer.alloc(32, 0x42)];
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => NOW },
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        tokenRequestCount += 1;
        return jsonResponse({});
      },
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const wrongPath = new URL('http://127.0.0.1:1455/not-the-callback');
    wrongPath.searchParams.set('code', 'must-not-be-exchanged');
    wrongPath.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const response = await fetch(wrongPath);

    expect(response.status).toBe(404);
    expect(tokenRequestCount).toBe(0);
    await expect(manager.poll()).resolves.toMatchObject({
      method: 'browser',
      status: 'pending',
    });
  });

  it('expires after five minutes and releases the callback port', async () => {
    let now = NOW;
    const scheduler = new ManualScheduler();
    const randomValues = [Buffer.alloc(32, 0x51), Buffer.alloc(32, 0x52)];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      scheduler,
      randomBytes: () => randomValues.shift()!,
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    now = started.expiresAt!;
    await scheduler.runAll();

    await expect(manager.poll()).resolves.toEqual({
      method: 'browser',
      status: 'expired',
    });

    const probe = new CodexLoginManager({
      vault: new MemoryVault(),
      randomBytes: () => Buffer.alloc(32, 0x61),
    });
    managers.push(probe);
    await expect(probe.begin('browser')).resolves.toMatchObject({ status: 'pending' });
  });

  it('returns a safe device-directed failure when port 1455 is occupied', async () => {
    const blocker = createServer();
    extraServers.push(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(1455, '127.0.0.1', () => resolve());
    });
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      randomBytes: () => Buffer.alloc(32, 0x71),
    });
    managers.push(manager);

    await expect(manager.begin('browser')).resolves.toEqual({
      method: 'browser',
      status: 'failed',
      errorCode: 'BROWSER_UNAVAILABLE',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
  });

  it('does not save an in-flight callback after cancellation', async () => {
    const vault = new MemoryVault();
    const exchange = deferred<Response>();
    const exchangeStarted = deferred<void>();
    const randomValues = [Buffer.alloc(32, 0x81), Buffer.alloc(32, 0x82)];
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => NOW },
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        exchangeStarted.resolve();
        return exchange.promise;
      },
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'late-code');
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const callback = fetch(callbackUrl).catch(() => null);
    await exchangeStarted.promise;
    const cancelled = manager.cancel();
    exchange.resolve(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'late-account' }),
        refresh_token: 'late-refresh',
        expires_in: 3600,
      }),
    );

    await cancelled;
    await callback;
    expect(vault.saved).toEqual([]);
    await expect(manager.poll()).resolves.toBeNull();
  });

  it('waits for an in-flight browser save and restores the previous credentials on cancel', async () => {
    const previous = {
      version: 1,
      accessToken: 'previous-browser-access',
      refreshToken: 'previous-browser-refresh',
      expiresAt: NOW + 600_000,
      accountId: 'previous-browser-account',
      updatedAt: NOW,
    } satisfies CodexOAuthCredentials;
    const vault = new DeferredSaveVault();
    vault.current = previous;
    const randomValues = [Buffer.alloc(32, 0x83), Buffer.alloc(32, 0x84)];
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => NOW },
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () =>
        jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'cancelled-browser-account' }),
          refresh_token: 'cancelled-browser-refresh',
          expires_in: 300,
        }),
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'cancel-during-save');
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const callback = fetch(callbackUrl).catch(() => null);
    await vault.saveStarted.promise;

    const cancelled = manager.cancel();
    vault.releaseFirstSave.resolve();
    await cancelled;
    await callback;

    expect(vault.current).toEqual(previous);
    await expect(manager.poll()).resolves.toBeNull();
  });

  it('does not roll a concurrent token refresh back to the pre-login snapshot', async () => {
    const previous = {
      version: 1,
      accessToken: unsignedJwt({ chatgpt_account_id: 'shared-account' }),
      refreshToken: 'shared-previous-refresh',
      expiresAt: NOW + 600_000,
      accountId: 'shared-account',
      updatedAt: NOW,
    } satisfies CodexOAuthCredentials;
    const vault = new DeferredSaveVault();
    vault.current = previous;
    const randomValues = [Buffer.alloc(32, 0x85), Buffer.alloc(32, 0x86)];
    const loginManager = new CodexLoginManager({
      vault,
      clock: { now: () => NOW },
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () =>
        jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'cancelled-login-account' }),
          refresh_token: 'cancelled-login-refresh',
          expires_in: 300,
        }),
    });
    managers.push(loginManager);
    const refreshStarted = deferred<void>();
    const rotatedAccess = unsignedJwt({ chatgpt_account_id: 'shared-account' });
    const tokenProvider = new ManagedCodexTokenProvider({
      vault,
      clock: { now: () => NOW },
      tokenExchangeFetch: async () => {
        refreshStarted.resolve();
        return jsonResponse({
          access_token: rotatedAccess,
          refresh_token: 'shared-rotated-refresh',
          expires_in: 900,
        });
      },
    });

    const started = await loginManager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'cancelled-shared-write');
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const callback = fetch(callbackUrl).catch(() => null);
    await vault.saveStarted.promise;

    const cancelled = loginManager.cancel();
    const refresh = tokenProvider.getValidCredentials({ forceRefresh: true });
    await Promise.race([
      refreshStarted.promise,
      new Promise<void>((resolve) => setTimeout(resolve, 20)),
    ]);
    vault.releaseFirstSave.resolve();
    await Promise.all([cancelled, refresh, callback]);

    expect(vault.current).toMatchObject({
      accessToken: rotatedAccess,
      refreshToken: 'shared-rotated-refresh',
      accountId: 'shared-account',
    });
  });

  it('replaces an in-flight browser attempt before its exchange resolves', async () => {
    const vault = new MemoryVault();
    const firstExchange = deferred<Response>();
    const firstExchangeStarted = deferred<void>();
    const randomValues = [
      Buffer.alloc(32, 0x91),
      Buffer.alloc(32, 0x92),
      Buffer.alloc(32, 0x93),
      Buffer.alloc(32, 0x94),
    ];
    let requestCount = 0;
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => NOW },
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        requestCount += 1;
        firstExchangeStarted.resolve();
        return firstExchange.promise;
      },
    });
    managers.push(manager);

    const first = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'old-code');
    callbackUrl.searchParams.set(
      'state',
      new URL(first.authorizationUrl!).searchParams.get('state')!,
    );
    const oldCallback = fetch(callbackUrl).catch(() => null);
    await firstExchangeStarted.promise;

    const secondBegin = manager.begin('browser');
    const replacementStartedPromptly = await Promise.race([
      secondBegin.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    firstExchange.resolve(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'old-account' }),
        refresh_token: 'old-refresh',
        expires_in: 3600,
      }),
    );
    const second = await secondBegin;
    await oldCallback;

    expect(replacementStartedPromptly).toBe(true);
    expect(second).toMatchObject({ method: 'browser', status: 'pending' });
    expect(requestCount).toBe(1);
    expect(vault.saved).toEqual([]);
  });

  it('fails a state-valid callback that omits the authorization code', async () => {
    let tokenRequestCount = 0;
    const randomValues = [Buffer.alloc(32, 0xa1), Buffer.alloc(32, 0xa2)];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        tokenRequestCount += 1;
        return jsonResponse({});
      },
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const response = await fetch(callbackUrl);

    expect(response.status).toBe(400);
    expect(tokenRequestCount).toBe(0);
    await expect(manager.poll()).resolves.toEqual({
      method: 'browser',
      status: 'failed',
      errorCode: 'INVALID_CALLBACK',
    });
  });

  it('sanitizes an OAuth callback rejection without exchanging or echoing it', async () => {
    let tokenRequestCount = 0;
    const randomValues = [Buffer.alloc(32, 0xb1), Buffer.alloc(32, 0xb2)];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        tokenRequestCount += 1;
        return jsonResponse({});
      },
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    callbackUrl.searchParams.set('error', 'access_denied');
    callbackUrl.searchParams.set('error_description', 'secret-upstream-detail');
    const response = await fetch(callbackUrl);
    const responseText = await response.text();
    const status = await manager.poll();

    expect(response.status).toBe(400);
    expect(tokenRequestCount).toBe(0);
    expect(status).toEqual({
      method: 'browser',
      status: 'failed',
      errorCode: 'AUTHORIZATION_REJECTED',
    });
    expect(`${responseText}${JSON.stringify(status)}`).not.toContain('secret-upstream-detail');
    expect(JSON.stringify(status)).not.toContain('access_denied');
  });

  it('maps token endpoint network failures to a stable public error', async () => {
    const randomValues = [Buffer.alloc(32, 0xc1), Buffer.alloc(32, 0xc2)];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        throw new Error('secret socket detail');
      },
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'network-code');
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const response = await fetch(callbackUrl);
    const responseText = await response.text();
    const status = await manager.poll();

    expect(status).toEqual({
      method: 'browser',
      status: 'failed',
      errorCode: 'NETWORK_ERROR',
    });
    expect(`${responseText}${JSON.stringify(status)}`).not.toContain('secret socket detail');
  });

  it('maps a rejected token exchange to upstream error without exposing its body', async () => {
    const randomValues = [Buffer.alloc(32, 0xd1), Buffer.alloc(32, 0xd2)];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => jsonResponse({ secret: 'raw-upstream-secret' }, 503),
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'rejected-code');
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const response = await fetch(callbackUrl);
    const responseText = await response.text();
    const status = await manager.poll();

    expect(status).toEqual({
      method: 'browser',
      status: 'failed',
      errorCode: 'UPSTREAM_ERROR',
    });
    expect(`${responseText}${JSON.stringify(status)}`).not.toContain('raw-upstream-secret');
  });

  it('maps browser credential persistence failure to storage error', async () => {
    const randomValues = [Buffer.alloc(32, 0xe1), Buffer.alloc(32, 0xe2)];
    const manager = new CodexLoginManager({
      vault: new FailingSaveVault(),
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () =>
        jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'storage-account' }),
          refresh_token: 'storage-refresh',
          expires_in: 300,
        }),
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'storage-code');
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const response = await fetch(callbackUrl);
    const responseText = await response.text();

    expect(response.status).toBe(400);
    await expect(manager.poll()).resolves.toEqual({
      method: 'browser',
      status: 'failed',
      errorCode: 'STORAGE_ERROR',
    });
    expect(responseText).not.toContain('private storage detail');
  });

  it('claims a browser callback once and ignores a duplicate while exchange is in flight', async () => {
    const vault = new MemoryVault();
    const releaseExchange = deferred<void>();
    const exchangeStarted = deferred<void>();
    let exchangeRequestCount = 0;
    const randomValues = [Buffer.alloc(32, 0xf1), Buffer.alloc(32, 0xf2)];
    const manager = new CodexLoginManager({
      vault,
      randomBytes: () => randomValues.shift()!,
      oauthFetch: async () => {
        exchangeRequestCount += 1;
        exchangeStarted.resolve();
        await releaseExchange.promise;
        return jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'single-flight-account' }),
          refresh_token: 'single-flight-refresh',
          expires_in: 300,
        });
      },
    });
    managers.push(manager);

    const started = await manager.begin('browser');
    const callbackUrl = new URL(CODEX_OAUTH_BROWSER_REDIRECT_URI);
    callbackUrl.hostname = '127.0.0.1';
    callbackUrl.searchParams.set('code', 'single-flight-code');
    callbackUrl.searchParams.set(
      'state',
      new URL(started.authorizationUrl!).searchParams.get('state')!,
    );
    const first = fetch(callbackUrl).catch(() => null);
    const second = fetch(callbackUrl).catch(() => null);
    await exchangeStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const requestsBeforeRelease = exchangeRequestCount;
    releaseExchange.resolve();
    await Promise.all([first, second]);

    expect(requestsBeforeRelease).toBe(1);
    expect(exchangeRequestCount).toBe(1);
    expect(vault.saved).toHaveLength(1);
    await expect(manager.poll()).resolves.toMatchObject({ status: 'complete' });
  });

  it('keeps the newest concurrent browser start pending instead of reporting port-in-use', async () => {
    const randomValues = [
      Buffer.alloc(32, 0x12),
      Buffer.alloc(32, 0x13),
      Buffer.alloc(32, 0x14),
      Buffer.alloc(32, 0x15),
    ];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      randomBytes: () => randomValues.shift()!,
    });
    managers.push(manager);

    const first = manager.begin('browser');
    const second = manager.begin('browser');
    const [, newest] = await Promise.all([first, second]);

    expect(newest).toMatchObject({ method: 'browser', status: 'pending' });
    await expect(manager.poll()).resolves.toMatchObject({
      method: 'browser',
      status: 'pending',
      authorizationUrl: newest.authorizationUrl,
    });
  });
});

describe('CodexLoginManager device flow', () => {
  it('starts device auth with the exact request and a sanitized capped attempt', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => NOW },
      oauthFetch: async (input, init) => {
        requests.push({ input, init });
        return jsonResponse({
          device_auth_id: 'secret-device-auth-id',
          user_code: 'ABCD-EFGH',
          interval: '7',
          expires_in: 3600,
        });
      },
    });
    managers.push(manager);

    const attempt = await manager.begin('device');

    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBe(CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT);
    expect(requests[0].init.method).toBe('POST');
    expect(requests[0].init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(requests[0].init.body as string)).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
    expect(attempt).toEqual({
      method: 'device',
      status: 'pending',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: NOW + 15 * 60_000,
      interval: 7,
    });
    expect(JSON.stringify(attempt)).not.toContain('secret-device-auth-id');
  });

  it('treats an initial usercode 404 as terminal device unavailability', async () => {
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      oauthFetch: async () => jsonResponse({ secret: 'raw-404-body' }, 404),
    });
    managers.push(manager);

    const attempt = await manager.begin('device');

    expect(attempt).toEqual({
      method: 'device',
      status: 'failed',
      errorCode: 'DEVICE_UNAVAILABLE',
    });
    expect(JSON.stringify(attempt)).not.toContain('raw-404-body');
    await expect(manager.poll()).resolves.toEqual(attempt);
  });

  it('waits for the upstream interval before one due poll and treats 403 as pending', async () => {
    let now = NOW;
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      oauthFetch: async (input, init) => {
        requests.push({ input, init });
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'private-device-id',
            user_code: 'POLL-CODE',
            interval: 7,
          });
        }
        return jsonResponse({ secret: 'pending-body' }, 403);
      },
    });
    managers.push(manager);

    const started = await manager.begin('device');
    await expect(manager.poll()).resolves.toEqual(started);
    now += 6_999;
    await expect(manager.poll()).resolves.toEqual(started);
    expect(requests).toHaveLength(1);

    now += 1;
    await expect(manager.poll()).resolves.toEqual(started);
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toBe(CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT);
    expect(requests[1].init.method).toBe('POST');
    expect(requests[1].init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(requests[1].init.body as string)).toEqual({
      device_auth_id: 'private-device-id',
      user_code: 'POLL-CODE',
    });
    expect(JSON.stringify(await manager.poll())).not.toContain('pending-body');
  });

  it('treats a poll-time 404 as pending rather than initial unavailability', async () => {
    let now = NOW;
    let requestCount = 0;
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      oauthFetch: async (input) => {
        requestCount += 1;
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'poll-404-device-id',
            user_code: 'POLL-404',
            interval: 2,
          });
        }
        return jsonResponse({ secret: 'poll-404-body' }, 404);
      },
    });
    managers.push(manager);

    const started = await manager.begin('device');
    now += 2_000;
    await expect(manager.poll()).resolves.toEqual(started);
    expect(requestCount).toBe(2);
    expect(JSON.stringify(await manager.poll())).not.toContain('poll-404-body');
  });

  it('expires at fifteen minutes without another network request', async () => {
    let now = NOW;
    let requestCount = 0;
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      oauthFetch: async (input) => {
        requestCount += 1;
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'expiring-device-id',
            user_code: 'EXPIRES-15',
            interval: 5,
          });
        }
        return jsonResponse({}, 403);
      },
    });
    managers.push(manager);

    const started = await manager.begin('device');
    now = started.expiresAt!;

    await expect(manager.poll()).resolves.toEqual({
      method: 'device',
      status: 'expired',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    expect(requestCount).toBe(1);
  });

  it('does not persist a device exchange that completes after the fifteen-minute deadline', async () => {
    let now = NOW;
    const vault = new MemoryVault();
    const exchangeResponse = deferred<Response>();
    const exchangeStarted = deferred<void>();
    const verifier = 'deadline-verifier';
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'deadline-device-id',
            user_code: 'DEADLINE',
            interval: 1,
          });
        }
        if (input === CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT) {
          return jsonResponse({
            authorization_code: 'deadline-code',
            code_verifier: verifier,
            code_challenge: pkceChallenge(verifier),
          });
        }
        exchangeStarted.resolve();
        return exchangeResponse.promise;
      },
    });
    managers.push(manager);

    const started = await manager.begin('device');
    now += 1_000;
    const polling = manager.poll();
    await exchangeStarted.promise;
    now = started.expiresAt!;
    exchangeResponse.resolve(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'deadline-account' }),
        refresh_token: 'deadline-refresh',
        expires_in: 300,
      }),
    );

    await expect(polling).resolves.toMatchObject({ status: 'expired' });
    expect(vault.current).toBeNull();
    expect(vault.saved).toEqual([]);
  });

  it('turns a device-start network failure into a sanitized terminal attempt', async () => {
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      oauthFetch: async () => {
        throw new Error('private DNS failure');
      },
    });
    managers.push(manager);

    const attempt = await manager.begin('device');

    expect(attempt).toEqual({
      method: 'device',
      status: 'failed',
      errorCode: 'NETWORK_ERROR',
    });
    expect(JSON.stringify(attempt)).not.toContain('private DNS failure');
  });

  it('turns a device-start 5xx into upstream error without parsing its body', async () => {
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      oauthFetch: async () => jsonResponse({ secret: 'private 5xx body' }, 503),
    });
    managers.push(manager);

    const attempt = await manager.begin('device');

    expect(attempt).toEqual({
      method: 'device',
      status: 'failed',
      errorCode: 'UPSTREAM_ERROR',
    });
    expect(JSON.stringify(attempt)).not.toContain('private 5xx body');
  });

  it('turns invalid device-start JSON into a terminal invalid response', async () => {
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      oauthFetch: async () => new Response('raw invalid json', { status: 200 }),
    });
    managers.push(manager);

    await expect(manager.begin('device')).resolves.toEqual({
      method: 'device',
      status: 'failed',
      errorCode: 'INVALID_RESPONSE',
    });
  });

  it('turns an invalid device-start shape into a terminal invalid response', async () => {
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      oauthFetch: async () => jsonResponse({ device_auth_id: 'missing-user-code' }),
    });
    managers.push(manager);

    await expect(manager.begin('device')).resolves.toEqual({
      method: 'device',
      status: 'failed',
      errorCode: 'INVALID_RESPONSE',
    });
  });

  it('exchanges a successful device poll and persists sanitized credentials', async () => {
    let now = NOW;
    const vault = new MemoryVault();
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const accessToken = unsignedJwt({ chatgpt_account_id: 'device-access-account' });
    const idToken = unsignedJwt({
      chatgpt_account_id: 'device-id-account',
      email: 'device@example.com',
    });
    const deviceVerifier = 'device-code-verifier';
    const deviceChallenge = pkceChallenge(deviceVerifier);
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => now },
      oauthFetch: async (input, init) => {
        requests.push({ input, init });
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'success-private-device-id',
            user_code: 'SUCCESS-CODE',
            interval: 3,
          });
        }
        if (input === CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT) {
          return jsonResponse({
            authorization_code: 'device-authorization-code',
            code_verifier: deviceVerifier,
            code_challenge: deviceChallenge,
          });
        }
        return jsonResponse({
          access_token: accessToken,
          refresh_token: 'device-refresh-token',
          expires_in: 600,
          id_token: idToken,
        });
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 3_000;
    const completed = await manager.poll();

    expect(completed).toMatchObject({ method: 'device', status: 'complete' });
    expect(requests).toHaveLength(3);
    expect(requests[2].input).toBe(CODEX_OAUTH_TOKEN_ENDPOINT);
    expect(Object.fromEntries(requests[2].init.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      code: 'device-authorization-code',
      redirect_uri: CODEX_OAUTH_DEVICE_REDIRECT_URI,
      code_verifier: deviceVerifier,
    });
    expect(vault.current).toEqual({
      version: 1,
      accessToken,
      refreshToken: 'device-refresh-token',
      expiresAt: NOW + 3_000 + 600_000,
      accountId: 'device-id-account',
      email: 'device@example.com',
      updatedAt: NOW + 3_000,
    });
    expect(JSON.stringify({ completed, credentials: vault.current })).not.toContain(idToken);
    for (const secret of [
      'success-private-device-id',
      'device-authorization-code',
      deviceVerifier,
      deviceChallenge,
    ]) {
      expect(JSON.stringify(completed)).not.toContain(secret);
    }
  });

  it('coalesces concurrent due polls into one upstream request', async () => {
    let now = NOW;
    let pollRequestCount = 0;
    const pollResponse = deferred<Response>();
    const pollStarted = deferred<void>();
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'coalesced-device-id',
            user_code: 'COALESCE',
            interval: 1,
          });
        }
        pollRequestCount += 1;
        pollStarted.resolve();
        return pollResponse.promise;
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 1_000;
    const first = manager.poll();
    await pollStarted.promise;
    const second = manager.poll();

    expect(pollRequestCount).toBe(1);
    pollResponse.resolve(jsonResponse({}, 403));
    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(firstStatus).toEqual(secondStatus);
  });

  it('keeps a slow device poll single-flight after additional intervals elapse', async () => {
    let now = NOW;
    let pollRequestCount = 0;
    const pollResponses: Array<ReturnType<typeof deferred<Response>>> = [];
    const pollStarted = deferred<void>();
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'slow-device-id',
            user_code: 'SLOW-POLL',
            interval: 1,
          });
        }
        pollRequestCount += 1;
        const response = deferred<Response>();
        pollResponses.push(response);
        pollStarted.resolve();
        return response.promise;
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 1_000;
    const first = manager.poll();
    await pollStarted.promise;
    now += 2_000;
    const second = manager.poll();
    await Promise.resolve();
    const observedRequestCount = pollRequestCount;
    for (const response of pollResponses) response.resolve(jsonResponse({}, 403));
    await Promise.all([first, second]);

    expect(observedRequestCount).toBe(1);
  });

  it('waits for an in-flight device save before logout clears credentials', async () => {
    let now = NOW;
    const previous = {
      version: 1,
      accessToken: 'previous-device-access',
      refreshToken: 'previous-device-refresh',
      expiresAt: NOW + 600_000,
      accountId: 'previous-device-account',
      updatedAt: NOW,
    } satisfies CodexOAuthCredentials;
    const vault = new DeferredSaveVault();
    vault.current = previous;
    const verifier = 'logout-save-verifier';
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'logout-save-device-id',
            user_code: 'LOGOUT-SAVE',
            interval: 1,
          });
        }
        if (input === CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT) {
          return jsonResponse({
            authorization_code: 'logout-save-code',
            code_verifier: verifier,
            code_challenge: pkceChallenge(verifier),
          });
        }
        return jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'logout-save-account' }),
          refresh_token: 'logout-save-refresh',
          expires_in: 300,
        });
      },
    });
    managers.push(manager);
    const tokenProvider = new ManagedCodexTokenProvider({ vault, clock: { now: () => now } });

    await manager.begin('device');
    now += 1_000;
    const polling = manager.poll();
    await vault.saveStarted.promise;
    const logout = (async () => {
      await manager.cancel();
      await tokenProvider.logout();
    })();
    await Promise.resolve();
    await Promise.resolve();
    expect(vault.clearCount).toBe(0);
    vault.releaseFirstSave.resolve();
    await Promise.all([polling, logout]);

    expect(vault.current).toBeNull();
  });

  it('rejects a device verifier whose S256 challenge does not match', async () => {
    let now = NOW;
    let exchangeRequestCount = 0;
    const vault = new MemoryVault();
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'mismatch-device-id',
            user_code: 'MISMATCH',
            interval: 1,
          });
        }
        if (input === CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT) {
          return jsonResponse({
            authorization_code: 'mismatch-authorization-code',
            code_verifier: 'real-verifier',
            code_challenge: 'attacker-challenge',
          });
        }
        exchangeRequestCount += 1;
        return jsonResponse({});
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 1_000;

    await expect(manager.poll()).resolves.toMatchObject({
      method: 'device',
      status: 'failed',
      errorCode: 'INVALID_RESPONSE',
    });
    expect(exchangeRequestCount).toBe(0);
    expect(vault.saved).toEqual([]);
  });

  it('maps a device poll network failure to terminal network error', async () => {
    let now = NOW;
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'network-device-id',
            user_code: 'NETWORK',
            interval: 1,
          });
        }
        throw new Error('private device poll socket detail');
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 1_000;
    const status = await manager.poll();

    expect(status).toMatchObject({
      method: 'device',
      status: 'failed',
      errorCode: 'NETWORK_ERROR',
    });
    expect(JSON.stringify(status)).not.toContain('private device poll socket detail');
  });

  it('maps a device poll 5xx to upstream error without exposing its body', async () => {
    let now = NOW;
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'poll-5xx-device-id',
            user_code: 'POLL-5XX',
            interval: 1,
          });
        }
        return jsonResponse({ secret: 'private poll 5xx body' }, 502);
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 1_000;
    const status = await manager.poll();

    expect(status).toMatchObject({
      method: 'device',
      status: 'failed',
      errorCode: 'UPSTREAM_ERROR',
    });
    expect(JSON.stringify(status)).not.toContain('private poll 5xx body');
  });

  it('does not exchange or save a poll result that arrives after cancellation', async () => {
    let now = NOW;
    const vault = new MemoryVault();
    const pollResponse = deferred<Response>();
    const pollStarted = deferred<void>();
    let exchangeRequestCount = 0;
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          return jsonResponse({
            device_auth_id: 'cancelled-device-id',
            user_code: 'CANCEL-POLL',
            interval: 1,
          });
        }
        if (input === CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT) {
          pollStarted.resolve();
          return pollResponse.promise;
        }
        exchangeRequestCount += 1;
        return jsonResponse({
          access_token: unsignedJwt({ chatgpt_account_id: 'cancelled-account' }),
          refresh_token: 'cancelled-refresh',
          expires_in: 300,
        });
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 1_000;
    const polling = manager.poll();
    await pollStarted.promise;
    await manager.cancel();
    pollResponse.resolve(
      jsonResponse({
        authorization_code: 'cancelled-authorization-code',
        code_verifier: 'cancelled-verifier',
        code_challenge: 'cancelled-challenge',
      }),
    );
    await polling;

    expect(exchangeRequestCount).toBe(0);
    expect(vault.saved).toEqual([]);
    await expect(manager.poll()).resolves.toBeNull();
  });

  it('does not save a device exchange after a replacement attempt starts', async () => {
    let now = NOW;
    let startCount = 0;
    const vault = new MemoryVault();
    const exchangeResponse = deferred<Response>();
    const exchangeStarted = deferred<void>();
    const manager = new CodexLoginManager({
      vault,
      clock: { now: () => now },
      oauthFetch: async (input) => {
        if (input === CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT) {
          startCount += 1;
          return jsonResponse({
            device_auth_id: `replacement-device-${startCount}`,
            user_code: `REPLACE-${startCount}`,
            interval: 1,
          });
        }
        if (input === CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT) {
          return jsonResponse({
            authorization_code: 'replaced-authorization-code',
            code_verifier: 'replaced-verifier',
            code_challenge: pkceChallenge('replaced-verifier'),
          });
        }
        exchangeStarted.resolve();
        return exchangeResponse.promise;
      },
    });
    managers.push(manager);

    await manager.begin('device');
    now += 1_000;
    const oldPoll = manager.poll();
    await exchangeStarted.promise;
    const replacement = await manager.begin('device');
    exchangeResponse.resolve(
      jsonResponse({
        access_token: unsignedJwt({ chatgpt_account_id: 'replaced-account' }),
        refresh_token: 'replaced-refresh',
        expires_in: 300,
      }),
    );
    await oldPoll;

    expect(replacement).toMatchObject({
      method: 'device',
      status: 'pending',
      userCode: 'REPLACE-2',
    });
    expect(vault.saved).toEqual([]);
    await expect(manager.poll()).resolves.toMatchObject({ userCode: 'REPLACE-2' });
  });

  it('keeps the newer attempt when concurrent device starts resolve out of order', async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    let requestCount = 0;
    const manager = new CodexLoginManager({
      vault: new MemoryVault(),
      oauthFetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          firstStarted.resolve();
          return firstResponse.promise;
        }
        secondStarted.resolve();
        return secondResponse.promise;
      },
    });
    managers.push(manager);

    const firstBegin = manager.begin('device');
    await firstStarted.promise;
    const secondBegin = manager.begin('device');
    await secondStarted.promise;
    secondResponse.resolve(
      jsonResponse({
        device_auth_id: 'newer-device-id',
        user_code: 'NEWER-CODE',
        interval: 5,
      }),
    );
    const newer = await secondBegin;
    firstResponse.resolve(
      jsonResponse({
        device_auth_id: 'older-device-id',
        user_code: 'OLDER-CODE',
        interval: 5,
      }),
    );
    await firstBegin;

    expect(newer).toMatchObject({ userCode: 'NEWER-CODE' });
    await expect(manager.poll()).resolves.toMatchObject({ userCode: 'NEWER-CODE' });
  });
});
