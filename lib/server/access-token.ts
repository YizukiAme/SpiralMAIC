import { createHmac, timingSafeEqual } from 'crypto';

export const ACCESS_TOKEN_COOKIE = 'openmaic_access';
export const ACCESS_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_TOKEN_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface VerifyAccessTokenOptions {
  now?: number;
  maxAgeMs?: number;
  futureToleranceMs?: number;
}

/** Create an HMAC-signed token: `timestamp.signature` */
export function createAccessToken(accessCode: string, now = Date.now()): string {
  const timestamp = now.toString();
  const signature = createHmac('sha256', accessCode).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

/** Verify an HMAC-signed token against the access code */
export function verifyAccessToken(
  token: string,
  accessCode: string,
  options: VerifyAccessTokenOptions = {},
): boolean {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);
  if (!/^\d+$/.test(timestamp)) return false;

  const issuedAt = Number(timestamp);
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? ACCESS_TOKEN_MAX_AGE_MS;
  const futureToleranceMs = options.futureToleranceMs ?? ACCESS_TOKEN_FUTURE_TOLERANCE_MS;
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return false;
  if (issuedAt > now + futureToleranceMs || now - issuedAt > maxAgeMs) return false;

  const expected = createHmac('sha256', accessCode).update(timestamp).digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}

export function readAccessTokenCookie(request: Request): string | undefined {
  const raw = request.headers.get('cookie');
  if (!raw) return undefined;

  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== ACCESS_TOKEN_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}
