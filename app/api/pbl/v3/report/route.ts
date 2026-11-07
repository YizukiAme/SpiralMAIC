import { withAccessCode } from '@/lib/server/with-access-code';

import { sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { generateLearningReport, learningReport } from '@/lib/server/pbl-v3/report';
import { after } from 'next/server';
export const runtime = 'nodejs';
export const GET = withAccessCode(GETHandler);
export const POST = withAccessCode(POSTHandler);
async function GETHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) throw sandboxInvalid('A learning session is required.');
    return Response.json(await learningReport(principal, id));
  });
}

async function POSTHandler(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) throw sandboxInvalid('A learning session is required.');
    const report = await generateLearningReport(principal, id, request.signal, (work) => {
      after(async () => {
        await work();
      });
    });
    return Response.json(report, { status: report.analysis?.status === 'generating' ? 202 : 200 });
  });
}
