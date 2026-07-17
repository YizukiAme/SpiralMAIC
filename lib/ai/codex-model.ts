import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { ModelInfo, ModelServiceTier, ThinkingCapability } from '@/lib/types/provider';

type LanguageModelV3 = Parameters<typeof wrapLanguageModel>[0]['model'];
type CodexStreamResult = Awaited<ReturnType<LanguageModelV3['doStream']>>;
type CodexGenerateResult = Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
type CodexStreamPart =
  CodexStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;
type CodexContent = CodexGenerateResult['content'][number];
type CodexProviderMetadata = NonNullable<CodexGenerateResult['providerMetadata']>;

const codexRuntimeThinking = new WeakMap<object, ThinkingCapability | null>();

function cloneThinkingCapability(thinking: ThinkingCapability): ThinkingCapability {
  return {
    ...thinking,
    ...(thinking.effortValues ? { effortValues: [...thinking.effortValues] } : {}),
    ...(thinking.levelValues ? { levelValues: [...thinking.levelValues] } : {}),
    ...(thinking.budgetRange ? { budgetRange: { ...thinking.budgetRange } } : {}),
    ...(thinking.anthropicThinking
      ? {
          anthropicThinking: {
            ...thinking.anthropicThinking,
            ...(thinking.anthropicThinking.budgetByEffort
              ? { budgetByEffort: { ...thinking.anthropicThinking.budgetByEffort } }
              : {}),
          },
        }
      : {}),
  };
}

/** Bind safe discovery metadata to one server-created Codex model instance. */
export function bindCodexLanguageModelMetadata<T>(model: T, modelInfo: ModelInfo): T {
  if (!model || typeof model !== 'object') {
    throw new TypeError('Codex runtime metadata requires a language model object');
  }
  const thinking = modelInfo.capabilities?.thinking;
  codexRuntimeThinking.set(model, thinking ? cloneThinkingCapability(thinking) : null);
  return model;
}

/** Distinguish an explicit no-thinking discovery result from an unbound model. */
export function hasCodexLanguageModelMetadata(model: unknown): boolean {
  return Boolean(model && typeof model === 'object' && codexRuntimeThinking.has(model));
}

/** Read only the request capability carried by the resolved Codex model. */
export function getCodexLanguageModelThinking(model: unknown): ThinkingCapability | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const thinking = codexRuntimeThinking.get(model);
  return thinking ? cloneThinkingCapability(thinking) : undefined;
}

export const CODEX_RESPONSES_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_RESPONSES_ENDPOINT = `${CODEX_RESPONSES_BASE_URL}/responses`;
export const CODEX_STREAM_ERROR_MESSAGE = 'Codex response stream could not be processed';
export const CODEX_DECODED_STREAM_LIMITS = {
  maxParts: 250_000,
  maxContentItems: 4_096,
  maxToolInputBytes: 4 * 1024 * 1024,
} as const;
type SafeCodexStatusCode = 401 | 403 | 429;
type CodexDecodedStreamLimits = {
  [Key in keyof typeof CODEX_DECODED_STREAM_LIMITS]: number;
};
interface CodexToolInputBudgetState {
  bytes: number;
  streamed: boolean;
  ended: boolean;
  completed: boolean;
}

function isAuthenticationRequiredCode(value: unknown): boolean {
  return (
    value === 'CREDENTIALS_MISSING' ||
    value === 'SIGNED_OUT' ||
    value === 'INVALID_GRANT' ||
    value === 'REFRESH_REJECTED'
  );
}

function extractSafeStatusCode(error: unknown): SafeCodexStatusCode | undefined {
  const seen = new Set<unknown>();
  let current = error;

  for (let depth = 0; depth < 8; depth += 1) {
    if (!isRecord(current) || seen.has(current)) return undefined;
    seen.add(current);
    try {
      if (isAuthenticationRequiredCode(current.code)) return 401;
      for (const candidate of [current.statusCode, current.status, current.upstreamStatus]) {
        if (candidate === 401 || candidate === 403 || candidate === 429) return candidate;
      }
      current = current.cause;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export class CodexStreamError extends Error {
  declare readonly statusCode?: SafeCodexStatusCode;

  constructor(statusCode?: SafeCodexStatusCode) {
    super(CODEX_STREAM_ERROR_MESSAGE);
    Object.defineProperty(this, 'name', {
      value: 'CodexStreamError',
      configurable: true,
      enumerable: false,
    });
    if (statusCode !== undefined) {
      Object.defineProperty(this, 'statusCode', {
        value: statusCode,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
  }
}

function createCodexStreamError(source?: unknown): CodexStreamError {
  return new CodexStreamError(extractSafeStatusCode(source));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProviderOptions(
  providerOptions: Parameters<
    NonNullable<LanguageModelMiddleware['transformParams']>
  >[0]['params']['providerOptions'],
  serviceTier?: ModelServiceTier,
) {
  const existingOpenAI = isRecord(providerOptions?.openai) ? providerOptions.openai : {};
  const { serviceTier: _callerServiceTier, ...safeExistingOpenAI } = existingOpenAI;
  const existingInclude = Array.isArray(existingOpenAI.include)
    ? existingOpenAI.include.filter((value): value is string => typeof value === 'string')
    : [];
  const include = existingInclude.includes('reasoning.encrypted_content')
    ? existingInclude
    : [...existingInclude, 'reasoning.encrypted_content'];

  return {
    ...providerOptions,
    openai: {
      ...safeExistingOpenAI,
      store: false,
      include,
      systemMessageMode: 'developer',
      forceReasoning: true,
      ...(serviceTier ? { serviceTier } : {}),
    },
  } as NonNullable<
    Parameters<
      NonNullable<LanguageModelMiddleware['transformParams']>
    >[0]['params']['providerOptions']
  >;
}

function stripDecodedOpenAIItemId(part: unknown): unknown {
  if (!isRecord(part) || !isRecord(part.providerOptions)) return part;
  const openai = part.providerOptions.openai;
  if (!isRecord(openai) || !Object.prototype.hasOwnProperty.call(openai, 'itemId')) return part;

  const { itemId: _itemId, ...safeOpenAI } = openai;
  const { openai: _openai, ...otherProviderOptions } = part.providerOptions;
  const safeProviderOptions =
    Object.keys(safeOpenAI).length > 0
      ? { ...otherProviderOptions, openai: safeOpenAI }
      : otherProviderOptions;
  const { providerOptions: _providerOptions, ...safePart } = part;
  return Object.keys(safeProviderOptions).length > 0
    ? { ...safePart, providerOptions: safeProviderOptions }
    : safePart;
}

function sanitizeCodexReplayPrompt<T>(prompt: T): T {
  if (!Array.isArray(prompt)) return prompt;
  return prompt.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map(stripDecodedOpenAIItemId),
    };
  }) as T;
}

function mergeProviderMetadata(...values: Array<unknown>): CodexProviderMetadata | undefined {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const [provider, providerValue] of Object.entries(value)) {
      if (!isRecord(providerValue)) continue;
      merged[provider] = { ...(merged[provider] ?? {}), ...providerValue };
    }
  }
  return Object.keys(merged).length > 0 ? (merged as CodexProviderMetadata) : undefined;
}

function setMetadata(target: { providerMetadata?: CodexProviderMetadata }, value: unknown): void {
  const providerMetadata = mergeProviderMetadata(target.providerMetadata, value);
  if (providerMetadata) target.providerMetadata = providerMetadata;
}

interface TextState {
  kind: 'text' | 'reasoning';
  contentIndex: number;
  ended: boolean;
}

interface ToolInputState {
  contentIndex: number;
  toolName: string;
  input: string;
  ended: boolean;
  completed: boolean;
}

export function guardCodexStream(
  result: CodexStreamResult,
  overrides: Partial<CodexDecodedStreamLimits> = {},
): CodexStreamResult {
  const limits = { ...CODEX_DECODED_STREAM_LIMITS, ...overrides };
  const reader = result.stream.getReader();
  const encoder = new TextEncoder();
  const toolInputs = new Map<string, CodexToolInputBudgetState>();
  // Count a trailing high surrogate provisionally before forwarding it. The
  // next delta recomputes that one-code-unit prefix so a matching low surrogate
  // adjusts replacement-byte accounting to the complete pair.
  const pendingToolInputHighSurrogates = new Map<string, string>();
  const startedToolInputs = new Set<string>();
  let partCount = 0;
  let contentItemCount = 0;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // The safe wrapper owns this reader; there is nothing useful to expose.
    }
  };

  const cancel = async () => {
    if (released) return;
    try {
      await reader.cancel();
    } catch {
      // Never expose a source-stream cancellation failure.
    } finally {
      release();
    }
  };

  const flushPendingHighSurrogate = (id: string, state: CodexToolInputBudgetState): boolean => {
    pendingToolInputHighSurrogates.delete(id);
    return state.bytes <= limits.maxToolInputBytes;
  };

  const withinBudget = (part: CodexStreamPart): boolean => {
    partCount += 1;
    if (partCount > limits.maxParts) return false;

    switch (part.type) {
      case 'text-start':
      case 'reasoning-start':
      case 'tool-approval-request':
      case 'tool-result':
      case 'file':
      case 'source':
        contentItemCount += 1;
        return contentItemCount <= limits.maxContentItems;

      case 'tool-input-start':
        contentItemCount += 1;
        if (contentItemCount > limits.maxContentItems) return false;
        startedToolInputs.add(part.id);
        if (!toolInputs.has(part.id)) {
          toolInputs.set(part.id, {
            bytes: 0,
            streamed: false,
            ended: false,
            completed: false,
          });
        }
        return true;

      case 'tool-input-delta': {
        const state = toolInputs.get(part.id);
        if (!state || !startedToolInputs.has(part.id) || state.ended || state.completed) {
          return false;
        }
        const pending = pendingToolInputHighSurrogates.get(part.id) ?? '';
        if (pending) state.bytes -= encoder.encode(pending).byteLength;
        let input = pending + part.delta;
        pendingToolInputHighSurrogates.delete(part.id);
        const finalCodeUnit = input.charCodeAt(input.length - 1);
        if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
          const trailingHighSurrogate = input.slice(-1);
          pendingToolInputHighSurrogates.set(part.id, trailingHighSurrogate);
          input = input.slice(0, -1);
          state.bytes += encoder.encode(trailingHighSurrogate).byteLength;
        }
        state.bytes += encoder.encode(input).byteLength;
        state.streamed = true;
        return state.bytes <= limits.maxToolInputBytes;
      }

      case 'tool-input-end': {
        const state = toolInputs.get(part.id);
        if (!state || state.ended || state.completed) return false;
        if (!flushPendingHighSurrogate(part.id, state)) return false;
        state.ended = true;
        return true;
      }

      case 'tool-call': {
        if (!startedToolInputs.has(part.toolCallId)) {
          contentItemCount += 1;
          if (contentItemCount > limits.maxContentItems) return false;
          return encoder.encode(part.input).byteLength <= limits.maxToolInputBytes;
        }
        const state = toolInputs.get(part.toolCallId);
        if (
          !state ||
          !state.ended ||
          state.completed ||
          !flushPendingHighSurrogate(part.toolCallId, state)
        ) {
          return false;
        }
        // Do not add the final replay of streamed input, but bound it independently
        // so an empty or mismatched delta sequence cannot hide an oversized value.
        const finalInputBytes = encoder.encode(part.input).byteLength;
        if (finalInputBytes > limits.maxToolInputBytes) return false;
        if (!state.streamed || state.bytes === 0) {
          state.bytes = finalInputBytes;
        }
        if (state.bytes > limits.maxToolInputBytes) return false;
        state.completed = true;
        return true;
      }

      default:
        return true;
    }
  };

  const stream = new ReadableStream<CodexStreamPart>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          pendingToolInputHighSurrogates.clear();
          release();
          controller.close();
          return;
        }
        if (!withinBudget(value)) {
          await cancel();
          controller.error(createCodexStreamError());
          return;
        }
        controller.enqueue(
          value.type === 'error'
            ? ({ type: 'error', error: createCodexStreamError(value.error) } as CodexStreamPart)
            : value,
        );
      } catch (error) {
        await cancel();
        controller.error(createCodexStreamError(error));
      }
    },
    async cancel() {
      await cancel();
    },
  });

  return { ...result, stream };
}

export async function aggregateCodexStream(
  result: CodexStreamResult,
): Promise<CodexGenerateResult> {
  const content: CodexGenerateResult['content'] = [];
  const textStates = new Map<string, TextState>();
  const toolStates = new Map<string, ToolInputState>();
  const warnings: CodexGenerateResult['warnings'] = [];
  let responseMetadata: CodexGenerateResult['response'];
  let finishReason: CodexGenerateResult['finishReason'] | undefined;
  let usage: CodexGenerateResult['usage'] | undefined;
  let providerMetadata: CodexGenerateResult['providerMetadata'];

  let reader: ReadableStreamDefaultReader<CodexStreamPart>;
  try {
    reader = result.stream.getReader();
  } catch (error) {
    throw createCodexStreamError(error);
  }
  try {
    while (true) {
      const { done, value: rawPart } = await reader.read();
      if (done) break;
      const part = rawPart as CodexStreamPart & Record<string, unknown>;
      switch (part.type) {
        case 'stream-start':
          warnings.push(...part.warnings);
          break;

        case 'response-metadata':
          responseMetadata = {
            ...responseMetadata,
            ...(part.id !== undefined ? { id: part.id } : {}),
            ...(part.timestamp !== undefined ? { timestamp: part.timestamp } : {}),
            ...(part.modelId !== undefined ? { modelId: part.modelId } : {}),
          };
          break;

        case 'text-start':
        case 'reasoning-start': {
          if (textStates.has(part.id)) throw createCodexStreamError();
          const kind = part.type === 'text-start' ? 'text' : 'reasoning';
          const item = {
            type: kind,
            text: '',
            ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
          } as CodexContent;
          const contentIndex = content.length;
          content.push(item);
          textStates.set(part.id, { kind, contentIndex, ended: false });
          break;
        }

        case 'text-delta':
        case 'reasoning-delta': {
          const state = textStates.get(part.id);
          const expectedKind = part.type === 'text-delta' ? 'text' : 'reasoning';
          if (!state || state.kind !== expectedKind || state.ended) {
            throw createCodexStreamError();
          }
          const item = content[state.contentIndex] as Extract<
            CodexContent,
            { type: 'text' | 'reasoning' }
          >;
          item.text += part.delta;
          setMetadata(item, part.providerMetadata);
          break;
        }

        case 'text-end':
        case 'reasoning-end': {
          const state = textStates.get(part.id);
          const expectedKind = part.type === 'text-end' ? 'text' : 'reasoning';
          if (!state || state.kind !== expectedKind || state.ended) {
            throw createCodexStreamError();
          }
          state.ended = true;
          setMetadata(
            content[state.contentIndex] as { providerMetadata?: CodexProviderMetadata },
            part.providerMetadata,
          );
          break;
        }

        case 'tool-input-start': {
          if (toolStates.has(part.id)) throw createCodexStreamError();
          const item = {
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.toolName,
            input: '',
            ...(part.providerExecuted !== undefined
              ? { providerExecuted: part.providerExecuted }
              : {}),
            ...(part.dynamic !== undefined ? { dynamic: part.dynamic } : {}),
            ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
          } as CodexContent;
          const contentIndex = content.length;
          content.push(item);
          toolStates.set(part.id, {
            contentIndex,
            toolName: part.toolName,
            input: '',
            ended: false,
            completed: false,
          });
          break;
        }

        case 'tool-input-delta': {
          const state = toolStates.get(part.id);
          if (!state || state.ended) throw createCodexStreamError();
          state.input += part.delta;
          const item = content[state.contentIndex] as Extract<CodexContent, { type: 'tool-call' }>;
          item.input = state.input;
          setMetadata(item, part.providerMetadata);
          break;
        }

        case 'tool-input-end': {
          const state = toolStates.get(part.id);
          if (!state || state.ended) throw createCodexStreamError();
          state.ended = true;
          setMetadata(
            content[state.contentIndex] as { providerMetadata?: CodexProviderMetadata },
            part.providerMetadata,
          );
          break;
        }

        case 'tool-call': {
          const state = toolStates.get(part.toolCallId);
          if (!state) {
            content.push(part as CodexContent);
            break;
          }
          if (!state.ended || state.completed || state.toolName !== part.toolName) {
            throw createCodexStreamError();
          }
          if (state.input && state.input !== part.input) {
            throw createCodexStreamError();
          }
          state.completed = true;
          const item = content[state.contentIndex] as Extract<CodexContent, { type: 'tool-call' }>;
          item.input = state.input || part.input;
          if (part.providerExecuted !== undefined) item.providerExecuted = part.providerExecuted;
          if (part.dynamic !== undefined) item.dynamic = part.dynamic;
          setMetadata(item, part.providerMetadata);
          break;
        }

        case 'tool-approval-request':
        case 'tool-result':
        case 'file':
        case 'source':
          content.push(part as CodexContent);
          break;

        case 'finish':
          if (finishReason || usage) throw createCodexStreamError();
          finishReason = part.finishReason;
          usage = part.usage;
          providerMetadata = part.providerMetadata;
          break;

        case 'error':
          throw createCodexStreamError(part.error);

        case 'raw':
          break;

        default:
          throw createCodexStreamError();
      }
    }

    if (!finishReason || !usage) throw createCodexStreamError();
    for (const state of textStates.values()) {
      if (!state.ended) throw createCodexStreamError();
    }
    for (const state of toolStates.values()) {
      if (!state.ended || !state.completed) throw createCodexStreamError();
    }

    const response =
      responseMetadata || result.response?.headers
        ? {
            ...responseMetadata,
            ...(result.response?.headers ? { headers: result.response.headers } : {}),
          }
        : undefined;

    return {
      content,
      finishReason,
      usage,
      warnings,
      ...(result.request ? { request: result.request } : {}),
      ...(response ? { response } : {}),
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw createCodexStreamError(error);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader is already released or its stream failed; keep the error safe.
    }
  }
}

function createCodexLanguageModelMiddleware(
  serviceTier?: ModelServiceTier,
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const normalized = { ...params };
      normalized.prompt = sanitizeCodexReplayPrompt(params.prompt);
      delete normalized.maxOutputTokens;
      delete normalized.temperature;
      delete normalized.topP;
      delete normalized.topK;
      delete normalized.presencePenalty;
      delete normalized.frequencyPenalty;
      delete normalized.seed;
      normalized.providerOptions = normalizeProviderOptions(params.providerOptions, serviceTier);
      return normalized;
    },
    wrapGenerate: async ({ doStream }) => {
      try {
        return await aggregateCodexStream(guardCodexStream(await doStream()));
      } catch (error) {
        throw createCodexStreamError(error);
      }
    },
    wrapStream: async ({ doStream }) => {
      try {
        return guardCodexStream(await doStream());
      } catch (error) {
        throw createCodexStreamError(error);
      }
    },
  };
}

export function wrapCodexLanguageModel(
  model: LanguageModelV3,
  options: { serviceTier?: ModelServiceTier; modelInfo?: ModelInfo } = {},
): LanguageModelV3 {
  const wrapped = wrapLanguageModel({
    model,
    middleware: createCodexLanguageModelMiddleware(options.serviceTier),
    // Preserve the product/provider identity across the native OpenAI SDK
    // wrapper. Request metadata must never resolve this model as public OpenAI.
    providerId: 'openai-codex',
  });
  return options.modelInfo ? bindCodexLanguageModelMetadata(wrapped, options.modelInfo) : wrapped;
}
