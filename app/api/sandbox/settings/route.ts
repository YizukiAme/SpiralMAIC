import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import {
  assertSandboxSettingsAdmin,
  sandboxSettingsView,
  saveSandboxSettings,
} from '@/lib/server/sandbox/settings';
export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const PUT = withAccessCode(PUTHandler);
function GETHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    assertSandboxSettingsAdmin(principal);
    return Response.json({ success: true, data: await sandboxSettingsView() });
  });
}
function PUTHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    assertSandboxSettingsAdmin(principal);
    return Response.json({
      success: true,
      data: await saveSandboxSettings(await sandboxBody(request, 8192)),
    });
  });
}
