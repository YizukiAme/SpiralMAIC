import { createHash, randomBytes as secureRandomBytes } from 'node:crypto';

import { readBoundedJson } from './bounded-json';
import { extractCodexJwtIdentity, parseJwtPayload } from './jwt';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ERROR_CODES,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  CodexOAuthError,
  type CodexClock,
  type TokenExchangeFetch,
  withCodexOAuthRequestTimeout,
} from './token-provider';
import type { CodexOAuthCredentials } from './vault';

export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_OAUTH_AUTHORIZE_ENDPOINT = `${CODEX_OAUTH_ISSUER}/oauth/authorize`;
export const CODEX_OAUTH_BROWSER_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_OAUTH_DEVICE_VERIFICATION_URL = `${CODEX_OAUTH_ISSUER}/codex/device`;
export const CODEX_OAUTH_DEVICE_USERCODE_ENDPOINT = `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_OAUTH_DEVICE_TOKEN_ENDPOINT = `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_OAUTH_DEVICE_REDIRECT_URI = `${CODEX_OAUTH_ISSUER}/deviceauth/callback`;

interface BrowserAuthorizationOptions {
  randomBytes?: (size: number) => Buffer;
}

export interface BrowserAuthorization {
  authorizationUrl: string;
  verifier: string;
  state: string;
}

interface AuthorizationCodeExchangeOptions {
  code: string;
  verifier: string;
  redirectUri: string;
  tokenExchangeFetch?: TokenExchangeFetch;
  clock?: CodexClock;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createBrowserAuthorization(
  options: BrowserAuthorizationOptions = {},
): BrowserAuthorization {
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createPkceChallenge(verifier);
  const url = new URL(CODEX_OAUTH_AUTHORIZE_ENDPOINT);

  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'openmaic',
  }).toString();

  return { authorizationUrl: url.toString(), verifier, state };
}

export function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function exchangeAuthorizationCode(
  options: AuthorizationCodeExchangeOptions,
): Promise<CodexOAuthCredentials> {
  const tokenExchangeFetch = options.tokenExchangeFetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? { now: Date.now };
  try {
    return await withCodexOAuthRequestTimeout(
      async (signal) => {
        const response = await tokenExchangeFetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CODEX_OAUTH_CLIENT_ID,
            code: options.code,
            redirect_uri: options.redirectUri,
            code_verifier: options.verifier,
          }),
          redirect: 'error',
          signal,
        });
        if (!response.ok) {
          throw new CodexOAuthError(
            CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR,
            response.status >= 500,
            response.status,
          );
        }

        const json = await readBoundedJson(response, signal);
        if (!json.ok) {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false);
        }
        const payload = json.payload;
        if (!isRecord(payload)) {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false);
        }

        const accessToken = nonEmptyString(payload.access_token);
        const refreshToken = nonEmptyString(payload.refresh_token);
        const expiresIn = Number(payload.expires_in);
        const idToken = nonEmptyString(payload.id_token);
        const idIdentity = idToken ? extractCodexJwtIdentity(idToken) : {};
        const accessIdentity = accessToken ? extractCodexJwtIdentity(accessToken) : {};
        const identity = {
          accountId: idIdentity.accountId ?? accessIdentity.accountId,
          email: idIdentity.email ?? accessIdentity.email,
        };
        const now = clock.now();
        const accessTokenExpiry = accessToken
          ? Number(parseJwtPayload(accessToken)?.exp) * 1000
          : NaN;
        const expiresAt =
          Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : accessTokenExpiry;
        if (!accessToken || !refreshToken || !Number.isFinite(expiresAt) || expiresAt <= now) {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false);
        }
        if (!identity.accountId) {
          throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE, false);
        }

        return {
          version: 1,
          accessToken,
          refreshToken,
          expiresAt,
          accountId: identity.accountId,
          ...(identity.email ? { email: identity.email } : {}),
          updatedAt: now,
        };
      },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
  } catch (error) {
    if (error instanceof CodexOAuthError) throw error;
    throw new CodexOAuthError(CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR, true);
  }
}
