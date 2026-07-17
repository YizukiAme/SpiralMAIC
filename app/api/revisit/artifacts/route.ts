import { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import {
  buildStudyArtifactPrompt,
  parseStudyArtifactResponse,
  sanitizeStudyArtifactReferences,
  StudyArtifactRequestError,
  suggestStudyArtifactTitle,
  validateStudyArtifactRequest,
} from '@/lib/revisit/artifacts';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { parseCodexLogicalSession } from '@/lib/server/codex/logical-session';

const log = createLogger('RevisitArtifactsAPI');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const request = validateStudyArtifactRequest(body);
    const { model, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'revisit-materials',
      parseCodexLogicalSession({
        kind: 'revisit-artifact',
        id: (body as { jobId?: unknown }).jobId,
      }),
    );
    const prompt = buildStudyArtifactPrompt(request);
    const result = await callLLM(
      {
        model,
        system: prompt.system,
        prompt: prompt.user,
        abortSignal: req.signal,
      },
      'revisit-materials',
      undefined,
      thinkingConfig,
    );
    const parsedGeneration = parseStudyArtifactResponse({
      kind: request.kind,
      text: result.text,
    });
    const generation = sanitizeStudyArtifactReferences(parsedGeneration, {
      validConceptIds: request.adaptiveContext?.conceptStates.map((state) => state.conceptId) ?? [],
      validSourceSceneIds: prompt.selectedScenes.map((scene) => scene.id),
    });

    return apiSuccess({
      artifact: {
        stageId: request.stage.id,
        kind: request.kind,
        title: suggestStudyArtifactTitle(request.stage, request.kind, generation.language),
        stageUpdatedAt: request.stage.updatedAt,
        language: generation.language,
        options: request.options,
        sourceHash: prompt.sourceHash,
        lessonSourceHash: prompt.lessonSourceHash,
        content: generation.content,
      },
    });
  } catch (error) {
    if (error instanceof StudyArtifactRequestError) {
      return apiError('INVALID_REQUEST', 400, error.message);
    }
    log.error('Failed to create revisit study artifact:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to create revisit study artifact');
  }
}
