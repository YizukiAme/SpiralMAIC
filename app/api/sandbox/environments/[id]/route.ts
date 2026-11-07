import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const POST = withAccessCode(POSTHandler);
export const DELETE = withAccessCode(DELETEHandler);
type Context = { params: Promise<{ id: string }> };

/** Stored host state only; POST reconcile explicitly consults the provider. */
function GETHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => service.get((await context.params).id));
}

function POSTHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    if (body.action === 'renew') return service.renew((await context.params).id);
    if (body.action !== 'reconcile') throw sandboxInvalid('Expected action: reconcile.');
    return service.reconcile((await context.params).id);
  });
}

/** Destructive release; it is deliberately not called stop/pause. */
function DELETEHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => service.destroy((await context.params).id));
}
