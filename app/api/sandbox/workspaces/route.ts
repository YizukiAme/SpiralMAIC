import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxRoute, sandboxBody } from '@/lib/server/sandbox/http';
export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const DELETE = withAccessCode(DELETEHandler);
function GETHandler(request: Request) {
  return sandboxRoute(request, (service) => service.savedProjects());
}
function DELETEHandler(request: Request) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    return service.deleteSavedProject(body.workspaceId, body.revision);
  });
}
