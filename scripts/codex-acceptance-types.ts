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
  editorMode: 'enabled' | 'disabled';
  accessCode?: string;
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AcceptanceDependencies {
  fetcher?: Fetcher;
  requestTimeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 310_000;
