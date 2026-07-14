import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';

type LanguageModelV3 = Parameters<typeof wrapLanguageModel>[0]['model'];
type CodexStreamResult = Awaited<ReturnType<LanguageModelV3['doStream']>>;
type CodexGenerateResult = Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
type CodexStreamPart =
  CodexStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;
type CodexContent = CodexGenerateResult['content'][number];
type CodexProviderMetadata = NonNullable<CodexGenerateResult['providerMetadata']>;

export const CODEX_RESPONSES_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_RESPONSES_ENDPOINT = `${CODEX_RESPONSES_BASE_URL}/responses`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProviderOptions(
  providerOptions: Parameters<
    NonNullable<LanguageModelMiddleware['transformParams']>
  >[0]['params']['providerOptions'],
) {
  const existingOpenAI = isRecord(providerOptions?.openai) ? providerOptions.openai : {};
  const existingInclude = Array.isArray(existingOpenAI.include)
    ? existingOpenAI.include.filter((value): value is string => typeof value === 'string')
    : [];
  const include = existingInclude.includes('reasoning.encrypted_content')
    ? existingInclude
    : [...existingInclude, 'reasoning.encrypted_content'];

  return {
    ...providerOptions,
    openai: {
      ...existingOpenAI,
      store: false,
      include,
      systemMessageMode: 'developer',
      forceReasoning: true,
    },
  } as NonNullable<
    Parameters<
      NonNullable<LanguageModelMiddleware['transformParams']>
    >[0]['params']['providerOptions']
  >;
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

function invalidStream(message: string): Error {
  return new Error(`Invalid Codex stream: ${message}`);
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

  const reader = result.stream.getReader();
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
          if (textStates.has(part.id)) throw invalidStream(`duplicate content id ${part.id}`);
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
            throw invalidStream(`delta for unknown content id ${part.id}`);
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
            throw invalidStream(`end for unknown content id ${part.id}`);
          }
          state.ended = true;
          setMetadata(
            content[state.contentIndex] as { providerMetadata?: CodexProviderMetadata },
            part.providerMetadata,
          );
          break;
        }

        case 'tool-input-start': {
          if (toolStates.has(part.id)) throw invalidStream(`duplicate tool input id ${part.id}`);
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
          if (!state || state.ended)
            throw invalidStream(`delta for unknown tool input id ${part.id}`);
          state.input += part.delta;
          const item = content[state.contentIndex] as Extract<CodexContent, { type: 'tool-call' }>;
          item.input = state.input;
          setMetadata(item, part.providerMetadata);
          break;
        }

        case 'tool-input-end': {
          const state = toolStates.get(part.id);
          if (!state || state.ended)
            throw invalidStream(`end for unknown tool input id ${part.id}`);
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
            throw invalidStream(`incomplete tool input id ${part.toolCallId}`);
          }
          if (state.input && state.input !== part.input) {
            throw invalidStream(`tool input mismatch for id ${part.toolCallId}`);
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
          if (finishReason || usage) throw invalidStream('duplicate finish part');
          finishReason = part.finishReason;
          usage = part.usage;
          providerMetadata = part.providerMetadata;
          break;

        case 'error':
          if (part.error instanceof Error) throw part.error;
          throw invalidStream('provider emitted an error');

        case 'raw':
          break;

        default:
          throw invalidStream(
            `unsupported part ${String((part as unknown as Record<string, unknown>).type)}`,
          );
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!finishReason || !usage) throw invalidStream('missing finish part');
  for (const [id, state] of textStates) {
    if (!state.ended) throw invalidStream(`unterminated content id ${id}`);
  }
  for (const [id, state] of toolStates) {
    if (!state.ended || !state.completed) throw invalidStream(`unterminated tool input id ${id}`);
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
}

export const codexLanguageModelMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => {
    const normalized = { ...params };
    delete normalized.maxOutputTokens;
    delete normalized.temperature;
    delete normalized.topP;
    delete normalized.topK;
    delete normalized.presencePenalty;
    delete normalized.frequencyPenalty;
    delete normalized.seed;
    normalized.providerOptions = normalizeProviderOptions(params.providerOptions);
    return normalized;
  },
  wrapGenerate: async ({ doStream }) => aggregateCodexStream(await doStream()),
};

export function wrapCodexLanguageModel(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({ model, middleware: codexLanguageModelMiddleware });
}
