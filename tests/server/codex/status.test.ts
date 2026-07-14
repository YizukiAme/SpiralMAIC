import { describe, expect, it } from 'vitest';

import {
  CODEX_OAUTH_AVAILABILITY_REASONS,
  type CodexOAuthAvailability,
} from '@/lib/server/codex/availability';
import { toCodexOAuthPublicStatus } from '@/lib/server/codex/status';
import type { CodexOAuthCredentials } from '@/lib/server/codex/vault';

const availability: CodexOAuthAvailability = {
  available: true,
  reason: CODEX_OAUTH_AVAILABILITY_REASONS.AVAILABLE,
  methods: ['device'],
};

const credentials: CodexOAuthCredentials = {
  version: 1,
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: 1_800_000_000_000,
  accountId: 'account-secret',
  email: 'user@example.com',
  updatedAt: 1_700_000_000_000,
};

describe('toCodexOAuthPublicStatus', () => {
  it('reports connection state and email without exposing credential material', () => {
    const status = toCodexOAuthPublicStatus(availability, credentials);

    expect(status).toEqual({
      ...availability,
      authenticated: true,
      email: 'user@example.com',
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('access-secret');
    expect(serialized).not.toContain('refresh-secret');
    expect(serialized).not.toContain('account-secret');
    expect(status).not.toHaveProperty('accessToken');
    expect(status).not.toHaveProperty('refreshToken');
    expect(status).not.toHaveProperty('accountId');
  });

  it('reports signed-out state without an email when credentials are missing', () => {
    expect(toCodexOAuthPublicStatus(availability, null)).toEqual({
      ...availability,
      authenticated: false,
    });
  });
});
