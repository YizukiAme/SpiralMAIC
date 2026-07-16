export type CodexOAuthLoginMethod = 'browser' | 'device';

export const CODEX_OAUTH_AVAILABILITY_REASONS = {
  AVAILABLE: 'AVAILABLE',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  SERVERLESS_UNSUPPORTED: 'SERVERLESS_UNSUPPORTED',
  ACCESS_CODE_REQUIRED: 'ACCESS_CODE_REQUIRED',
  DATA_DIR_UNWRITABLE: 'DATA_DIR_UNWRITABLE',
  RUNTIME_LOCKED: 'RUNTIME_LOCKED',
} as const;

export type CodexOAuthAvailabilityReason =
  (typeof CODEX_OAUTH_AVAILABILITY_REASONS)[keyof typeof CODEX_OAUTH_AVAILABILITY_REASONS];

export interface CodexOAuthAvailability {
  available: boolean;
  reason: CodexOAuthAvailabilityReason;
  methods: CodexOAuthLoginMethod[];
}

export interface CodexAuthPublicStatus extends CodexOAuthAvailability {
  connected: boolean;
  email?: string;
}

export type CodexLoginStatus = 'pending' | 'complete' | 'failed' | 'expired';

export type CodexLoginErrorCode =
  | 'BROWSER_UNAVAILABLE'
  | 'ATTEMPT_REPLACED'
  | 'INVALID_CALLBACK'
  | 'AUTHORIZATION_REJECTED'
  | 'STATE_MISMATCH'
  | 'DEVICE_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE'
  | 'STORAGE_ERROR';

export interface CodexLoginAttempt {
  method: CodexOAuthLoginMethod;
  status: CodexLoginStatus;
  errorCode?: CodexLoginErrorCode;
  authorizationUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  /** Absolute Unix time in milliseconds. */
  expiresAt?: number;
  /** Upstream polling interval in seconds. */
  interval?: number;
}

export type CodexAuthRouteErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'UNAVAILABLE'
  | 'METHOD_UNAVAILABLE'
  | 'NO_ACTIVE_ATTEMPT'
  | 'INTERNAL_ERROR';

export interface CodexAuthRouteError {
  errorCode: CodexAuthRouteErrorCode;
  reason?: CodexOAuthAvailabilityReason;
}
