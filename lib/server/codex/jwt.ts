export type JwtPayload = Record<string, unknown>;

export interface CodexJwtIdentity {
  accountId?: string;
  email?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Decode an already-issued JWT payload without verifying its signature.
 * This helper is only for reading claims from tokens returned by the OAuth
 * token endpoint; it must never be used to authenticate arbitrary input.
 */
export function parseJwtPayload(token: string): JwtPayload | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  const payload = segments[1];
  if (!payload || !/^[A-Za-z0-9_-]+={0,2}$/.test(payload)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractCodexJwtIdentity(token: string): CodexJwtIdentity {
  const payload = parseJwtPayload(token);
  if (!payload) return {};

  const namespacedAuth = isRecord(payload['https://api.openai.com/auth'])
    ? payload['https://api.openai.com/auth']
    : undefined;
  const namespacedProfile = isRecord(payload['https://api.openai.com/profile'])
    ? payload['https://api.openai.com/profile']
    : undefined;
  const organizations = Array.isArray(payload.organizations) ? payload.organizations : [];
  const firstOrganization = isRecord(organizations[0]) ? organizations[0] : undefined;

  const accountId =
    nonEmptyString(payload.chatgpt_account_id) ??
    nonEmptyString(namespacedAuth?.chatgpt_account_id) ??
    // Accept the flattened spelling used by a few OAuth adapters while
    // preserving the same namespaced-claim precedence.
    nonEmptyString(payload['https://api.openai.com/auth.chatgpt_account_id']) ??
    nonEmptyString(firstOrganization?.id);
  const email =
    nonEmptyString(payload.email) ??
    nonEmptyString(namespacedProfile?.email) ??
    nonEmptyString(payload['https://api.openai.com/profile.email']);

  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}
