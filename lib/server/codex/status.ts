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
    available: availability.available,
    reason: availability.reason,
    methods: [...availability.methods],
    authenticated: credentials !== null,
    ...(credentials?.email ? { email: credentials.email } : {}),
  };
}
