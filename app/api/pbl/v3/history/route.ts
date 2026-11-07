import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { conversationPage } from '@/lib/server/pbl-v3/conversation-page';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
async function GETHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) =>
    Response.json(await conversationPage(principal, new URL(request.url).searchParams)),
  );
}
