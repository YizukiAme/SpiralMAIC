import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

function exchangeOptions(
  overrides: Partial<Parameters<typeof exchangeAuthorizationCode>[0]> & {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Parameters<typeof exchangeAuthorizationCode>[0] {
  return {
    code: 'boundary-code',
    verifier: 'boundary-verifier',
    redirectUri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
    clock: { now: () => NOW },
    ...overrides,
  } as Parameters<typeof exchangeAuthorizationCode>[0];
}

function validExchangeResponse(): Response {
  return jsonResponse({
    access_token: unsignedJwt({ chatgpt_account_id: 'boundary-account' }),
    refresh_token: 'boundary-refresh',
    expires_in: 3600,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    expect(requests[0].init.redirect).toBe('error');
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

  it('rejects a token redirect without invoking its secret-bearing target', async () => {
    const redirectTarget = vi.fn(() => validExchangeResponse());
    const tokenExchangeFetch = vi.fn(async (_input: string, init: RequestInit) => {
      if (init.redirect !== 'error') return redirectTarget();
      throw new TypeError('redirect rejected');
    });

    await expect(
      exchangeAuthorizationCode(exchangeOptions({ tokenExchangeFetch })),
    ).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
      retryable: true,
    });
    expect(redirectTarget).not.toHaveBeenCalled();
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

  it('forwards a composed signal and cleans the parent listener and timeout', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const addListener = vi.spyOn(parent.signal, 'addEventListener');
    const removeListener = vi.spyOn(parent.signal, 'removeEventListener');
    let forwardedSignal: AbortSignal | undefined;

    await exchangeAuthorizationCode(
      exchangeOptions({
        signal: parent.signal,
        tokenExchangeFetch: async (_input, init) => {
          forwardedSignal = init.signal as AbortSignal;
          return validExchangeResponse();
        },
      }),
    );

    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(forwardedSignal).not.toBe(parent.signal);
    expect(forwardedSignal?.aborted).toBe(false);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a fetch that ignores abort after exactly ten seconds', async () => {
    vi.useFakeTimers();
    let forwardedSignal: AbortSignal | undefined;
    let settled = false;
    const exchange = exchangeAuthorizationCode(
      exchangeOptions({
        tokenExchangeFetch: async (_input, init) => {
          forwardedSignal = init.signal as AbortSignal;
          return new Promise<Response>(() => undefined);
        },
      }),
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void exchange.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    expect(forwardedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await exchange;
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
        retryable: true,
      },
    });
    expect(forwardedSignal?.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /auth\.openai\.com|boundary-code|boundary-verifier|boundary-refresh/,
    );
  });

  it('times out hung response JSON parsing within the same request boundary', async () => {
    vi.useFakeTimers();
    const response = validExchangeResponse();
    Object.defineProperty(response, 'json', {
      value: () => new Promise<unknown>(() => undefined),
    });
    const exchange = exchangeAuthorizationCode(
      exchangeOptions({
        timeoutMs: 25,
        tokenExchangeFetch: async () => response,
      }),
    );
    const rejection = expect(exchange).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles safely on parent abort even when fetch ignores its signal', async () => {
    const parent = new AbortController();
    let forwardedSignal: AbortSignal | undefined;
    const exchange = exchangeAuthorizationCode(
      exchangeOptions({
        signal: parent.signal,
        tokenExchangeFetch: async (_input, init) => {
          forwardedSignal = init.signal as AbortSignal;
          return new Promise<Response>(() => undefined);
        },
      }),
    );
    const rejection = expect(exchange).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
      retryable: true,
    });

    parent.abort();

    await rejection;
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it('does not start an OAuth operation when the parent is already aborted', async () => {
    const parent = new AbortController();
    parent.abort();
    const tokenExchangeFetch = vi.fn(async () => validExchangeResponse());

    await expect(
      exchangeAuthorizationCode(exchangeOptions({ signal: parent.signal, tokenExchangeFetch })),
    ).rejects.toMatchObject({
      code: CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR,
      retryable: true,
    });
    expect(tokenExchangeFetch).not.toHaveBeenCalled();
  });
});
