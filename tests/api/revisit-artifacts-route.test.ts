import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildStudyArtifactPrompt: vi.fn(),
  callLLM: vi.fn(),
  parseStudyArtifactResponse: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  suggestStudyArtifactTitle: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/revisit/artifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/revisit/artifacts')>();
  return {
    ...actual,
    buildStudyArtifactPrompt: mocks.buildStudyArtifactPrompt,
    parseStudyArtifactResponse: mocks.parseStudyArtifactResponse,
    suggestStudyArtifactTitle: mocks.suggestStudyArtifactTitle,
  };
});
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

import { POST } from '@/app/api/revisit/artifacts/route';

describe('revisit artifacts route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: 'openai:gpt-4.1-mini',
      thinkingConfig: undefined,
    });
    mocks.buildStudyArtifactPrompt.mockReturnValue({
      system: 'system',
      user: 'user',
      sourceHash: 'source-hash',
      lessonSourceHash: 'lesson-hash',
      selectedScenes: [{ id: 'scene-2' }],
    });
    mocks.parseStudyArtifactResponse.mockReturnValue({
      language: 'en-US',
      content: {
        items: [
          {
            id: 'flashcard-1',
            front: 'Subject',
            back: 'The thing the sentence is about.',
          },
        ],
      },
    });
    mocks.suggestStudyArtifactTitle.mockReturnValue('English Grammar Flashcards');
    mocks.callLLM.mockResolvedValue({ text: '{}' });
  });

  it('validates the request and returns one unsaved artifact payload', async () => {
    const request = new Request('http://localhost/api/revisit/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'flashcards',
        options: {
          focusMode: 'selected-scenes',
          selectedSceneIds: ['scene-2'],
          customInstructions: 'Focus on weak predicates.',
          count: 12,
          difficulty: 'medium',
        },
        stage: { id: 'stage-1', name: 'Grammar', createdAt: 1, updatedAt: 2 },
        scenes: [
          {
            id: 'scene-2',
            stageId: 'stage-1',
            type: 'quiz',
            title: 'Predicate check',
            order: 1,
            content: {
              type: 'quiz',
              questions: [],
            },
          },
        ],
      }),
    });

    const response = await POST(request as NextRequest);
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      request,
      expect.any(Object),
      'revisit-materials',
    );
    expect(mocks.buildStudyArtifactPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'flashcards',
        options: expect.objectContaining({ selectedSceneIds: ['scene-2'] }),
      }),
    );
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: request.signal }),
      'revisit-materials',
      undefined,
      undefined,
    );
    expect(mocks.parseStudyArtifactResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'flashcards',
        text: '{}',
      }),
    );
    expect(mocks.suggestStudyArtifactTitle).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stage-1' }),
      'flashcards',
      'en-US',
    );
    expect(body).toEqual({
      success: true,
      artifact: {
        stageId: 'stage-1',
        kind: 'flashcards',
        title: 'English Grammar Flashcards',
        stageUpdatedAt: 2,
        language: 'en-US',
        options: {
          focusMode: 'selected-scenes',
          selectedSceneIds: ['scene-2'],
          customInstructions: 'Focus on weak predicates.',
          count: 12,
          difficulty: 'medium',
        },
        sourceHash: 'source-hash',
        lessonSourceHash: 'lesson-hash',
        content: {
          items: [
            {
              id: 'flashcard-1',
              front: 'Subject',
              back: 'The thing the sentence is about.',
            },
          ],
        },
      },
    });
  });

  it('rejects invalid scene selections before calling the model', async () => {
    const request = new Request('http://localhost/api/revisit/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'faq',
        options: {
          focusMode: 'selected-scenes',
          selectedSceneIds: ['missing-scene'],
          customInstructions: '',
          count: 10,
        },
        stage: { id: 'stage-1', name: 'Grammar', createdAt: 1, updatedAt: 2 },
        scenes: [
          {
            id: 'scene-2',
            stageId: 'stage-1',
            type: 'quiz',
            title: 'Predicate check',
            order: 1,
            content: {
              type: 'quiz',
              questions: [],
            },
          },
        ],
      }),
    });

    const response = await POST(request as NextRequest);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});
