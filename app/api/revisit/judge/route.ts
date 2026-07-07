import { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { RevisitExamBlueprint } from '@/lib/revisit/types';
import { buildJudgePrompt, parseJudgeResponse } from '@/lib/revisit/prompt-builders';
import { createLogger } from '@/lib/logger';

const log = createLogger('RevisitJudgeAPI');

interface JudgeRequest {
  attemptId: string;
  stageId: string;
  blueprint: RevisitExamBlueprint;
  transcript: unknown;
  pageReports: unknown;
  languageDirective?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as JudgeRequest;
    if (!body.attemptId || !body.stageId || !body.blueprint) {
      return apiError('INVALID_REQUEST', 400, 'attemptId, stageId, and blueprint are required');
    }

    const { model, thinkingConfig } = await resolveModelFromRequest(req, body, 'revisit-judge');
    const prompt = buildJudgePrompt({
      blueprint: body.blueprint,
      transcript: body.transcript,
      pageReports: body.pageReports,
      languageDirective: body.languageDirective,
    });
    const result = await callLLM(
      {
        model,
        system: prompt.system,
        prompt: prompt.user,
      },
      'revisit-judge',
      undefined,
      thinkingConfig,
    );
    const report = parseJudgeResponse({
      text: result.text,
      attemptId: body.attemptId,
      stageId: body.stageId,
    });

    return apiSuccess({ report });
  } catch (error) {
    log.error('Failed to judge revisit challenge:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to judge revisit challenge');
  }
}
