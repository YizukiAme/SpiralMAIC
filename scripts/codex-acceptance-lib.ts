import { randomUUID } from 'node:crypto';

import { rebuildCodexModelCatalog } from '@/lib/ai/codex-catalog';

export const CODEX_ACCEPTANCE_ACCESS_CODE_ENV = 'OPENMAIC_ACCEPTANCE_ACCESS_CODE';

export type AcceptanceOutcome = 'PASS' | 'FAIL' | 'SKIP';

export type SafeErrorCategory =
  | 'argument'
  | 'auth'
  | 'forbidden'
  | 'rate-limited'
  | 'network'
  | 'upstream'
  | 'http'
  | 'invalid-json'
  | 'invalid-sse'
  | 'invalid-shape'
  | 'unavailable'
  | 'confirmation-required'
  | 'application-active'
  | 'application-state-unknown'
  | 'storage'
  | 'unexpected';

export interface SafeReport {
  outcome: AcceptanceOutcome;
  stage: string;
  modelId?: string;
  httpStatus?: number;
  errorCategory?: SafeErrorCategory;
  authenticated?: boolean;
  available?: boolean;
  connected?: boolean;
  providerPresent?: boolean;
  catalogStrict?: boolean;
  priorityAdvertised?: boolean;
  generated?: boolean;
  streaming?: boolean;
  incremental?: boolean;
  completed?: boolean;
  json?: boolean;
  simpleScene?: boolean;
  editorEnabled?: boolean;
  toolCalled?: boolean;
  toolCompleted?: boolean;
  assistantContinued?: boolean;
  applicationStopped?: boolean;
  refreshed?: boolean;
  modelCount?: number;
  fastModelCount?: number;
  eventCount?: number;
  outlineCount?: number;
  sceneCount?: number;
  toolCallCount?: number;
}

export interface AcceptanceOptions {
  baseUrl: string;
  expectSignedOut: boolean;
  accessCode?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface AcceptanceDependencies {
  fetcher?: Fetcher;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 310_000;
const SAFE_STAGE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const SAFE_ERROR_CATEGORIES = new Set<SafeErrorCategory>([
  'argument',
  'auth',
  'forbidden',
  'rate-limited',
  'network',
  'upstream',
  'http',
  'invalid-json',
  'invalid-sse',
  'invalid-shape',
  'unavailable',
  'confirmation-required',
  'application-active',
  'application-state-unknown',
  'storage',
  'unexpected',
]);

const SAFE_BOOLEAN_FIELDS = [
  'authenticated',
  'available',
  'connected',
  'providerPresent',
  'catalogStrict',
  'priorityAdvertised',
  'generated',
  'streaming',
  'incremental',
  'completed',
  'json',
  'simpleScene',
  'editorEnabled',
  'toolCalled',
  'toolCompleted',
  'assistantContinued',
  'applicationStopped',
  'refreshed',
] as const satisfies readonly (keyof SafeReport)[];

const SAFE_COUNT_FIELDS = [
  'modelCount',
  'fastModelCount',
  'eventCount',
  'outlineCount',
  'sceneCount',
  'toolCallCount',
] as const satisfies readonly (keyof SafeReport)[];

class SafeAcceptanceError extends Error {
  constructor(
    readonly category: SafeErrorCategory,
    readonly httpStatus?: number,
  ) {
    super(category);
    this.name = 'SafeAcceptanceError';
  }
}

function fail(category: SafeErrorCategory, httpStatus?: number): never {
  throw new SafeAcceptanceError(category, httpStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = [...allowed].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]))
  );
}

export function normalizePublicBaseUrl(raw: string | undefined): string {
  if (!raw) fail('argument');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail('argument');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash
  ) {
    fail('argument');
  }
  return parsed.origin;
}

export function parseAcceptanceArgs(argv: readonly string[]): AcceptanceOptions {
  let baseUrl: string | undefined;
  let expectSignedOut = false;
  const startIndex = argv[0] === '--' ? 1 : 0;
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base-url') {
      if (baseUrl !== undefined || index + 1 >= argv.length) fail('argument');
      baseUrl = normalizePublicBaseUrl(argv[++index]);
    } else if (argument === '--expect-signed-out') {
      if (expectSignedOut) fail('argument');
      expectSignedOut = true;
    } else {
      fail('argument');
    }
  }
  if (!baseUrl) fail('argument');
  return { baseUrl, expectSignedOut };
}

function safeStage(value: unknown): string {
  return typeof value === 'string' && SAFE_STAGE.test(value) ? value : 'invalid';
}

function safeModelId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_MODEL_ID.test(value) ? value : undefined;
}

export function formatSafeReport(report: SafeReport): string {
  const outcome: AcceptanceOutcome =
    report.outcome === 'PASS' || report.outcome === 'SKIP' ? report.outcome : 'FAIL';
  const fields = [outcome, `stage=${safeStage(report.stage)}`];
  const modelId = safeModelId(report.modelId);
  if (modelId) fields.push(`model=${modelId}`);
  if (
    Number.isInteger(report.httpStatus) &&
    (report.httpStatus as number) >= 100 &&
    (report.httpStatus as number) <= 599
  ) {
    fields.push(`http=${report.httpStatus}`);
  }
  for (const key of SAFE_BOOLEAN_FIELDS) {
    const value = report[key];
    if (typeof value === 'boolean') fields.push(`${key}=${String(value)}`);
  }
  for (const key of SAFE_COUNT_FIELDS) {
    const value = report[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      fields.push(`${key}=${value}`);
    }
  }
  if (report.errorCategory && SAFE_ERROR_CATEGORIES.has(report.errorCategory)) {
    fields.push(`error=${report.errorCategory}`);
  }
  return fields.join(' ');
}

export function acceptanceExitCode(reports: readonly SafeReport[]): 0 | 1 {
  return reports.some((report) => report.outcome === 'FAIL') ? 1 : 0;
}

interface SseFrame {
  event: string;
  data: string;
}

async function collectSseFrames(
  chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
    event = 'message';
    data = [];
  };

  const consumeLine = (lineWithPossibleCr: string) => {
    const line = lineWithPossibleCr.endsWith('\r')
      ? lineWithPossibleCr.slice(0, -1)
      : lineWithPossibleCr;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'data') data.push(value);
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  dispatch();
  return frames;
}

export async function parseJsonSse(
  chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
): Promise<unknown[]> {
  const frames = await collectSseFrames(chunks);
  const events: unknown[] = [];
  for (const frame of frames) {
    if (frame.event === 'close' && frame.data === '{}') continue;
    try {
      events.push(JSON.parse(frame.data));
    } catch {
      fail('invalid-sse');
    }
  }
  return events;
}

export function validateOutlineEvents(events: readonly unknown[]): {
  eventCount: number;
  outlineCount: number;
  incremental: true;
  completed: true;
} {
  let outlineIds: string[] = [];
  let completed = false;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === 'retry') {
      outlineIds = [];
      completed = false;
    } else if (event.type === 'error') {
      fail('upstream');
    } else if (event.type === 'outline') {
      if (completed || !isValidOutline(event.data)) fail('invalid-sse');
      if (outlineIds.includes(event.data.id)) fail('invalid-sse');
      outlineIds.push(event.data.id);
    } else if (event.type === 'done') {
      if (
        completed ||
        outlineIds.length < 1 ||
        !Array.isArray(event.outlines) ||
        event.outlines.length !== outlineIds.length ||
        !event.outlines.every(isValidOutline) ||
        !event.outlines.every((outline, index) => outline.id === outlineIds[index])
      ) {
        fail('invalid-sse');
      }
      completed = true;
    }
  }
  if (!completed || outlineIds.length < 1) fail('invalid-sse');
  return {
    eventCount: events.length,
    outlineCount: outlineIds.length,
    incremental: true,
    completed: true,
  };
}

function isValidOutline(value: unknown): value is Record<string, unknown> & { id: string } {
  return Boolean(
    isRecord(value) &&
    typeof value.id === 'string' &&
    SAFE_MODEL_ID.test(value.id) &&
    (value.type === 'slide' ||
      value.type === 'quiz' ||
      value.type === 'interactive' ||
      value.type === 'pbl') &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    typeof value.description === 'string' &&
    Array.isArray(value.keyPoints) &&
    value.keyPoints.every((point) => typeof point === 'string') &&
    Number.isSafeInteger(value.order),
  );
}

function assistantTextPresent(event: Record<string, unknown>): boolean {
  if (event.type !== 'message_update' && event.type !== 'message_end') {
    return false;
  }
  const message = isRecord(event.message) ? event.message : undefined;
  if (message?.role !== 'assistant') return false;
  const streamEvent = isRecord(event.assistantMessageEvent)
    ? event.assistantMessageEvent
    : undefined;
  if (typeof streamEvent?.delta === 'string' && streamEvent.delta.length > 0) return true;
  if (typeof message.content === 'string') return message.content.length > 0;
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (part) => isRecord(part) && typeof part.text === 'string' && part.text.length > 0,
    )
  );
}

export function validateEditorEvents(events: readonly unknown[]): {
  eventCount: number;
  toolCallCount: number;
  toolCalled: true;
  toolCompleted: true;
  assistantContinued: true;
} {
  const calls = new Map<string, number>();
  let completionIndex = -1;
  let postToolTurnStarted = false;
  let assistantContinued = false;
  let agentEnded = false;

  events.forEach((event, index) => {
    if (!isRecord(event)) return;
    if (
      event.type === 'tool_execution_start' &&
      event.toolName === 'read_scene_content' &&
      typeof event.toolCallId === 'string'
    ) {
      calls.set(event.toolCallId, index);
      return;
    }
    if (
      event.type === 'tool_execution_end' &&
      event.toolName === 'read_scene_content' &&
      typeof event.toolCallId === 'string' &&
      event.isError === false &&
      (calls.get(event.toolCallId) ?? Number.POSITIVE_INFINITY) < index
    ) {
      completionIndex = index;
      postToolTurnStarted = false;
      return;
    }
    if (completionIndex >= 0 && index > completionIndex && event.type === 'turn_start') {
      postToolTurnStarted = true;
      return;
    }
    if (
      postToolTurnStarted &&
      completionIndex >= 0 &&
      index > completionIndex &&
      assistantTextPresent(event)
    ) {
      assistantContinued = true;
    }
    if (event.type === 'agent_end') agentEnded = true;
  });

  if (calls.size < 1 || completionIndex < 0 || !assistantContinued || !agentEnded) {
    fail('invalid-sse');
  }
  return {
    eventCount: events.length,
    toolCallCount: calls.size,
    toolCalled: true,
    toolCompleted: true,
    assistantContinued: true,
  };
}

export function validateCodexCatalog(value: unknown): {
  modelId: string;
  modelCount: number;
  fastModelCount: number;
  priorityAdvertised: boolean;
} {
  if (!isRecord(value) || value.success !== true || !isRecord(value.providers)) {
    fail('invalid-shape');
  }
  const provider = value.providers['openai-codex'];
  if (
    !isRecord(provider) ||
    !exactKeys(provider, ['models', 'fastModels', 'modelCatalog']) ||
    !Array.isArray(provider.models) ||
    !Array.isArray(provider.fastModels)
  ) {
    fail('invalid-shape');
  }
  const rebuilt = rebuildCodexModelCatalog(provider.modelCatalog);
  if (!rebuilt || !jsonEqual(provider.modelCatalog, rebuilt)) fail('invalid-shape');
  const modelIds = provider.models;
  const fastModelIds = provider.fastModels;
  if (
    !modelIds.every((id): id is string => typeof id === 'string' && SAFE_MODEL_ID.test(id)) ||
    !fastModelIds.every((id): id is string => typeof id === 'string' && SAFE_MODEL_ID.test(id)) ||
    !jsonEqual(
      modelIds,
      rebuilt.map((model) => model.id),
    )
  ) {
    fail('invalid-shape');
  }
  const priorityModels = rebuilt
    .filter((model) => model.capabilities?.serviceTiers?.includes('priority'))
    .map((model) => model.id);
  if (!jsonEqual(fastModelIds, priorityModels)) fail('invalid-shape');
  const selected = rebuilt.find((model) => priorityModels.includes(model.id)) ?? rebuilt[0];
  if (!selected || !SAFE_MODEL_ID.test(selected.id)) fail('invalid-shape');
  return {
    modelId: selected.id,
    modelCount: rebuilt.length,
    fastModelCount: priorityModels.length,
    priorityAdvertised: priorityModels.includes(selected.id),
  };
}

export function validateVerificationJson(value: unknown): { generated: true } {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['success', 'message', 'response']) ||
    value.success !== true ||
    typeof value.message !== 'string' ||
    typeof value.response !== 'string' ||
    value.response.length < 1
  ) {
    fail('invalid-shape');
  }
  return { generated: true };
}

export function validateSceneJson(value: unknown): {
  json: true;
  simpleScene: true;
  sceneCount: 1;
} {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['success', 'content', 'effectiveOutline']) ||
    value.success !== true ||
    !isRecord(value.content)
  ) {
    fail('invalid-shape');
  }
  const canvas = isRecord(value.content.canvas) ? value.content.canvas : undefined;
  if (
    value.content.type !== 'slide' ||
    !canvas ||
    !Array.isArray(canvas.elements) ||
    canvas.elements.length < 1 ||
    !canvas.elements.every(
      (element) =>
        isRecord(element) && typeof element.id === 'string' && typeof element.type === 'string',
    ) ||
    !isRecord(value.effectiveOutline) ||
    value.effectiveOutline.type !== 'slide' ||
    value.effectiveOutline.id !== 'acceptance-outline'
  ) {
    fail('invalid-shape');
  }
  return { json: true, simpleScene: true, sceneCount: 1 };
}

function errorCategoryForStatus(status: number): SafeErrorCategory {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'unavailable';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'upstream';
  return 'http';
}

function safeFailure(stage: string, error: unknown, modelId?: string): SafeReport {
  const safe = error instanceof SafeAcceptanceError ? error : new SafeAcceptanceError('unexpected');
  return {
    outcome: 'FAIL',
    stage,
    ...(safeModelId(modelId) ? { modelId } : {}),
    ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}),
    errorCategory: safe.category,
  };
}

async function safeFetch(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      // Never replay an access code, session cookie, or generation payload to
      // a redirect target. The configured origin is the full trust boundary.
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail('network');
  }
}

async function requireJson(response: Response): Promise<unknown> {
  if (!response.ok) fail(errorCategoryForStatus(response.status), response.status);
  try {
    return await response.json();
  } catch {
    fail('invalid-json', response.status);
  }
}

function headers(cookie?: string, extra?: HeadersInit): Headers {
  const result = new Headers(extra);
  if (cookie) result.set('cookie', cookie);
  return result;
}

function accessCookie(response: Response): string {
  const raw = response.headers.get('set-cookie');
  const match = raw?.match(/(?:^|,\s*)openmaic_access=([^;,\s]+)/);
  if (!match || match[1].length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(match[1])) {
    fail('invalid-shape', response.status);
  }
  return `openmaic_access=${match[1]}`;
}

function validateAccessStatus(
  value: unknown,
  expectedAuthenticated?: boolean,
): {
  enabled: boolean;
  authenticated: boolean;
} {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['success', 'enabled', 'authenticated']) ||
    value.success !== true ||
    typeof value.enabled !== 'boolean' ||
    typeof value.authenticated !== 'boolean' ||
    (expectedAuthenticated !== undefined && value.authenticated !== expectedAuthenticated)
  ) {
    fail('invalid-shape');
  }
  return { enabled: value.enabled, authenticated: value.authenticated };
}

async function establishAccess(
  options: AcceptanceOptions,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<{ cookie?: string; report: SafeReport }> {
  const statusResponse = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/access-code/status`,
    { method: 'GET', cache: 'no-store' },
    timeoutMs,
  );
  const status = validateAccessStatus(await requireJson(statusResponse));
  if (!status.enabled) {
    return {
      report: {
        outcome: 'PASS',
        stage: 'access-session',
        httpStatus: statusResponse.status,
        authenticated: true,
      },
    };
  }
  if (!options.accessCode) fail('auth');

  const verifyResponse = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/access-code/verify`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: options.accessCode }),
      cache: 'no-store',
    },
    timeoutMs,
  );
  const verify = await requireJson(verifyResponse);
  if (!isRecord(verify) || verify.success !== true || verify.valid !== true) {
    fail('invalid-shape', verifyResponse.status);
  }
  const cookie = accessCookie(verifyResponse);
  const confirmationResponse = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/access-code/status`,
    { method: 'GET', headers: headers(cookie), cache: 'no-store' },
    timeoutMs,
  );
  validateAccessStatus(await requireJson(confirmationResponse), true);
  return {
    cookie,
    report: {
      outcome: 'PASS',
      stage: 'access-session',
      httpStatus: confirmationResponse.status,
      authenticated: true,
    },
  };
}

function validateAuthStatus(
  value: unknown,
  expectSignedOut: boolean,
): {
  available: true;
  connected: boolean;
} {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      typeof value.email === 'string'
        ? ['available', 'reason', 'methods', 'connected', 'email']
        : ['available', 'reason', 'methods', 'connected'],
    ) ||
    value.available !== true ||
    value.reason !== 'AVAILABLE' ||
    !Array.isArray(value.methods) ||
    !value.methods.every((method) => method === 'browser' || method === 'device') ||
    typeof value.connected !== 'boolean' ||
    value.connected === expectSignedOut ||
    (value.connected === false && Object.prototype.hasOwnProperty.call(value, 'email'))
  ) {
    fail('invalid-shape');
  }
  return { available: true, connected: value.connected };
}

async function responseEvents(response: Response): Promise<unknown[]> {
  if (!response.ok) fail(errorCategoryForStatus(response.status), response.status);
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    fail('invalid-sse', response.status);
  }
  if (!response.body) fail('invalid-sse', response.status);
  const reader = response.body.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }
  return parseJsonSse(chunks());
}

const ACCEPTANCE_REQUIREMENT =
  'Create exactly one short slide explaining that 2 + 2 = 4. Do not use images, video, quizzes, or interactive content.';

function modelHeaders(modelId: string, cookie?: string, priority = false): Headers {
  return headers(cookie, {
    'content-type': 'application/json',
    'x-model': `openai-codex:${modelId}`,
    'x-user-locale': 'en-US',
    ...(priority ? { 'x-service-tier': 'priority' } : {}),
  });
}

async function runOutlineRequest(
  options: AcceptanceOptions,
  fetcher: Fetcher,
  timeoutMs: number,
  cookie: string | undefined,
  modelId: string,
  priority: boolean,
): Promise<{ httpStatus: number; metrics: ReturnType<typeof validateOutlineEvents> }> {
  const response = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/generate/scene-outlines-stream`,
    {
      method: 'POST',
      headers: modelHeaders(modelId, cookie, priority),
      body: JSON.stringify({
        requirements: {
          requirement: ACCEPTANCE_REQUIREMENT,
          interactiveMode: false,
          taskEngineMode: false,
        },
        ...(priority ? { serviceTier: 'priority' } : {}),
      }),
      cache: 'no-store',
    },
    timeoutMs,
  );
  return {
    httpStatus: response.status,
    metrics: validateOutlineEvents(await responseEvents(response)),
  };
}

export async function runCodexAcceptance(
  options: AcceptanceOptions,
  dependencies: AcceptanceDependencies = {},
): Promise<SafeReport[]> {
  const fetcher = dependencies.fetcher ?? fetch;
  const timeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reports: SafeReport[] = [];

  let cookie: string | undefined;
  try {
    const access = await establishAccess(options, fetcher, timeoutMs);
    cookie = access.cookie;
    reports.push(access.report);
  } catch (error) {
    reports.push(safeFailure('access-session', error));
    return reports;
  }

  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/codex/auth`,
      { method: 'GET', headers: headers(cookie), cache: 'no-store' },
      timeoutMs,
    );
    const auth = validateAuthStatus(await requireJson(response), options.expectSignedOut);
    reports.push({
      outcome: 'PASS',
      stage: 'auth',
      httpStatus: response.status,
      available: auth.available,
      connected: auth.connected,
    });
  } catch (error) {
    reports.push(safeFailure('auth', error));
    return reports;
  }

  if (options.expectSignedOut) {
    try {
      const response = await safeFetch(
        fetcher,
        `${options.baseUrl}/api/server-providers`,
        { method: 'GET', headers: headers(cookie), cache: 'no-store' },
        timeoutMs,
      );
      const body = await requireJson(response);
      if (
        !isRecord(body) ||
        body.success !== true ||
        !isRecord(body.providers) ||
        Object.prototype.hasOwnProperty.call(body.providers, 'openai-codex')
      ) {
        fail('invalid-shape', response.status);
      }
      reports.push({
        outcome: 'PASS',
        stage: 'signed-out-provider',
        httpStatus: response.status,
        providerPresent: false,
      });
    } catch (error) {
      reports.push(safeFailure('signed-out-provider', error));
    }
    return reports;
  }

  let catalog: ReturnType<typeof validateCodexCatalog>;
  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/server-providers`,
      { method: 'GET', headers: headers(cookie), cache: 'no-store' },
      timeoutMs,
    );
    catalog = validateCodexCatalog(await requireJson(response));
    reports.push({
      outcome: 'PASS',
      stage: 'catalog',
      modelId: catalog.modelId,
      httpStatus: response.status,
      catalogStrict: true,
      priorityAdvertised: catalog.priorityAdvertised,
      modelCount: catalog.modelCount,
      fastModelCount: catalog.fastModelCount,
    });
  } catch (error) {
    reports.push(safeFailure('catalog', error));
    return reports;
  }

  const modelId = catalog.modelId;
  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/verify-model`,
      {
        method: 'POST',
        headers: headers(cookie, { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: `openai-codex:${modelId}` }),
        cache: 'no-store',
      },
      timeoutMs,
    );
    const metrics = validateVerificationJson(await requireJson(response));
    reports.push({
      outcome: 'PASS',
      stage: 'verify-normal',
      modelId,
      httpStatus: response.status,
      ...metrics,
    });
  } catch (error) {
    reports.push(safeFailure('verify-normal', error, modelId));
  }

  if (catalog.priorityAdvertised) {
    try {
      const response = await safeFetch(
        fetcher,
        `${options.baseUrl}/api/verify-model`,
        {
          method: 'POST',
          headers: headers(cookie, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            model: `openai-codex:${modelId}`,
            serviceTier: 'priority',
          }),
          cache: 'no-store',
        },
        timeoutMs,
      );
      const metrics = validateVerificationJson(await requireJson(response));
      reports.push({
        outcome: 'PASS',
        stage: 'fast',
        modelId,
        httpStatus: response.status,
        priorityAdvertised: true,
        ...metrics,
      });
    } catch (error) {
      reports.push(safeFailure('fast', error, modelId));
    }
  } else {
    reports.push({
      outcome: 'SKIP',
      stage: 'fast',
      modelId,
      priorityAdvertised: false,
    });
  }

  try {
    const outline = await runOutlineRequest(options, fetcher, timeoutMs, cookie, modelId, false);
    reports.push({
      outcome: 'PASS',
      stage: 'outline-stream',
      modelId,
      httpStatus: outline.httpStatus,
      streaming: true,
      ...outline.metrics,
    });
  } catch (error) {
    reports.push(safeFailure('outline-stream', error, modelId));
  }

  const acceptanceOutline = {
    id: 'acceptance-outline',
    type: 'slide',
    title: 'Two plus two',
    description: 'Show that 2 + 2 = 4.',
    keyPoints: ['2 + 2 = 4'],
    order: 0,
  };
  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/generate/scene-content`,
      {
        method: 'POST',
        headers: modelHeaders(modelId, cookie),
        body: JSON.stringify({
          outline: acceptanceOutline,
          allOutlines: [acceptanceOutline],
          stageInfo: { name: 'Codex acceptance', style: 'professional' },
          stageId: 'codex-acceptance',
          languageDirective: 'Teach in English.',
          requirements: { requirement: ACCEPTANCE_REQUIREMENT },
        }),
        cache: 'no-store',
      },
      timeoutMs,
    );
    const metrics = validateSceneJson(await requireJson(response));
    reports.push({
      outcome: 'PASS',
      stage: 'scene-json',
      modelId,
      httpStatus: response.status,
      ...metrics,
    });
  } catch (error) {
    reports.push(safeFailure('scene-json', error, modelId));
  }

  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/agent/edit`,
      {
        method: 'POST',
        headers: modelHeaders(modelId, cookie),
        body: JSON.stringify({
          sessionId: `acceptance-${randomUUID()}`,
          message:
            'Call read_scene_content exactly once for the current scene, then provide a brief confirmation after the tool completes.',
          scene: { id: 'acceptance-scene', title: 'Two plus two' },
          history: [],
          sceneContextMap: {
            'acceptance-scene': {
              outline: acceptanceOutline,
              allOutlines: [acceptanceOutline],
              stageId: 'codex-acceptance',
              content: {
                type: 'slide',
                canvas: {
                  id: 'acceptance-canvas',
                  viewportSize: 1000,
                  viewportRatio: 0.5625,
                  elements: [
                    {
                      id: 'acceptance-text',
                      type: 'text',
                      left: 80,
                      top: 80,
                      width: 840,
                      height: 120,
                      rotate: 0,
                      content: '<p>2 + 2 = 4</p>',
                      defaultFontName: 'Arial',
                      defaultColor: '#000000',
                    },
                  ],
                },
              },
            },
          },
        }),
        cache: 'no-store',
      },
      timeoutMs,
    );
    if (response.status === 404) {
      reports.push({
        outcome: 'SKIP',
        stage: 'editor-tools',
        modelId,
        httpStatus: 404,
        editorEnabled: false,
      });
    } else {
      const metrics = validateEditorEvents(await responseEvents(response));
      reports.push({
        outcome: 'PASS',
        stage: 'editor-tools',
        modelId,
        httpStatus: response.status,
        editorEnabled: true,
        ...metrics,
      });
    }
  } catch (error) {
    reports.push(safeFailure('editor-tools', error, modelId));
  }

  return reports;
}
