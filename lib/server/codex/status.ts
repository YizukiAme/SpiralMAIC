import type { CodexOAuthAvailability } from './availability';
import type { CodexOAuthCredentials } from './vault';

/** Safe to serialize to an unauthenticated settings/status response. */
export type CodexOAuthPublicStatus = CodexOAuthAvailability & {
  authenticated: boolean;
  email?: string;
};

export function toCodexOAuthPublicStatus(
  availability: CodexOAuthAvailability,
  credentials: CodexOAuthCredentials | null,
): CodexOAuthPublicStatus {
  return {
    ...availability,
    authenticated: credentials !== null,
    ...(credentials?.email ? { email: credentials.email } : {}),
  };
}
