import { randomUUID } from 'node:crypto';

import {
  establishAccess,
  headers,
  requireCodexImageJson,
  requireJson,
  responseEvents,
  safeFetch,
  validateAuthStatus,
} from './codex-acceptance-http';
import { fail, isRecord, normalizePublicBaseUrl, safeFailure } from './codex-acceptance-report';
import type {
  AcceptanceDependencies,
  AcceptanceOptions,
  Fetcher,
  SafeReport,
} from './codex-acceptance-types';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './codex-acceptance-types';
import {
  validateCodexCatalog,
  validateCodexImageCapability,
  validateCodexImageJson,
  validateEditorEvents,
  validateOutlineEvents,
  validateSceneJson,
  validateVerificationJson,
} from './codex-acceptance-validators';

const ACCEPTANCE_REQUIREMENT =
  'Create exactly one short slide explaining that 2 + 2 = 4. Do not use images, video, quizzes, or interactive content.';
const CODEX_IMAGE_MODEL = 'gpt-image-2';
const CODEX_IMAGE_PROMPT =
  'A simple flat educational illustration of four blue circles arranged as two pairs on a plain white background. No text, logos, people, or brands.';

function modelHeaders(modelId: string, cookie?: string, priority = false): Headers {
  return headers(cookie, {
    'content-type': 'application/json',
    'x-model': `openai-codex:${modelId}`,
    'x-openmaic-expected-provider': 'openai-codex',
    'x-openmaic-expected-model': modelId,
    'x-user-locale': 'en-US',
    ...(priority ? { 'x-service-tier': 'priority' } : {}),
  });
}

async function runOutlineRequest(
  options: AcceptanceOptions,
  fetcher: Fetcher,
  timeoutMs: number,
  cookie: string | undefined,
  modelId: string,
  priority: boolean,
): Promise<{ httpStatus: number; metrics: ReturnType<typeof validateOutlineEvents> }> {
  const response = await safeFetch(
    fetcher,
    `${options.baseUrl}/api/generate/scene-outlines-stream`,
    {
      method: 'POST',
      headers: modelHeaders(modelId, cookie, priority),
      body: JSON.stringify({
        requirements: {
          requirement: ACCEPTANCE_REQUIREMENT,
          interactiveMode: false,
          taskEngineMode: false,
        },
        ...(priority ? { serviceTier: 'priority' } : {}),
      }),
      cache: 'no-store',
    },
    timeoutMs,
  );
  return {
    httpStatus: response.status,
    metrics: validateOutlineEvents(await responseEvents(response)),
  };
}

async function runImageAcceptance(
  options: AcceptanceOptions,
  fetcher: Fetcher,
  timeoutMs: number,
  cookie: string | undefined,
  providerPayload: unknown,
): Promise<SafeReport> {
  let imageAvailable: boolean;
  try {
    imageAvailable = validateCodexImageCapability(providerPayload).available;
  } catch (error) {
    return safeFailure('image-generation', error, CODEX_IMAGE_MODEL);
  }
  if (!imageAvailable) {
    return {
      outcome: 'SKIP',
      stage: 'image-generation',
      modelId: CODEX_IMAGE_MODEL,
      errorCategory: 'unavailable',
    };
  }

  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/generate/image`,
      {
        method: 'POST',
        headers: headers(cookie, {
          'content-type': 'application/json',
          'x-image-provider': 'codex-image',
          'x-image-model': CODEX_IMAGE_MODEL,
        }),
        body: JSON.stringify({
          prompt: CODEX_IMAGE_PROMPT,
          aspectRatio: '16:9',
        }),
        cache: 'no-store',
      },
      timeoutMs,
    );
    const metrics = validateCodexImageJson(await requireCodexImageJson(response));
    return {
      outcome: 'PASS',
      stage: 'image-generation',
      modelId: CODEX_IMAGE_MODEL,
      httpStatus: response.status,
      ...metrics,
    };
  } catch (error) {
    return safeFailure('image-generation', error, CODEX_IMAGE_MODEL);
  }
}

export async function runCodexAcceptance(
  unsafeOptions: AcceptanceOptions,
  dependencies: AcceptanceDependencies = {},
): Promise<SafeReport[]> {
  let options: AcceptanceOptions;
  try {
    options = { ...unsafeOptions, baseUrl: normalizePublicBaseUrl(unsafeOptions.baseUrl) };
  } catch (error) {
    return [safeFailure('arguments', error)];
  }
  const fetcher = dependencies.fetcher ?? fetch;
  const timeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reports: SafeReport[] = [];

  let cookie: string | undefined;
  try {
    const access = await establishAccess(options, fetcher, timeoutMs);
    cookie = access.cookie;
    reports.push(access.report);
  } catch (error) {
    reports.push(safeFailure('access-session', error));
    return reports;
  }

  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/codex/auth`,
      { method: 'GET', headers: headers(cookie), cache: 'no-store' },
      timeoutMs,
    );
    const auth = validateAuthStatus(await requireJson(response), options.expectSignedOut);
    reports.push({
      outcome: 'PASS',
      stage: 'auth',
      httpStatus: response.status,
      available: auth.available,
      connected: auth.connected,
    });
  } catch (error) {
    reports.push(safeFailure('auth', error));
    return reports;
  }

  if (options.expectSignedOut) {
    try {
      const response = await safeFetch(
        fetcher,
        `${options.baseUrl}/api/server-providers`,
        { method: 'GET', headers: headers(cookie), cache: 'no-store' },
        timeoutMs,
      );
      const body = await requireJson(response);
      if (
        !isRecord(body) ||
        body.success !== true ||
        !isRecord(body.providers) ||
        Object.prototype.hasOwnProperty.call(body.providers, 'openai-codex') ||
        !isRecord(body.image) ||
        Object.prototype.hasOwnProperty.call(body.image, 'codex-image')
      ) {
        fail('invalid-shape', response.status);
      }
      reports.push({
        outcome: 'PASS',
        stage: 'signed-out-provider',
        httpStatus: response.status,
        providerPresent: false,
      });
    } catch (error) {
      reports.push(safeFailure('signed-out-provider', error));
    }
    return reports;
  }

  let catalogPayload: unknown;
  let catalogHttpStatus: number;
  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/server-providers`,
      { method: 'GET', headers: headers(cookie), cache: 'no-store' },
      timeoutMs,
    );
    catalogPayload = await requireJson(response);
    catalogHttpStatus = response.status;
  } catch (error) {
    reports.push(safeFailure('catalog', error));
    if (options.includeImage) {
      reports.push(safeFailure('image-generation', error, CODEX_IMAGE_MODEL));
    }
    return reports;
  }

  let catalog: ReturnType<typeof validateCodexCatalog>;
  try {
    catalog = validateCodexCatalog(catalogPayload);
    reports.push({
      outcome: 'PASS',
      stage: 'catalog',
      modelId: catalog.modelId,
      httpStatus: catalogHttpStatus,
      catalogStrict: true,
      priorityAdvertised: catalog.priorityAdvertised,
      modelCount: catalog.modelCount,
      fastModelCount: catalog.fastModelCount,
    });
  } catch (error) {
    reports.push(safeFailure('catalog', error));
    if (options.includeImage) {
      reports.push(await runImageAcceptance(options, fetcher, timeoutMs, cookie, catalogPayload));
    }
    return reports;
  }

  const modelId = catalog.modelId;
  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/verify-model`,
      {
        method: 'POST',
        headers: modelHeaders(modelId, cookie),
        body: JSON.stringify({ model: `openai-codex:${modelId}` }),
        cache: 'no-store',
      },
      timeoutMs,
    );
    const metrics = validateVerificationJson(await requireJson(response));
    reports.push({
      outcome: 'PASS',
      stage: 'verify-normal',
      modelId,
      httpStatus: response.status,
      ...metrics,
    });
  } catch (error) {
    reports.push(safeFailure('verify-normal', error, modelId));
  }

  if (catalog.priorityAdvertised) {
    try {
      const response = await safeFetch(
        fetcher,
        `${options.baseUrl}/api/verify-model`,
        {
          method: 'POST',
          headers: modelHeaders(modelId, cookie, true),
          body: JSON.stringify({
            model: `openai-codex:${modelId}`,
            serviceTier: 'priority',
          }),
          cache: 'no-store',
        },
        timeoutMs,
      );
      const metrics = validateVerificationJson(await requireJson(response));
      reports.push({
        outcome: 'PASS',
        stage: 'fast',
        modelId,
        httpStatus: response.status,
        priorityAdvertised: true,
        ...metrics,
      });
    } catch (error) {
      reports.push(safeFailure('fast', error, modelId));
    }
  } else {
    reports.push({
      outcome: 'SKIP',
      stage: 'fast',
      modelId,
      priorityAdvertised: false,
    });
  }

  if (options.includeImage) {
    reports.push(await runImageAcceptance(options, fetcher, timeoutMs, cookie, catalogPayload));
  }

  try {
    const outline = await runOutlineRequest(options, fetcher, timeoutMs, cookie, modelId, false);
    reports.push({
      outcome: 'PASS',
      stage: 'outline-stream',
      modelId,
      httpStatus: outline.httpStatus,
      streaming: true,
      ...outline.metrics,
    });
  } catch (error) {
    reports.push(safeFailure('outline-stream', error, modelId));
  }

  const acceptanceOutline = {
    id: 'acceptance-outline',
    type: 'slide',
    title: 'Two plus two',
    description: 'Show that 2 + 2 = 4.',
    keyPoints: ['2 + 2 = 4'],
    order: 0,
  };
  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/generate/scene-content`,
      {
        method: 'POST',
        headers: modelHeaders(modelId, cookie),
        body: JSON.stringify({
          outline: acceptanceOutline,
          allOutlines: [acceptanceOutline],
          stageInfo: { name: 'Codex acceptance', style: 'professional' },
          stageId: 'codex-acceptance',
          languageDirective: 'Teach in English.',
          requirements: { requirement: ACCEPTANCE_REQUIREMENT },
        }),
        cache: 'no-store',
      },
      timeoutMs,
    );
    const metrics = validateSceneJson(await requireJson(response));
    reports.push({
      outcome: 'PASS',
      stage: 'scene-json',
      modelId,
      httpStatus: response.status,
      ...metrics,
    });
  } catch (error) {
    reports.push(safeFailure('scene-json', error, modelId));
  }

  try {
    const response = await safeFetch(
      fetcher,
      `${options.baseUrl}/api/agent/edit`,
      {
        method: 'POST',
        headers: modelHeaders(modelId, cookie),
        body: JSON.stringify({
          sessionId: `acceptance-${randomUUID()}`,
          message:
            'Call read_scene_content exactly once for the current scene, then provide a brief confirmation after the tool completes.',
          scene: { id: 'acceptance-scene', title: 'Two plus two' },
          history: [],
          sceneContextMap: {
            'acceptance-scene': {
              outline: acceptanceOutline,
              allOutlines: [acceptanceOutline],
              stageId: 'codex-acceptance',
              content: {
                type: 'slide',
                canvas: {
                  id: 'acceptance-canvas',
                  viewportSize: 1000,
                  viewportRatio: 0.5625,
                  elements: [
                    {
                      id: 'acceptance-text',
                      type: 'text',
                      left: 80,
                      top: 80,
                      width: 840,
                      height: 120,
                      rotate: 0,
                      content: '<p>2 + 2 = 4</p>',
                      defaultFontName: 'Arial',
                      defaultColor: '#000000',
                    },
                  ],
                },
              },
            },
          },
        }),
        cache: 'no-store',
      },
      timeoutMs,
    );
    if (response.status === 404 && options.editorMode === 'disabled') {
      reports.push({
        outcome: 'SKIP',
        stage: 'editor-tools',
        modelId,
        httpStatus: 404,
        editorEnabled: false,
      });
    } else if (options.editorMode === 'disabled') {
      fail('invalid-shape', response.status);
    } else {
      const metrics = validateEditorEvents(await responseEvents(response));
      reports.push({
        outcome: 'PASS',
        stage: 'editor-tools',
        modelId,
        httpStatus: response.status,
        editorEnabled: true,
        ...metrics,
      });
    }
  } catch (error) {
    reports.push(safeFailure('editor-tools', error, modelId));
  }

  return reports;
}
