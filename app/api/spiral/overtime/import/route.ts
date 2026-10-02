import type { NextRequest } from 'next/server';

import type { OvertimeExtension } from '@/lib/overtime/types';
import { parseRequestLearningExtensionParams } from '@/lib/overtime/types';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withAccessCode } from '@/lib/server/with-access-code';

import { readBody, record, withOvertimeRequest } from '../http';

export const runtime = 'nodejs';
export const POST = withAccessCode(POSTHandler);

const STATUSES = new Set(['planning', 'generating', 'ready', 'failed', 'interrupted']);
const PHASES = new Set(['outline', 'content', 'actions', 'tts', 'commit']);

function validExtension(value: unknown): value is OvertimeExtension {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    Number.isSafeInteger(item.sequence) &&
    Number(item.sequence) > 0 &&
    Number.isSafeInteger(item.reservedOrder) &&
    Number(item.reservedOrder) >= 0 &&
    STATUSES.has(String(item.status)) &&
    PHASES.has(String(item.phase)) &&
    typeof item.userPrompt === 'string' &&
    Number.isFinite(item.createdAt) &&
    Number.isFinite(item.updatedAt) &&
    parseRequestLearningExtensionParams(item.decision),
  );
}

async function POSTHandler(req: NextRequest): Promise<Response> {
  return withOvertimeRequest(req, async (store, headers) => {
    const body = record(await readBody(req));
    if (
      typeof body?.stageId !== 'string' ||
      !Array.isArray(body.extensions) ||
      !body.extensions.every(validExtension)
    ) {
      return ownerApiError(
        'INVALID_REQUEST',
        400,
        'stageId and valid extensions are required',
        headers,
      );
    }
    return ownerJson(
      await store.import({
        stageId: body.stageId as string,
        extensions: body.extensions as OvertimeExtension[],
      }),
      200,
      headers,
    );
  });
}
