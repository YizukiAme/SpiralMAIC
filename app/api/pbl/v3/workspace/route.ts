import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import {
  workbenchCommand,
  workbenchView,
  type WorkbenchCommand,
} from '@/lib/server/pbl-v3/workbench';
export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const POST = withAccessCode(POSTHandler);
async function GETHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) throw sandboxInvalid('A learning session is required.');
    return Response.json(await workbenchView(principal, id));
  });
}
async function POSTHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const body = await sandboxBody(request, 256000);
    if (typeof body.studyId !== 'string') throw sandboxInvalid('A learning session is required.');
    return Response.json(
      await workbenchCommand(principal, body.studyId, body.command as unknown as WorkbenchCommand),
    );
  });
}
