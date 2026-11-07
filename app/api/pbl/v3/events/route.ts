import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { learningEventResponse } from '@/lib/server/pbl-v3/event-stream';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
async function GETHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) throw sandboxInvalid('A learning session is required.');
    return learningEventResponse(principal, id, request.signal);
  });
}
