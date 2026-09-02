import type {
  CodexAuthRouteError,
  CodexAuthRouteErrorCode,
  CodexOAuthAvailabilityReason,
} from '@/lib/types/codex-auth';

import { readAccessTokenCookie, verifyAccessToken } from '../access-token';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export function isCodexRouteAuthorized(request: Request): boolean {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) return true;
  const token = readAccessTokenCookie(request);
  return Boolean(token && verifyAccessToken(token, accessCode));
}

export function codexJson<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

export function codexRouteError(
  errorCode: CodexAuthRouteErrorCode,
  status: number,
  reason?: CodexOAuthAvailabilityReason,
): Response {
  const body: CodexAuthRouteError = {
    errorCode,
    ...(reason ? { reason } : {}),
  };
  return codexJson(body, status);
}

export function requireCodexRouteAccess(request: Request): Response | null {
  return isCodexRouteAuthorized(request) ? null : codexRouteError('UNAUTHORIZED', 401);
}
