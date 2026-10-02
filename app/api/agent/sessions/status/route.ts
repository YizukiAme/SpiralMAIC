import { withAccessCode } from '@/lib/server/with-access-code';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);

/** Return a sparse status map for all sessions visible to this owner. */
async function GETHandler(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const store = await getAgentSessionStore();
    const sessions = await store.listSessionsByOwner(ownerId);
    const statuses = Object.fromEntries(sessions.map((session) => [session.id, session.status]));
    return NextResponse.json(statuses, { headers: responseHeaders });
  });
}
