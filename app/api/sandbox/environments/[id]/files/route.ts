import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const PUT = withAccessCode(PUTHandler);
type Context = { params: Promise<{ id: string }> };

function GETHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => ({
    text: await service.readText(
      (await context.params).id,
      new URL(request.url).searchParams.get('path'),
    ),
  }));
}

function PUTHandler(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    // JSON escaping can expand one text byte to six wire bytes.
    const body = await sandboxBody(request, 6 * 1024 * 1024 + 32 * 1024);
    await service.writeText((await context.params).id, body.path, body.text);
    return { written: true };
  });
}
