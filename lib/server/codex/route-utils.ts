import type {
  CodexAuthRouteError,
  CodexAuthRouteErrorCode,
  CodexOAuthAvailabilityReason,
} from '@/lib/types/codex-auth';

import { verifyAccessToken } from '../access-token';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function isCodexRouteAuthorized(request: Request): boolean {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) return true;
  const token = cookieValue(request, 'openmaic_access');
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
