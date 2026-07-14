import type { CodexOAuthLoginMethod } from '@/lib/types/codex-auth';
import { getCodexOAuthAvailability } from '@/lib/server/codex/availability';
import { getCodexAuthRuntime } from '@/lib/server/codex/runtime';
import {
  codexJson,
  codexRouteError,
  requireCodexRouteAccess,
} from '@/lib/server/codex/route-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isLoginMethod(value: unknown): value is CodexOAuthLoginMethod {
  return value === 'browser' || value === 'device';
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireCodexRouteAccess(request);
  if (denied) return denied;

  const availability = await getCodexOAuthAvailability();
  if (!availability.available) {
    return codexRouteError('UNAVAILABLE', 503, availability.reason);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return codexRouteError('INVALID_REQUEST', 400);
  }
  const method =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).method
      : undefined;
  if (!isLoginMethod(method)) return codexRouteError('INVALID_REQUEST', 400);
  if (!availability.methods.includes(method)) {
    return codexRouteError('METHOD_UNAVAILABLE', 400);
  }

  try {
    return codexJson(await getCodexAuthRuntime().loginManager.begin(method));
  } catch {
    return codexRouteError('INTERNAL_ERROR', 500);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const denied = requireCodexRouteAccess(request);
  if (denied) return denied;

  const availability = await getCodexOAuthAvailability();
  if (!availability.available) {
    return codexRouteError('UNAVAILABLE', 503, availability.reason);
  }
  try {
    const runtime = getCodexAuthRuntime();
    const attempt = await runtime.loginManager.poll();
    if (attempt?.status === 'complete') runtime.modelDiscovery.invalidate();
    return attempt ? codexJson(attempt) : codexRouteError('NO_ACTIVE_ATTEMPT', 404);
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

  try {
    await getCodexAuthRuntime().loginManager.cancel();
    return codexJson({ cancelled: true });
  } catch {
    return codexRouteError('INTERNAL_ERROR', 500);
  }
}
