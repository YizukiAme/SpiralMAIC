import { describe, expect, it } from 'vitest';

import { extractCodexJwtIdentity, parseJwtPayload } from '@/lib/server/codex/jwt';

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.not-verified`;
}

describe('parseJwtPayload', () => {
  it('parses payload claims without treating the signature as verified', () => {
    expect(parseJwtPayload(unsignedJwt({ sub: 'subject-1' }))).toEqual({ sub: 'subject-1' });
  });

  it.each(['', 'not-a-jwt', 'a.%%%.c', 'a.b.c', 'a.W10.c'])(
    'safely rejects malformed or non-object token %j',
    (token) => {
      expect(parseJwtPayload(token)).toBeNull();
    },
  );
});

describe('extractCodexJwtIdentity', () => {
  it('prefers chatgpt_account_id over every fallback', () => {
    const token = unsignedJwt({
      chatgpt_account_id: 'direct-account',
      'https://api.openai.com/auth': { chatgpt_account_id: 'namespaced-account' },
      organizations: [{ id: 'organization-account' }],
      email: 'user@example.com',
    });

    expect(extractCodexJwtIdentity(token)).toEqual({
      accountId: 'direct-account',
      email: 'user@example.com',
    });
  });

  it('falls back to the namespaced auth claim', () => {
    const token = unsignedJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'namespaced-account' },
      organizations: [{ id: 'organization-account' }],
    });

    expect(extractCodexJwtIdentity(token)).toEqual({ accountId: 'namespaced-account' });
  });

  it('finally falls back to organizations[0].id and keeps email optional', () => {
    const token = unsignedJwt({ organizations: [{ id: 'organization-account' }] });

    expect(extractCodexJwtIdentity(token)).toEqual({ accountId: 'organization-account' });
    expect(extractCodexJwtIdentity(unsignedJwt({ sub: 'no-account' }))).toEqual({});
  });

  it('falls back from top-level email to the namespaced profile email', () => {
    const token = unsignedJwt({
      chatgpt_account_id: 'account-123',
      'https://api.openai.com/profile': { email: 'profile@example.com' },
    });

    expect(extractCodexJwtIdentity(token)).toEqual({
      accountId: 'account-123',
      email: 'profile@example.com',
    });
  });
});
