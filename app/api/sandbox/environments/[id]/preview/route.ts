import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';
export const runtime = 'nodejs';
export const POST = withAccessCode(POSTHandler);
export const DELETE = withAccessCode(DELETEHandler);
type Context = { params: Promise<{ id: string }> };
function POSTHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) =>
    service.preview((await context.params).id, (await sandboxBody(request)).port),
  );
}
function DELETEHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) =>
    service.revokePreviews((await context.params).id),
  );
}
