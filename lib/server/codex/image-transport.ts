import packageMetadata from '../../../package.json';

import {
  areCodexImageDimensionsSafe,
  CODEX_IMAGE_MAX_BYTES,
} from '@/lib/media/codex-image-contract';
import type { ImageGenerationOptions, ImageGenerationResult } from '@/lib/media/types';

import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  acquireCodexCredentialLease,
  isCodexCredentialLeaseCurrent,
  isCodexCredentialsChangedError,
  refreshCodexCredentialLease,
  type CodexTokenProvider,
  type InternalCodexCredentialLease,
} from './token-provider';

export const CODEX_IMAGE_GENERATIONS_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/images/generations';
export const CODEX_IMAGE_MODEL = 'gpt-image-2';
export const CODEX_IMAGE_REQUEST_TIMEOUT_MS = 180_000;

const SUCCESS_BODY_MAX_BYTES = 32 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 16 * 1024;

export const CODEX_IMAGE_TRANSPORT_ERROR_CODES = {
  INVALID_ENDPOINT: 'INVALID_ENDPOINT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  IMAGE_ENTITLEMENT_UNAVAILABLE: 'IMAGE_ENTITLEMENT_UNAVAILABLE',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  MODERATION_BLOCKED: 'MODERATION_BLOCKED',
  REQUEST_REJECTED: 'REQUEST_REJECTED',
  ROUTE_UNAVAILABLE: 'ROUTE_UNAVAILABLE',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  LOCAL_UNAVAILABLE: 'LOCAL_UNAVAILABLE',
  STALE_CREDENTIALS: 'STALE_CREDENTIALS',
} as const;

export type CodexImageTransportErrorCode =
  (typeof CODEX_IMAGE_TRANSPORT_ERROR_CODES)[keyof typeof CODEX_IMAGE_TRANSPORT_ERROR_CODES];

const SAFE_ERROR_MESSAGES: Record<CodexImageTransportErrorCode, string> = {
  INVALID_ENDPOINT: 'Codex image transport rejected an unsupported endpoint',
  INVALID_REQUEST: 'Codex image transport rejected an invalid request',
  AUTH_REQUIRED: 'Codex sign-in must be renewed',
  IMAGE_ENTITLEMENT_UNAVAILABLE: 'This ChatGPT workspace does not have Codex image access',
  FORBIDDEN: 'The Codex image request was forbidden',
  RATE_LIMITED: 'The ChatGPT plan limit or Codex image rate limit was reached',
  MODERATION_BLOCKED: 'The image request was blocked by content moderation',
  REQUEST_REJECTED: 'The Codex image request was rejected',
  ROUTE_UNAVAILABLE: 'Codex image generation is unavailable on this backend',
  UPSTREAM_UNAVAILABLE: 'Codex image generation is temporarily unavailable',
  TIMEOUT: 'Codex image generation timed out',
  NETWORK_ERROR: 'Codex image generation could not be reached',
  INVALID_RESPONSE: 'Codex image generation returned an invalid response',
  LOCAL_UNAVAILABLE: 'Codex credentials are temporarily unavailable',
  STALE_CREDENTIALS: 'Codex credentials changed while generating the image',
};

export type CodexImageFailureSource = 'upstream-http' | 'network' | 'invalid-response' | 'timeout';

function failureSource(
  code: CodexImageTransportErrorCode,
  upstreamStatus: number | undefined,
): CodexImageFailureSource | undefined {
  if (upstreamStatus !== undefined) return 'upstream-http';
  if (code === CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR) return 'network';
  if (code === CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE) return 'invalid-response';
  if (code === CODEX_IMAGE_TRANSPORT_ERROR_CODES.TIMEOUT) return 'timeout';
  return undefined;
}

export class CodexImageTransportError extends Error {
  public readonly source: CodexImageFailureSource | undefined;

  constructor(
    public readonly code: CodexImageTransportErrorCode,
    public readonly upstreamStatus?: number,
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'CodexImageTransportError';
    this.source = failureSource(code, upstreamStatus);
  }
}

export interface CodexImageTransportObservation {
  requestedSize: string;
  responseSize?: string;
  responseSizeStatus: 'absent' | 'valid' | 'invalid';
  actualWidth: number;
  actualHeight: number;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  requestSizeDrift: boolean;
  responseSizeDrift?: boolean;
  aspectRatioDrift: boolean;
}

export interface CreateCodexImageTransportOptions {
  tokenProvider: CodexTokenProvider;
  upstreamFetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  onObservation?: (observation: CodexImageTransportObservation) => void | PromiseLike<void>;
}

export interface CodexImageGenerationRequest {
  prompt: string;
  aspectRatio?: ImageGenerationOptions['aspectRatio'];
  signal?: AbortSignal;
}

const IMAGE_SIZES = {
  '16:9': '1536x864',
  '4:3': '1024x768',
  '1:1': '1024x1024',
  '9:16': '864x1536',
} as const;

export function mapCodexImageSize(
  aspectRatio: ImageGenerationOptions['aspectRatio'] | undefined,
): string {
  return aspectRatio ? IMAGE_SIZES[aspectRatio] : IMAGE_SIZES['1:1'];
}

function imageDimensions(size: string): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number);
  return { width, height };
}

function parseResponseSize(
  value: unknown,
): { normalized: string; width: number; height: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(value);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return { normalized: `${width}x${height}`, width, height };
}

function responseQuality(value: unknown): CodexImageTransportObservation['quality'] | undefined {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'auto') return value;
  return undefined;
}

function hasAspectRatioDrift(
  requested: { width: number; height: number },
  actual: { width: number; height: number },
): boolean {
  const ratioDelta = Math.abs(actual.width * requested.height - requested.width * actual.height);
  const requestedRatioScale = requested.width * actual.height;
  return ratioDelta * 100 > requestedRatioScale * 2;
}

function error(
  code: CodexImageTransportErrorCode,
  upstreamStatus?: number,
): CodexImageTransportError {
  return new CodexImageTransportError(code, upstreamStatus);
}

function credentialError(caught: unknown): CodexImageTransportError {
  if (caught instanceof CodexImageTransportError) return caught;
  if (isCodexCredentialsChangedError(caught)) {
    return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.STALE_CREDENTIALS);
  }
  if (caught instanceof CodexOAuthError) {
    switch (caught.code) {
      case CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING:
      case CODEX_OAUTH_ERROR_CODES.SIGNED_OUT:
      case CODEX_OAUTH_ERROR_CODES.INVALID_GRANT:
      case CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED:
        return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.AUTH_REQUIRED);
      case CODEX_OAUTH_ERROR_CODES.NETWORK_ERROR:
        return caught.retryable
          ? error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR)
          : error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.LOCAL_UNAVAILABLE);
      case CODEX_OAUTH_ERROR_CODES.UPSTREAM_ERROR:
        return caught.retryable
          ? error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.UPSTREAM_UNAVAILABLE, caught.upstreamStatus)
          : error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.LOCAL_UNAVAILABLE);
      case CODEX_OAUTH_ERROR_CODES.INVALID_RESPONSE:
        return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
      case CODEX_OAUTH_ERROR_CODES.STORAGE_ERROR:
        return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.LOCAL_UNAVAILABLE);
    }
  }
  return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.LOCAL_UNAVAILABLE);
}

function createHeaders(credentials: { accessToken: string; accountId: string }): Headers {
  const headers = new Headers();
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${credentials.accessToken}`);
  headers.set('chatgpt-account-id', credentials.accountId);
  headers.set('content-type', 'application/json');
  headers.set('originator', 'openmaic');
  headers.set('user-agent', `OpenMAIC/${packageMetadata.version} (native Codex OAuth)`);
  headers.set('version', packageMetadata.version);
  return headers;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) {
    await cancelResponseBody(response);
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await cancelResponseBody(response);
      throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
      }
      chunks.push(value);
    }
  } catch (caught) {
    if (caught instanceof CodexImageTransportError) throw caught;
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
  } finally {
    signal.removeEventListener('abort', cancel);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBase64AlphabetCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > CODEX_IMAGE_MAX_BYTES) {
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  }
  const alphabetLength = value.length - padding;
  for (let index = 0; index < alphabetLength; index += 1) {
    if (!isBase64AlphabetCode(value.charCodeAt(index))) {
      throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
    }
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength > CODEX_IMAGE_MAX_BYTES || decoded.toString('base64') !== value) {
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  }
  return decoded;
}

function inspectPng(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    bytes.byteLength < 33 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!areCodexImageDimensionsSafe(width, height)) {
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  }
  return { width, height };
}

interface ParsedImageResponse {
  result: ImageGenerationResult;
  observation: CodexImageTransportObservation;
}

async function parseImageResponse(
  response: Response,
  signal: AbortSignal,
  requestedSize: string,
  requestedDimensions: { width: number; height: number },
): Promise<ParsedImageResponse> {
  const payload = parseJson(await readBoundedBytes(response, SUCCESS_BODY_MAX_BYTES, signal));
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length !== 1) {
    throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  }
  const entry = payload.data[0];
  if (!isRecord(entry)) throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE);
  const decoded = decodeCanonicalBase64(entry.b64_json);
  if (signal.aborted) throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
  const actualDimensions = inspectPng(decoded);
  if (signal.aborted) throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);

  const parsedResponseSize = parseResponseSize(payload.size);
  const quality = responseQuality(payload.quality);
  const responseSizeDrift = parsedResponseSize
    ? parsedResponseSize.width !== actualDimensions.width ||
      parsedResponseSize.height !== actualDimensions.height
    : undefined;
  const observation: CodexImageTransportObservation = {
    requestedSize,
    ...(parsedResponseSize ? { responseSize: parsedResponseSize.normalized } : {}),
    responseSizeStatus:
      payload.size === undefined ? 'absent' : parsedResponseSize ? 'valid' : 'invalid',
    actualWidth: actualDimensions.width,
    actualHeight: actualDimensions.height,
    ...(quality ? { quality } : {}),
    requestSizeDrift:
      requestedDimensions.width !== actualDimensions.width ||
      requestedDimensions.height !== actualDimensions.height,
    ...(responseSizeDrift === undefined ? {} : { responseSizeDrift }),
    aspectRatioDrift: hasAspectRatioDrift(requestedDimensions, actualDimensions),
  };
  return {
    result: { base64: entry.b64_json as string, ...actualDimensions },
    observation,
  };
}

async function safeErrorCode(
  response: Response,
  signal: AbortSignal,
  requireJsonContentType = false,
): Promise<string | undefined> {
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (requireJsonContentType && !contentType?.includes('application/json')) {
    await cancelResponseBody(response);
    return undefined;
  }
  try {
    const payload = parseJson(await readBoundedBytes(response, ERROR_BODY_MAX_BYTES, signal));
    if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
    return typeof payload.error.code === 'string' ? payload.error.code.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function classifyStatusError(
  response: Response,
  signal: AbortSignal,
): Promise<CodexImageTransportError> {
  const status = response.status;
  if (status === 401) {
    await cancelResponseBody(response);
    throwIfAborted(signal);
    return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.AUTH_REQUIRED, status);
  }
  if (status === 400) {
    const upstreamCode = await safeErrorCode(response, signal);
    throwIfAborted(signal);
    if (upstreamCode === 'moderation_blocked') {
      return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.MODERATION_BLOCKED, status);
    }
    return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.REQUEST_REJECTED, status);
  }
  if (status === 403) {
    const upstreamCode = await safeErrorCode(response, signal, true);
    throwIfAborted(signal);
    if (upstreamCode === 'image_generation_not_available') {
      return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.IMAGE_ENTITLEMENT_UNAVAILABLE, status);
    }
    return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.FORBIDDEN, status);
  }
  await cancelResponseBody(response);
  throwIfAborted(signal);
  if (status === 429) return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.RATE_LIMITED, status);
  if (status === 404 || status === 405) {
    return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.ROUTE_UNAVAILABLE, status);
  }
  return error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.UPSTREAM_UNAVAILABLE, status);
}

async function withImageDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (reason: CodexImageTransportError) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (code: 'TIMEOUT' | 'NETWORK_ERROR') => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectAbort(error(code));
  };
  if (signal) {
    parentAbortListener = () => abort(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
    if (signal.aborted) parentAbortListener();
    else signal.addEventListener('abort', parentAbortListener, { once: true });
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => abort(CODEX_IMAGE_TRANSPORT_ERROR_CODES.TIMEOUT), timeoutMs);
  }
  try {
    if (controller.signal.aborted) return await aborted;
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && parentAbortListener) signal.removeEventListener('abort', parentAbortListener);
  }
}

/** Creates the sole authenticated boundary for Codex subscription image generation. */
export function createCodexImageTransport(options: CreateCodexImageTransportOptions) {
  const upstreamFetch = options.upstreamFetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.max(0, options.timeoutMs ?? CODEX_IMAGE_REQUEST_TIMEOUT_MS);

  return async (
    input: string,
    request: CodexImageGenerationRequest,
  ): Promise<ImageGenerationResult> => {
    if (input !== CODEX_IMAGE_GENERATIONS_ENDPOINT) {
      throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_ENDPOINT);
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_REQUEST);
    }
    if (request.aspectRatio !== undefined && !Object.hasOwn(IMAGE_SIZES, request.aspectRatio)) {
      throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_REQUEST);
    }

    const size = mapCodexImageSize(request.aspectRatio);
    const dimensions = imageDimensions(size);
    const body = JSON.stringify({
      prompt: request.prompt,
      background: 'auto',
      model: CODEX_IMAGE_MODEL,
      quality: 'auto',
      size,
    });

    return withImageDeadline(request.signal, timeoutMs, async (signal) => {
      let lease: InternalCodexCredentialLease;
      try {
        lease = await acquireCodexCredentialLease(options.tokenProvider);
      } catch (caught) {
        throw credentialError(caught);
      }
      throwIfAborted(signal);

      const send = async (): Promise<Response> => {
        throwIfAborted(signal);
        try {
          if (!(await isCodexCredentialLeaseCurrent(lease))) {
            throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.STALE_CREDENTIALS);
          }
        } catch (caught) {
          throw credentialError(caught);
        }
        throwIfAborted(signal);
        try {
          const response = await upstreamFetch(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
            method: 'POST',
            body,
            headers: createHeaders(lease.credentials),
            redirect: 'error',
            signal,
          });
          if (signal.aborted) {
            await cancelResponseBody(response);
            throwIfAborted(signal);
          }
          return response;
        } catch (caught) {
          if (caught instanceof CodexImageTransportError) throw caught;
          throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
        }
      };

      let response = await send();
      if (response.status === 401) {
        await cancelResponseBody(response);
        throwIfAborted(signal);
        try {
          lease = await refreshCodexCredentialLease(lease);
        } catch (caught) {
          throw credentialError(caught);
        }
        throwIfAborted(signal);
        response = await send();
      }

      if (!response.ok) {
        const responseError = await classifyStatusError(response, signal);
        if (!(await isCodexCredentialLeaseCurrent(lease))) {
          throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.STALE_CREDENTIALS);
        }
        throwIfAborted(signal);
        throw responseError;
      }
      const parsed = await parseImageResponse(response, signal, size, dimensions);
      if (!(await isCodexCredentialLeaseCurrent(lease))) {
        throw error(CODEX_IMAGE_TRANSPORT_ERROR_CODES.STALE_CREDENTIALS);
      }
      throwIfAborted(signal);
      try {
        const callbackResult = options.onObservation?.(parsed.observation);
        if (callbackResult) void Promise.resolve(callbackResult).catch(() => undefined);
      } catch {
        // Observations are diagnostic only and must never fail a valid generation.
      }
      return parsed.result;
    });
  };
}
