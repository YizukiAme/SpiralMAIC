import type { CodexAuthPublicStatus } from '@/lib/types/codex-auth';
import { getCodexOAuthAvailability } from '@/lib/server/codex/availability';
import { getCodexAuthRuntime } from '@/lib/server/codex/runtime';
import {
  codexJson,
  codexRouteError,
  requireCodexRouteAccess,
} from '@/lib/server/codex/route-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = requireCodexRouteAccess(request);
  if (denied) return denied;

  const availability = await getCodexOAuthAvailability();
  if (!availability.available) {
    return codexJson({
      available: false,
      reason: availability.reason,
      methods: [...availability.methods],
      connected: false,
    } satisfies CodexAuthPublicStatus);
  }
  try {
    const credentials = await getCodexAuthRuntime().vault.load();
    const status: CodexAuthPublicStatus = {
      available: availability.available,
      reason: availability.reason,
      methods: [...availability.methods],
      connected: credentials !== null,
      ...(credentials?.email ? { email: credentials.email } : {}),
    };
    return codexJson(status);
  } catch {
    return codexRouteError('INTERNAL_ERROR', 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireCodexRouteAccess(request);
  if (denied) return denied;

  const availability = await getCodexOAuthAvailability();
  if (!availability.available) {
    return codexRouteError('UNAVAILABLE', 503, availability.reason);
  }

  const authRuntime = getCodexAuthRuntime();
  try {
    await authRuntime.loginManager.cancel();
    await authRuntime.tokenProvider.logout();
    return codexJson({ connected: false });
  } catch {
    return codexRouteError('INTERNAL_ERROR', 500);
  }
}
