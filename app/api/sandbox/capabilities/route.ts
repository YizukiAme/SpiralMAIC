import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);

function GETHandler(request: Request) {
  return sandboxRoute(request, async (service) => service.capabilities());
}
