import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CODEX_OAUTH_AUTHORIZE_ENDPOINT,
  CODEX_OAUTH_BROWSER_REDIRECT_URI,
  exchangeAuthorizationCode,
  createBrowserAuthorization,
} from '@/lib/server/codex/oauth';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ERROR_CODES,
  CODEX_OAUTH_TOKEN_ENDPOINT,
} from '@/lib/server/codex/token-provider';

const NOW = 1_700_000_000_000;

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.oauth-output`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Codex OAuth authorization helpers', () => {
  it('creates PKCE S256 and the exact browser authorization request', () => {
    const verifierBytes = Buffer.alloc(32, 0x11);
    const stateBytes = Buffer.alloc(32, 0x22);
    const randomValues = [verifierBytes, stateBytes];

    const authorization = createBrowserAuthorization({
      randomBytes: () => randomValues.shift()!,
    });

    const expectedVerifier = verifierBytes.toString('base64url');
    const expectedState = stateBytes.toString('base64url');
    const expectedChallenge = createHash('sha256').update(expectedVerifier).digest('base64url');
    const url = new URL(authorization.authorizationUrl);

    expect(url.origin + url.pathname).toBe(CODEX_OAUTH_AUTHORIZE_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CODEX_OAUTH_CLIENT_ID,
      redirect_uri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
      scope: 'openid profile email offline_access',
      code_challenge: expectedChallenge,
      code_challenge_method: 'S256',
      state: expectedState,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'openmaic',
    });
    expect(authorization.verifier).toBe(expectedVerifier);
    expect(authorization.state).toBe(expectedState);
  });

  it('exchanges a browser code as form data and normalizes credentials without the ID token', async () => {
    const accessToken = unsignedJwt({
      chatgpt_account_id: 'access-account',
      email: 'access@example.com',
    });
    const idToken = unsignedJwt({
      chatgpt_account_id: 'id-account',
      email: 'id@example.com',
    });
    const requests: Array<{ input: string; init: RequestInit }> = [];

    const credentials = await exchangeAuthorizationCode({
      code: 'browser-code',
      verifier: 'browser-verifier',
      redirectUri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
      clock: { now: () => NOW },
      tokenExchangeFetch: async (input, init) => {
        requests.push({ input, init });
        return jsonResponse({
          access_token: accessToken,
          refresh_token: 'refresh-token',
          expires_in: '3600',
          id_token: idToken,
        });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBe(CODEX_OAUTH_TOKEN_ENDPOINT);
    expect(requests[0].init.method).toBe('POST');
    expect(requests[0].init.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(Object.fromEntries(requests[0].init.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH_CLIENT_ID,
      code: 'browser-code',
      redirect_uri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
      code_verifier: 'browser-verifier',
    });
    expect(credentials).toEqual({
      version: 1,
      accessToken,
      refreshToken: 'refresh-token',
      expiresAt: NOW + 3_600_000,
      accountId: 'id-account',
      email: 'id@example.com',
      updatedAt: NOW,
    });
    expect(JSON.stringify(credentials)).not.toContain(idToken);
  });

  it('falls back to access-token identity and JWT expiry when expires_in is absent', async () => {
    const expiresAt = NOW + 900_000;
    const accessToken = unsignedJwt({
      chatgpt_account_id: 'access-account',
      email: 'access@example.com',
      exp: expiresAt / 1000,
    });

    const credentials = await exchangeAuthorizationCode({
      code: 'device-code',
      verifier: 'device-verifier',
      redirectUri: 'https://auth.openai.com/deviceauth/callback',
      clock: { now: () => NOW },
      tokenExchangeFetch: async () =>
        jsonResponse({
          access_token: accessToken,
          refresh_token: 'device-refresh',
        }),
    });

    expect(credentials).toMatchObject({
      accessToken,
      refreshToken: 'device-refresh',
      expiresAt,
      accountId: 'access-account',
      email: 'access@example.com',
    });
  });

  it('requires a refresh token on initial login', async () => {
    const accessToken = unsignedJwt({
      chatgpt_account_id: 'access-account',
      exp: (NOW + 900_000) / 1000,
    });

    await expect(
      exchangeAuthorizationCode({
        code: 'browser-code',
        verifier: 'browser-verifier',
        redirectUri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
        clock: { now: () => NOW },
        tokenExchangeFetch: async () => jsonResponse({ access_token: accessToken }),
      }),
    ).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE,
      retryable: false,
    });
  });
});
