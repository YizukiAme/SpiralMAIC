import type {
  CodexAuthPublicStatus,
  CodexLoginAttempt,
  CodexOAuthLoginMethod,
} from '@/lib/types/codex-auth';

const AUTH_ENDPOINT = '/api/codex/auth';
const LOGIN_ENDPOINT = '/api/codex/auth/login';
const VERIFY_ENDPOINT = '/api/verify-model';
const DEFAULT_POLL_INTERVAL_SECONDS = 2;

export type CodexOAuthClientMessageKey =
  | 'loginFailed'
  | 'loginExpired'
  | 'testUnauthorized'
  | 'testForbidden'
  | 'testRateLimited'
  | 'testFailed'
  | 'testSuccess';

export interface CodexOAuthClientSnapshot {
  auth: CodexAuthPublicStatus | null;
  attempt: CodexLoginAttempt | null;
  busy: 'loading' | 'starting' | 'waiting' | 'syncing' | 'cancelling' | 'signing-out' | null;
  startingMethod: CodexOAuthLoginMethod | null;
  errorKey: CodexOAuthClientMessageKey | null;
}

export interface CodexPopupHandle {
  readonly closed: boolean;
  navigate(url: string): void;
  close(): void;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ScheduledCallback = () => void | Promise<void>;

interface CodexOAuthClientDependencies {
  fetcher: Fetcher;
  openPopup: () => CodexPopupHandle | null;
  schedule: (callback: ScheduledCallback, delayMs: number) => unknown;
  clearSchedule: (handle: unknown) => void;
  onChange: (snapshot: CodexOAuthClientSnapshot) => void;
  onLoginComplete: () => Promise<void>;
  onLogoutComplete: () => Promise<void>;
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function parseAttempt(value: unknown): CodexLoginAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.method !== 'browser' && record.method !== 'device') return null;
  if (
    record.status !== 'pending' &&
    record.status !== 'complete' &&
    record.status !== 'failed' &&
    record.status !== 'expired'
  ) {
    return null;
  }
  const attempt: CodexLoginAttempt = { method: record.method, status: record.status };
  const knownErrorCodes = new Set([
    'BROWSER_UNAVAILABLE',
    'ATTEMPT_REPLACED',
    'INVALID_CALLBACK',
    'AUTHORIZATION_REJECTED',
    'STATE_MISMATCH',
    'DEVICE_UNAVAILABLE',
    'NETWORK_ERROR',
    'UPSTREAM_ERROR',
    'INVALID_RESPONSE',
    'STORAGE_ERROR',
  ]);
  if (typeof record.errorCode === 'string' && knownErrorCodes.has(record.errorCode)) {
    attempt.errorCode = record.errorCode as CodexLoginAttempt['errorCode'];
  }
  if (typeof record.authorizationUrl === 'string') {
    attempt.authorizationUrl = record.authorizationUrl;
  }
  if (typeof record.verificationUrl === 'string') {
    attempt.verificationUrl = record.verificationUrl;
  }
  if (typeof record.userCode === 'string') attempt.userCode = record.userCode;
  if (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)) {
    attempt.expiresAt = record.expiresAt;
  }
  if (typeof record.interval === 'number' && Number.isFinite(record.interval)) {
    attempt.interval = record.interval;
  }
  return attempt;
}

function parseAuthStatus(value: unknown): CodexAuthPublicStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reasons = new Set([
    'AVAILABLE',
    'FEATURE_DISABLED',
    'SERVERLESS_UNSUPPORTED',
    'ACCESS_CODE_REQUIRED',
    'DATA_DIR_UNWRITABLE',
    'RUNTIME_LOCKED',
  ]);
  if (
    typeof record.available !== 'boolean' ||
    typeof record.connected !== 'boolean' ||
    typeof record.reason !== 'string' ||
    !reasons.has(record.reason) ||
    !Array.isArray(record.methods) ||
    !record.methods.every((method) => method === 'browser' || method === 'device')
  ) {
    return null;
  }
  return {
    available: record.available,
    connected: record.connected,
    reason: record.reason as CodexAuthPublicStatus['reason'],
    methods: [...record.methods] as CodexAuthPublicStatus['methods'],
    ...(typeof record.email === 'string' ? { email: record.email } : {}),
  };
}

function mapAttemptError(attempt: CodexLoginAttempt): CodexOAuthClientMessageKey | null {
  if (attempt.status === 'expired') return 'loginExpired';
  if (attempt.status === 'failed') return 'loginFailed';
  return null;
}

export class CodexOAuthClient {
  private readonly dependencies: CodexOAuthClientDependencies;
  private snapshot: CodexOAuthClientSnapshot = {
    auth: null,
    attempt: null,
    busy: null,
    startingMethod: null,
    errorKey: null,
  };
  private generation = 0;
  private mounted = false;
  private disposed = false;
  private pollTimer: unknown = null;
  private popup: CodexPopupHandle | null = null;

  constructor(dependencies: CodexOAuthClientDependencies) {
    this.dependencies = dependencies;
  }

  getSnapshot(): CodexOAuthClientSnapshot {
    return this.snapshot;
  }

  private publish(patch: Partial<CodexOAuthClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (!this.disposed) this.dependencies.onChange(this.snapshot);
  }

  private clearPollTimer(): void {
    if (this.pollTimer === null) return;
    this.dependencies.clearSchedule(this.pollTimer);
    this.pollTimer = null;
  }

  private beginGeneration(): number {
    this.clearPollTimer();
    return ++this.generation;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private canStartAction(): boolean {
    return !this.disposed && this.snapshot.busy === null;
  }

  async mount(): Promise<void> {
    if (this.mounted || this.disposed) return;
    this.mounted = true;
    const generation = this.beginGeneration();
    this.publish({ busy: 'loading', errorKey: null });

    let response: Response;
    try {
      response = await this.dependencies.fetcher(AUTH_ENDPOINT, { cache: 'no-store' });
    } catch {
      if (this.isCurrent(generation)) this.publish({ busy: null, errorKey: 'loginFailed' });
      return;
    }
    if (!this.isCurrent(generation)) return;
    const auth = response.ok
      ? parseAuthStatus(await readJson<CodexAuthPublicStatus>(response))
      : null;
    if (!auth) {
      this.publish({ busy: null, errorKey: 'loginFailed' });
      return;
    }
    this.publish({ auth, busy: null, errorKey: null });

    if (!auth.available || auth.connected) return;
    await this.recoverAttempt(generation);
  }

  private async recoverAttempt(generation: number): Promise<void> {
    let response: Response;
    try {
      response = await this.dependencies.fetcher(LOGIN_ENDPOINT, { method: 'PATCH' });
    } catch {
      return;
    }
    if (!this.isCurrent(generation) || !response.ok) return;
    const attempt = parseAttempt(await readJson<CodexLoginAttempt>(response));
    if (attempt) await this.acceptAttempt(attempt, generation);
  }

  async startBrowser(): Promise<void> {
    if (!this.canStartAction()) return;
    const popup = this.dependencies.openPopup();
    const generation = this.beginGeneration();
    this.popup = popup;
    this.publish({
      attempt: null,
      busy: 'starting',
      startingMethod: 'browser',
      errorKey: null,
    });

    const attempt = await this.postLogin('browser', generation);
    if (!this.isCurrent(generation)) {
      popup?.close();
      return;
    }
    if (
      !attempt ||
      attempt.status === 'failed' ||
      !attempt.authorizationUrl ||
      !popup ||
      popup.closed
    ) {
      await this.fallbackFromBrowser(generation, popup);
      return;
    }

    try {
      popup.navigate(attempt.authorizationUrl);
    } catch {
      await this.fallbackFromBrowser(generation, popup);
      return;
    }
    await this.acceptAttempt(attempt, generation);
  }

  private async fallbackFromBrowser(
    generation: number,
    popup: CodexPopupHandle | null,
  ): Promise<void> {
    popup?.close();
    if (!this.isCurrent(generation)) return;
    try {
      await this.dependencies.fetcher(LOGIN_ENDPOINT, { method: 'DELETE' });
    } catch {
      // The device POST replaces any surviving server attempt too.
    }
    if (!this.isCurrent(generation)) return;
    const supportsDevice = this.snapshot.auth?.methods.includes('device') ?? true;
    if (supportsDevice) {
      await this.startDeviceInternal();
    } else {
      this.publish({ busy: null, startingMethod: null, errorKey: 'loginFailed' });
    }
  }

  async startDevice(): Promise<void> {
    if (!this.canStartAction()) return;
    await this.startDeviceInternal();
  }

  private async startDeviceInternal(): Promise<void> {
    this.popup?.close();
    this.popup = null;
    const generation = this.beginGeneration();
    this.publish({
      attempt: null,
      busy: 'starting',
      startingMethod: 'device',
      errorKey: null,
    });
    const attempt = await this.postLogin('device', generation);
    if (!this.isCurrent(generation)) return;
    if (!attempt) {
      this.publish({ busy: null, startingMethod: null, errorKey: 'loginFailed' });
      return;
    }
    await this.acceptAttempt(attempt, generation);
  }

  private async postLogin(
    method: CodexOAuthLoginMethod,
    generation: number,
  ): Promise<CodexLoginAttempt | null> {
    let response: Response;
    try {
      response = await this.dependencies.fetcher(LOGIN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method }),
      });
    } catch {
      return null;
    }
    if (!this.isCurrent(generation) || !response.ok) return null;
    const attempt = parseAttempt(await readJson<CodexLoginAttempt>(response));
    return attempt?.method === method ? attempt : null;
  }

  private async acceptAttempt(attempt: CodexLoginAttempt, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const errorKey = mapAttemptError(attempt);
    this.publish({
      attempt,
      busy:
        attempt.status === 'pending' ? 'waiting' : attempt.status === 'complete' ? 'syncing' : null,
      startingMethod: null,
      errorKey,
    });

    if (attempt.status === 'pending') {
      this.schedulePoll(attempt, generation);
      return;
    }
    if (attempt.status !== 'complete') return;

    this.clearPollTimer();
    this.popup?.close();
    this.popup = null;
    let syncFailed = false;
    try {
      await this.dependencies.onLoginComplete();
    } catch {
      syncFailed = true;
    }
    if (!this.isCurrent(generation)) return;
    if (this.snapshot.auth) {
      this.publish({
        auth: { ...this.snapshot.auth, connected: true },
        busy: null,
        errorKey: syncFailed ? 'loginFailed' : null,
      });
    } else {
      this.publish({ busy: null, errorKey: syncFailed ? 'loginFailed' : null });
    }
  }

  private schedulePoll(attempt: CodexLoginAttempt, generation: number): void {
    this.clearPollTimer();
    const intervalSeconds = Math.max(
      1,
      Number.isFinite(attempt.interval) ? (attempt.interval ?? DEFAULT_POLL_INTERVAL_SECONDS) : 2,
    );
    this.pollTimer = this.dependencies.schedule(async () => {
      this.pollTimer = null;
      await this.poll(generation);
    }, intervalSeconds * 1_000);
  }

  private async poll(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    let response: Response;
    try {
      response = await this.dependencies.fetcher(LOGIN_ENDPOINT, { method: 'PATCH' });
    } catch {
      if (this.isCurrent(generation) && this.snapshot.attempt) {
        this.schedulePoll(this.snapshot.attempt, generation);
      }
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (!response.ok) {
      if (response.status === 404) {
        this.publish({ attempt: null, busy: null, startingMethod: null });
      } else if (this.snapshot.attempt) this.schedulePoll(this.snapshot.attempt, generation);
      return;
    }
    const attempt = parseAttempt(await readJson<CodexLoginAttempt>(response));
    if (attempt) await this.acceptAttempt(attempt, generation);
  }

  async cancel(): Promise<void> {
    if (
      this.disposed ||
      this.snapshot.busy !== 'waiting' ||
      this.snapshot.attempt?.status !== 'pending'
    ) {
      return;
    }
    const generation = this.beginGeneration();
    this.publish({ busy: 'cancelling', startingMethod: null, errorKey: null });
    this.popup?.close();
    this.popup = null;
    try {
      await this.dependencies.fetcher(LOGIN_ENDPOINT, { method: 'DELETE' });
    } catch {
      // Keep cancellation idempotent from the settings surface.
    }
    if (this.isCurrent(generation)) {
      this.publish({ attempt: null, busy: null, startingMethod: null, errorKey: null });
    }
  }

  async logout(): Promise<void> {
    if (!this.canStartAction()) return;
    const generation = this.beginGeneration();
    this.publish({ busy: 'signing-out', startingMethod: null, errorKey: null });
    let response: Response;
    try {
      response = await this.dependencies.fetcher(AUTH_ENDPOINT, { method: 'DELETE' });
    } catch {
      if (this.isCurrent(generation)) {
        this.publish({ busy: null, startingMethod: null, errorKey: 'loginFailed' });
      }
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (!response.ok) {
      this.publish({ busy: null, startingMethod: null, errorKey: 'loginFailed' });
      return;
    }
    let refreshFailed = false;
    try {
      await this.dependencies.onLogoutComplete();
    } catch {
      refreshFailed = true;
    }
    if (!this.isCurrent(generation)) return;
    let disconnectedAuth: CodexAuthPublicStatus | null = null;
    if (this.snapshot.auth) {
      disconnectedAuth = {
        available: this.snapshot.auth.available,
        reason: this.snapshot.auth.reason,
        methods: [...this.snapshot.auth.methods],
        connected: false,
      };
    }
    this.publish({
      auth: disconnectedAuth,
      attempt: null,
      busy: null,
      startingMethod: null,
      errorKey: refreshFailed ? 'loginFailed' : null,
    });
  }

  async testConnection(
    modelId: string,
  ): Promise<{ ok: boolean; messageKey: CodexOAuthClientMessageKey }> {
    if (!this.canStartAction()) return { ok: false, messageKey: 'testFailed' };
    let response: Response;
    try {
      response = await this.dependencies.fetcher(VERIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: `openai-codex:${modelId}` }),
      });
    } catch {
      return { ok: false, messageKey: 'testFailed' };
    }
    if (response.ok) return { ok: true, messageKey: 'testSuccess' };
    if (response.status === 401) return { ok: false, messageKey: 'testUnauthorized' };
    if (response.status === 403) return { ok: false, messageKey: 'testForbidden' };
    if (response.status === 429) return { ok: false, messageKey: 'testRateLimited' };
    return { ok: false, messageKey: 'testFailed' };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearPollTimer();
  }
}

interface CodexProviderState {
  fetchServerProviders: () => Promise<void>;
  providersConfig: Record<string, { isServerConfigured?: boolean; models?: Array<{ id: string }> }>;
  setModel: (providerId: 'openai-codex', modelId: string) => void;
}

export async function syncCodexProviderAndSelect(
  getState: () => CodexProviderState,
): Promise<void> {
  await getState().fetchServerProviders();
  const freshState = getState();
  const codex = freshState.providersConfig['openai-codex'];
  const firstModel = codex?.isServerConfigured ? codex.models?.[0]?.id : undefined;
  if (firstModel) freshState.setModel('openai-codex', firstModel);
}

export async function syncServerProvidersAfterAccessUnlock(
  getState: () => Pick<CodexProviderState, 'fetchServerProviders'>,
): Promise<void> {
  await getState().fetchServerProviders();
}

export function getProviderBadgeTranslationKey(provider: {
  credentialMode?: 'api-key' | 'oauth' | 'none';
  isServerConfigured?: boolean;
}): 'settings.connected' | 'settings.serverConfigured' | null {
  if (!provider.isServerConfigured) return null;
  return provider.credentialMode === 'oauth' ? 'settings.connected' : 'settings.serverConfigured';
}
