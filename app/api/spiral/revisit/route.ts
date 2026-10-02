import { LEGACY_IMPORT_HEADER } from '@/lib/persistence/legacy-import-bindings';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { runRevisitOperation } from '@/lib/revisit/server-operations';
import { RevisitAccessError } from '@/lib/revisit/server-store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { withAccessCode } from '@/lib/server/with-access-code';

export const runtime = 'nodejs';

function errorResponse(status: number, code: string, message: string, headers?: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/** Owner-scoped formal Revisit operations; Demo never calls this route. */
export const POST = withAccessCode(POSTHandler);

async function POSTHandler(request: Request): Promise<Response> {
  if (!isSameOriginJsonRequest(request)) {
    return errorResponse(403, 'CROSS_ORIGIN_REFUSED', 'Revisit requests must be same-origin JSON.');
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return errorResponse(
      404,
      'PERSISTENCE_NOT_CONFIGURED',
      'Server persistence is not configured.',
    );
  }
  return withRequestOwner(request, async ({ ownerId }, responseHeaders) => {
    responseHeaders.set('cache-control', 'no-store');
    let body: { op?: unknown; args?: unknown };
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Expected a JSON request.', responseHeaders);
    }
    if (
      typeof body?.op !== 'string' ||
      !body.args ||
      typeof body.args !== 'object' ||
      Array.isArray(body.args)
    ) {
      return errorResponse(
        400,
        'INVALID_REQUEST',
        'Expected a Revisit operation and arguments.',
        responseHeaders,
      );
    }
    if (body.op === 'importLegacy' && !request.headers.has(LEGACY_IMPORT_HEADER)) {
      return errorResponse(
        403,
        'LEGACY_IMPORT_NOT_BOUND',
        'A bound legacy browser id is required.',
        responseHeaders,
      );
    }
    try {
      const provider = await getServerPersistenceProvider(connectionString);
      const result = await provider.withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return runRevisitOperation(
          tx,
          ownerId,
          body.op as string,
          body.args as Record<string, unknown>,
        );
      });
      return Response.json({ result: result ?? null }, { status: 200, headers: responseHeaders });
    } catch (error) {
      const ownerRefusal = ownerWriteErrorResponse(error, responseHeaders);
      if (ownerRefusal) return ownerRefusal;
      if (error instanceof RevisitAccessError) {
        return errorResponse(
          404,
          'REVISIT_NOT_FOUND',
          'Revisit course not found.',
          responseHeaders,
        );
      }
      if (error instanceof Error && error.message.startsWith('Unknown Revisit operation:')) {
        return errorResponse(400, 'INVALID_OPERATION', error.message, responseHeaders);
      }
      if (error instanceof Error && error.message.includes('before lesson completion')) {
        return errorResponse(409, 'LESSON_NOT_COMPLETED', error.message, responseHeaders);
      }
      console.error('[revisit] formal persistence failed', error);
      return errorResponse(
        500,
        'REVISIT_PERSISTENCE_FAILED',
        'Revisit persistence failed.',
        responseHeaders,
      );
    }
  });
}
