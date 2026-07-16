import type {
  AcceptanceOptions,
  AcceptanceOutcome,
  SafeErrorCategory,
  SafeReport,
} from './codex-acceptance-types';

export const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const SAFE_STAGE = /^[a-z0-9][a-z0-9-]{0,63}$/;
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

export class SafeAcceptanceError extends Error {
  constructor(
    readonly category: SafeErrorCategory,
    readonly httpStatus?: number,
  ) {
    super(category);
    this.name = 'SafeAcceptanceError';
  }
}

export function fail(category: SafeErrorCategory, httpStatus?: number): never {
  throw new SafeAcceptanceError(category, httpStatus);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = [...allowed].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function jsonEqual(left: unknown, right: unknown): boolean {
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
  let editorMode: AcceptanceOptions['editorMode'] = 'enabled';
  let editorModeSet = false;
  const startIndex = argv[0] === '--' ? 1 : 0;
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base-url') {
      if (baseUrl !== undefined || index + 1 >= argv.length) fail('argument');
      baseUrl = normalizePublicBaseUrl(argv[++index]);
    } else if (argument === '--expect-signed-out') {
      if (expectSignedOut) fail('argument');
      expectSignedOut = true;
    } else if (argument === '--editor-mode') {
      if (editorModeSet || index + 1 >= argv.length) fail('argument');
      const value = argv[++index];
      if (value !== 'enabled' && value !== 'disabled') fail('argument');
      editorMode = value;
      editorModeSet = true;
    } else {
      fail('argument');
    }
  }
  if (!baseUrl) fail('argument');
  return { baseUrl, expectSignedOut, editorMode };
}

function safeStage(value: unknown): string {
  return typeof value === 'string' && SAFE_STAGE.test(value) ? value : 'invalid';
}

export function safeModelId(value: unknown): string | undefined {
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

export function errorCategoryForStatus(status: number): SafeErrorCategory {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'unavailable';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'upstream';
  return 'http';
}

export function safeFailure(stage: string, error: unknown, modelId?: string): SafeReport {
  const safe = error instanceof SafeAcceptanceError ? error : new SafeAcceptanceError('unexpected');
  return {
    outcome: 'FAIL',
    stage,
    ...(safeModelId(modelId) ? { modelId } : {}),
    ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}),
    errorCategory: safe.category,
  };
}
