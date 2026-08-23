import { describe, expect, test, vi } from 'vitest';

import {
  ACCESS_TOKEN_FUTURE_TOLERANCE_MS,
  ACCESS_TOKEN_MAX_AGE_MS,
  createAccessToken,
  verifyAccessToken,
} from '@/lib/server/access-token';

describe('access token signing', () => {
  test('verifies tokens signed with the same access code', () => {
    const now = Date.parse('2026-06-25T00:00:00Z');
    vi.setSystemTime(now);

    const token = createAccessToken('demo-code', now);

    expect(verifyAccessToken(token, 'demo-code')).toBe(true);
    expect(verifyAccessToken(token, 'other-code')).toBe(false);
    expect(verifyAccessToken('bad-token', 'demo-code')).toBe(false);

    vi.useRealTimers();
  });

  test('enforces token timestamps and the seven-day lifetime', () => {
    const now = Date.parse('2026-06-25T00:00:00Z');
    const boundary = createAccessToken('demo-code', now - ACCESS_TOKEN_MAX_AGE_MS);
    const expired = createAccessToken('demo-code', now - ACCESS_TOKEN_MAX_AGE_MS - 1);
    const toleratedFuture = createAccessToken('demo-code', now + ACCESS_TOKEN_FUTURE_TOLERANCE_MS);
    const invalidFuture = createAccessToken(
      'demo-code',
      now + ACCESS_TOKEN_FUTURE_TOLERANCE_MS + 1,
    );

    expect(verifyAccessToken(boundary, 'demo-code', { now })).toBe(true);
    expect(verifyAccessToken(expired, 'demo-code', { now })).toBe(false);
    expect(verifyAccessToken(toleratedFuture, 'demo-code', { now })).toBe(true);
    expect(verifyAccessToken(invalidFuture, 'demo-code', { now })).toBe(false);
    expect(verifyAccessToken('not-a-number.deadbeef', 'demo-code', { now })).toBe(false);
  });

  test('rejects tampering and tokens signed with a rotated access code', () => {
    const now = Date.parse('2026-06-25T00:00:00Z');
    const token = createAccessToken('old-code', now);
    const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;

    expect(verifyAccessToken(tampered, 'old-code', { now })).toBe(false);
    expect(verifyAccessToken(token, 'new-code', { now })).toBe(false);
  });
});
