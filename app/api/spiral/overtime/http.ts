import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import {
  createServerOvertimeStore,
  OvertimeConflictError,
  OvertimeNotFoundError,
} from '@/lib/overtime/server-store';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { ownerApiError, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export function invalidRequest(message: string, headers?: Headers): Response {
  return Response.json({ error: { code: 'INVALID_REQUEST', message } }, { status: 400, headers });
}

export async function readBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function version(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export async function withOvertimeRequest(
  req: NextRequest,
  handler: (
    store: ReturnType<typeof createServerOvertimeStore>,
    headers: Headers,
  ) => Promise<Response>,
): Promise<Response> {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL!);
      return await handler(createServerOvertimeStore({ pool, ownerId }), headers);
    } catch (error) {
      if (error instanceof OvertimeNotFoundError) return ownerNotFound(headers);
      if (error instanceof OvertimeConflictError) {
        return ownerApiError('INVALID_REQUEST', 409, error.message, headers);
      }
      const ownerError = ownerWriteErrorResponse(error, headers);
      if (ownerError) return ownerError;
      throw error;
    }
  });
}
