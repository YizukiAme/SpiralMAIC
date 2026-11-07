import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const POST = withAccessCode(POSTHandler);

function GETHandler(request: Request) {
  return sandboxRoute(request, (service) => service.list());
}

function POSTHandler(request: Request) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    return service.create(body.requestId, body.workspaceId, body.profile);
  });
}
