import { createServer, type Server } from 'node:http';

import type {
  CodexLoginAttempt,
  CodexLoginErrorCode,
  CodexOAuthLoginMethod,
} from '@/lib/types/codex-auth';

import {
  CODEX_OAUTH_BROWSER_REDIRECT_URI,
  CODEX_OAUTH_DEVICE_REDIRECT_URI,
  CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT,
  CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT,
  CODEX_OAUTH_DEVICE_VERIFICATION_URL,
  createBrowserAuthorization,
  createPkceChallenge,
  exchangeAuthorizationCode,
} from './oauth';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  type CodexClock,
  type TokenExchangeFetch,
} from './token-provider';
import { codexCredentialsEqual, withCodexCredentialVaultMutation } from './vault';
import type { CodexCredentialVault, CodexOAuthCredentials } from './vault';

const BROWSER_CALLBACK_HOST = '127.0.0.1';
const BROWSER_CALLBACK_PORT = 1455;
const BROWSER_TIMEOUT_MS = 5 * 60_000;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;

interface CodexLoginManagerOptions {
  vault: CodexCredentialVault;
  oauthFetch?: TokenExchangeFetch;
  clock?: CodexClock;
  randomBytes?: (size: number) => Buffer;
  scheduler?: CodexLoginScheduler;
}

interface CodexLoginScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface BrowserAttempt {
  method: 'browser';
  status: CodexLoginAttempt['status'];
  authorizationUrl: string;
  expiresAt: number;
  verifier: string;
  state: string;
  server: Server;
  errorCode?: CodexLoginErrorCode;
  timeoutHandle?: unknown;
  verificationUrl?: string;
  callbackClaimed?: boolean;
}

interface DeviceAttempt {
  method: 'device';
  status: CodexLoginAttempt['status'];
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  interval: number;
  deviceAuthId: string;
  nextPollAt: number;
  errorCode?: CodexLoginErrorCode;
  pollInFlight?: Promise<CodexLoginAttempt>;
}

interface TerminalAttempt {
  method: CodexOAuthLoginMethod;
  status: 'failed' | 'expired' | 'complete';
  errorCode?: CodexLoginErrorCode;
  verificationUrl?: string;
}

type ActiveAttempt = BrowserAttempt | DeviceAttempt | TerminalAttempt;

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function toPublicAttempt(attempt: ActiveAttempt): CodexLoginAttempt {
  if (attempt.status !== 'pending') {
    return {
      method: attempt.method,
      status: attempt.status,
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      ...(attempt.verificationUrl ? { verificationUrl: attempt.verificationUrl } : {}),
    };
  }
  if (attempt.method === 'device') {
    return {
      method: attempt.method,
      status: attempt.status,
      verificationUrl: attempt.verificationUrl,
      userCode: attempt.userCode,
      expiresAt: attempt.expiresAt,
      interval: attempt.interval,
    };
  }
  return {
    method: attempt.method,
    status: attempt.status,
    authorizationUrl: attempt.authorizationUrl,
    expiresAt: attempt.expiresAt,
  };
}

export class CodexLoginManager {
  private readonly vault: CodexCredentialVault;
  private readonly oauthFetch: TokenExchangeFetch;
  private readonly clock: CodexClock;
  private readonly randomBytes?: (size: number) => Buffer;
  private readonly scheduler: CodexLoginScheduler;
  private activeAttempt: ActiveAttempt | null = null;
  private attemptGeneration = 0;
  private browserSetupTail: Promise<void> = Promise.resolve();
  private readonly credentialWrites = new Set<Promise<boolean>>();

  constructor(options: CodexLoginManagerOptions) {
    this.vault = options.vault;
    this.oauthFetch = options.oauthFetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? { now: Date.now };
    this.randomBytes = options.randomBytes;
    this.scheduler = options.scheduler ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  async begin(method: CodexOAuthLoginMethod): Promise<CodexLoginAttempt> {
    const generation = ++this.attemptGeneration;
    await this.cancelActiveAttempt();
    if (generation !== this.attemptGeneration) return this.currentOrReplacedAttempt(method);
    if (method === 'device') return this.beginDeviceAttempt(generation);
    if (method !== 'browser') throw new Error('Unsupported Codex login method');
    return this.queueBrowserStart(generation);
  }

  private async queueBrowserStart(generation: number): Promise<CodexLoginAttempt> {
    const previousSetup = this.browserSetupTail;
    let releaseSetup!: () => void;
    this.browserSetupTail = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    await previousSetup;
    try {
      if (generation !== this.attemptGeneration) {
        return this.currentOrReplacedAttempt('browser');
      }
      return await this.beginBrowserAttempt(generation);
    } finally {
      releaseSetup();
    }
  }

  private async beginBrowserAttempt(generation: number): Promise<CodexLoginAttempt> {
    const authorization = createBrowserAuthorization({ randomBytes: this.randomBytes });
    const server = createServer();
    const attempt: BrowserAttempt = {
      method: 'browser',
      status: 'pending',
      authorizationUrl: authorization.authorizationUrl,
      expiresAt: this.clock.now() + BROWSER_TIMEOUT_MS,
      verifier: authorization.verifier,
      state: authorization.state,
      server,
    };
    server.on('request', (request, response) => {
      void this.handleBrowserCallback(attempt, request.url ?? '/', response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(BROWSER_CALLBACK_PORT, BROWSER_CALLBACK_HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch {
      attempt.status = 'failed';
      attempt.errorCode = 'BROWSER_UNAVAILABLE';
      attempt.verificationUrl = CODEX_OAUTH_DEVICE_VERIFICATION_URL;
      return this.activateStartedAttempt(generation, attempt);
    }
    if (generation !== this.attemptGeneration) {
      await closeServer(server);
      return this.currentOrReplacedAttempt('browser');
    }
    this.activeAttempt = attempt;
    attempt.timeoutHandle = this.scheduler.setTimeout(
      () => this.expireBrowserAttempt(attempt),
      BROWSER_TIMEOUT_MS,
    );
    return toPublicAttempt(attempt);
  }

  async poll(): Promise<CodexLoginAttempt | null> {
    const attempt = this.activeAttempt;
    if (!attempt) return null;
    if (attempt.method !== 'device' || attempt.status !== 'pending') {
      if (attempt.status === 'expired') await this.waitForCredentialWrites();
      return toPublicAttempt(attempt);
    }

    const now = this.clock.now();
    if (now >= attempt.expiresAt) {
      attempt.status = 'expired';
      await this.waitForCredentialWrites();
      return toPublicAttempt(attempt);
    }
    if (attempt.pollInFlight) return attempt.pollInFlight;
    if (now < attempt.nextPollAt) return toPublicAttempt(attempt);
    const polling = this.pollDeviceAttempt(attempt, now);
    attempt.pollInFlight = polling;
    const clearPolling = () => {
      if (attempt.pollInFlight === polling) attempt.pollInFlight = undefined;
    };
    void polling.then(clearPolling, clearPolling);
    return polling;
  }

  async cancel(): Promise<void> {
    this.attemptGeneration += 1;
    await this.cancelActiveAttempt();
  }

  private async cancelActiveAttempt(): Promise<void> {
    const attempt = this.activeAttempt;
    this.activeAttempt = null;
    const cleanup: Array<Promise<unknown>> = [this.waitForCredentialWrites()];
    if (attempt?.method === 'browser' && 'server' in attempt) {
      this.clearBrowserTimeout(attempt);
      cleanup.push(closeServer(attempt.server));
    }
    await Promise.all(cleanup);
  }

  private async waitForCredentialWrites(): Promise<void> {
    await Promise.all([...this.credentialWrites]);
  }

  private isAttemptCommitEligible(attempt: BrowserAttempt | DeviceAttempt): boolean {
    if (this.activeAttempt !== attempt || attempt.status !== 'pending') return false;
    if (this.clock.now() < attempt.expiresAt) return true;
    attempt.status = 'expired';
    return false;
  }

  private async persistAttemptCredentials(
    attempt: BrowserAttempt | DeviceAttempt,
    credentials: CodexOAuthCredentials,
  ): Promise<boolean> {
    const write = withCodexCredentialVaultMutation(this.vault, async () => {
      if (!this.isAttemptCommitEligible(attempt)) return false;
      const previous = await this.vault.load();
      if (!this.isAttemptCommitEligible(attempt)) return false;
      await this.vault.save(credentials);
      if (this.isAttemptCommitEligible(attempt)) {
        attempt.status = 'complete';
        return true;
      }

      const current = await this.vault.load();
      if (!codexCredentialsEqual(current, credentials)) return false;
      if (previous) await this.vault.save(previous);
      else await this.vault.clear();
      return false;
    });
    this.credentialWrites.add(write);
    try {
      return await write;
    } finally {
      this.credentialWrites.delete(write);
    }
  }

  private async beginDeviceAttempt(generation: number): Promise<CodexLoginAttempt> {
    let response: Response;
    try {
      response = await this.oauthFetch(CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      });
    } catch {
      const attempt: TerminalAttempt = {
        method: 'device',
        status: 'failed',
        errorCode: 'NETWORK_ERROR',
      };
      return this.activateStartedAttempt(generation, attempt);
    }
    if (response.status === 404) {
      const attempt: TerminalAttempt = {
        method: 'device',
        status: 'failed',
        errorCode: 'DEVICE_UNAVAILABLE',
      };
      return this.activateStartedAttempt(generation, attempt);
    }
    if (response.status >= 500) {
      const attempt: TerminalAttempt = {
        method: 'device',
        status: 'failed',
        errorCode: 'UPSTREAM_ERROR',
      };
      return this.activateStartedAttempt(generation, attempt);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const attempt: TerminalAttempt = {
        method: 'device',
        status: 'failed',
        errorCode: 'INVALID_RESPONSE',
      };
      return this.activateStartedAttempt(generation, attempt);
    }
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const attempt: TerminalAttempt = {
        method: 'device',
        status: 'failed',
        errorCode: 'INVALID_RESPONSE',
      };
      return this.activateStartedAttempt(generation, attempt);
    }
    const record = payload as Record<string, unknown>;
    const deviceAuthId =
      typeof record.device_auth_id === 'string' ? record.device_auth_id : undefined;
    const userCode = typeof record.user_code === 'string' ? record.user_code : undefined;
    const parsedInterval = Number(record.interval);
    const interval =
      Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : DEFAULT_DEVICE_INTERVAL_SECONDS;
    const parsedExpiresIn = Number(record.expires_in);
    const durationMs =
      Number.isFinite(parsedExpiresIn) && parsedExpiresIn > 0
        ? Math.min(parsedExpiresIn * 1000, DEVICE_TIMEOUT_MS)
        : DEVICE_TIMEOUT_MS;
    if (!deviceAuthId || !userCode) {
      const attempt: TerminalAttempt = {
        method: 'device',
        status: 'failed',
        errorCode: 'INVALID_RESPONSE',
      };
      return this.activateStartedAttempt(generation, attempt);
    }

    const now = this.clock.now();
    const attempt: DeviceAttempt = {
      method: 'device',
      status: 'pending',
      verificationUrl: CODEX_OAUTH_DEVICE_VERIFICATION_URL,
      userCode,
      expiresAt: now + durationMs,
      interval,
      deviceAuthId,
      nextPollAt: now + interval * 1000,
    };
    return this.activateStartedAttempt(generation, attempt);
  }

  private activateStartedAttempt(generation: number, attempt: ActiveAttempt): CodexLoginAttempt {
    if (generation !== this.attemptGeneration) return this.currentOrReplacedAttempt(attempt.method);
    this.activeAttempt = attempt;
    return toPublicAttempt(attempt);
  }

  private currentOrReplacedAttempt(method: CodexOAuthLoginMethod): CodexLoginAttempt {
    return this.activeAttempt
      ? toPublicAttempt(this.activeAttempt)
      : { method, status: 'failed', errorCode: 'ATTEMPT_REPLACED' };
  }

  private async pollDeviceAttempt(attempt: DeviceAttempt, now: number): Promise<CodexLoginAttempt> {
    attempt.nextPollAt = now + attempt.interval * 1000;
    let response: Response;
    try {
      response = await this.oauthFetch(CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: attempt.deviceAuthId,
          user_code: attempt.userCode,
        }),
      });
    } catch {
      if (!this.isAttemptCommitEligible(attempt)) return toPublicAttempt(attempt);
      attempt.status = 'failed';
      attempt.errorCode = 'NETWORK_ERROR';
      return toPublicAttempt(attempt);
    }
    if (response.status === 403 || response.status === 404) {
      this.isAttemptCommitEligible(attempt);
      return toPublicAttempt(attempt);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (!this.isAttemptCommitEligible(attempt)) return toPublicAttempt(attempt);
      attempt.status = 'failed';
      attempt.errorCode = 'INVALID_RESPONSE';
      return toPublicAttempt(attempt);
    }
    if (!this.isAttemptCommitEligible(attempt)) return toPublicAttempt(attempt);
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      attempt.status = 'failed';
      attempt.errorCode = response.status >= 500 ? 'UPSTREAM_ERROR' : 'INVALID_RESPONSE';
      return toPublicAttempt(attempt);
    }
    const record = payload as Record<string, unknown>;
    const authorizationCode =
      typeof record.authorization_code === 'string' ? record.authorization_code : undefined;
    const codeVerifier =
      typeof record.code_verifier === 'string' ? record.code_verifier : undefined;
    const codeChallenge =
      typeof record.code_challenge === 'string' ? record.code_challenge : undefined;
    if (
      !authorizationCode ||
      !codeVerifier ||
      !codeChallenge ||
      createPkceChallenge(codeVerifier) !== codeChallenge
    ) {
      attempt.status = 'failed';
      attempt.errorCode = 'INVALID_RESPONSE';
      return toPublicAttempt(attempt);
    }
    if (!this.isAttemptCommitEligible(attempt)) return toPublicAttempt(attempt);
    let credentials;
    try {
      credentials = await exchangeAuthorizationCode({
        code: authorizationCode,
        verifier: codeVerifier,
        redirectUri: CODEX_OAUTH_DEVICE_REDIRECT_URI,
        tokenExchangeFetch: this.oauthFetch,
        clock: this.clock,
      });
    } catch (error) {
      if (!this.isAttemptCommitEligible(attempt)) return toPublicAttempt(attempt);
      attempt.status = 'failed';
      attempt.errorCode =
        error instanceof CodexOAuthError && error.code === CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR
          ? 'NETWORK_ERROR'
          : error instanceof CodexOAuthError &&
              error.code === CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR
            ? 'UPSTREAM_ERROR'
            : 'INVALID_RESPONSE';
      return toPublicAttempt(attempt);
    }
    if (!this.isAttemptCommitEligible(attempt)) return toPublicAttempt(attempt);
    let committed: boolean;
    try {
      committed = await this.persistAttemptCredentials(attempt, credentials);
    } catch {
      if (!this.isAttemptCommitEligible(attempt)) return toPublicAttempt(attempt);
      attempt.status = 'failed';
      attempt.errorCode = 'STORAGE_ERROR';
      return toPublicAttempt(attempt);
    }
    if (!committed) return toPublicAttempt(attempt);
    return toPublicAttempt(attempt);
  }

  private async handleBrowserCallback(
    attempt: BrowserAttempt,
    requestUrl: string,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const callback = new URL(requestUrl, CODEX_OAUTH_BROWSER_REDIRECT_URI);
    if (callback.pathname !== '/auth/callback') {
      response.statusCode = 404;
      response.end('Not found.');
      return;
    }
    if (this.activeAttempt !== attempt || attempt.status !== 'pending' || attempt.callbackClaimed) {
      response.statusCode = 409;
      response.end('Codex authorization callback is no longer active.');
      return;
    }

    try {
      if (callback.searchParams.get('state') !== attempt.state) {
        attempt.status = 'failed';
        attempt.errorCode = 'STATE_MISMATCH';
        this.clearBrowserTimeout(attempt);
        response.statusCode = 400;
        response.end('Codex authorization failed.');
        return;
      }
      if (callback.searchParams.has('error')) {
        attempt.status = 'failed';
        attempt.errorCode = 'AUTHORIZATION_REJECTED';
        this.clearBrowserTimeout(attempt);
        response.statusCode = 400;
        response.end('Codex authorization failed.');
        return;
      }
      const code = callback.searchParams.get('code');
      if (!code) {
        attempt.status = 'failed';
        attempt.errorCode = 'INVALID_CALLBACK';
        this.clearBrowserTimeout(attempt);
        response.statusCode = 400;
        response.end('Codex authorization failed.');
        return;
      }
      attempt.callbackClaimed = true;
      const credentials = await exchangeAuthorizationCode({
        code,
        verifier: attempt.verifier,
        redirectUri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
        tokenExchangeFetch: this.oauthFetch,
        clock: this.clock,
      });
      if (!this.isAttemptCommitEligible(attempt)) {
        response.statusCode = 409;
        response.end('Codex authorization was cancelled.');
        return;
      }
      let committed: boolean;
      try {
        committed = await this.persistAttemptCredentials(attempt, credentials);
      } catch {
        if (this.activeAttempt === attempt && attempt.status === 'pending') {
          attempt.status = 'failed';
          attempt.errorCode = 'STORAGE_ERROR';
          this.clearBrowserTimeout(attempt);
        }
        response.statusCode = 400;
        response.end('Codex authorization failed.');
        return;
      }
      if (!committed) {
        response.statusCode = 409;
        response.end('Codex authorization was cancelled.');
        return;
      }
      this.clearBrowserTimeout(attempt);
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Codex authorization complete. You can close this window.');
    } catch (error) {
      if (this.activeAttempt === attempt && attempt.status === 'pending') {
        attempt.status = 'failed';
        attempt.errorCode =
          error instanceof CodexOAuthError && error.code === CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR
            ? 'NETWORK_ERROR'
            : error instanceof CodexOAuthError &&
                error.code === CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR
              ? 'UPSTREAM_ERROR'
              : 'INVALID_RESPONSE';
        this.clearBrowserTimeout(attempt);
      }
      response.statusCode = 400;
      response.end('Codex authorization failed.');
    } finally {
      void closeServer(attempt.server);
    }
  }

  private async expireBrowserAttempt(attempt: BrowserAttempt): Promise<void> {
    if (
      this.activeAttempt !== attempt ||
      attempt.status !== 'pending' ||
      this.clock.now() < attempt.expiresAt
    ) {
      return;
    }
    attempt.status = 'expired';
    attempt.timeoutHandle = undefined;
    await Promise.all([closeServer(attempt.server), this.waitForCredentialWrites()]);
  }

  private clearBrowserTimeout(attempt: BrowserAttempt): void {
    if (attempt.timeoutHandle === undefined) return;
    this.scheduler.clearTimeout(attempt.timeoutHandle);
    attempt.timeoutHandle = undefined;
  }
}
