/** Typed pass-through of provider-specific per-tool-call metadata (e.g. Gemini
 *  thought_signature) so multi-turn tool conversations don't error. Stored on
 *  the pi ToolCall, re-emitted on the next turn's assistant message part. */
export type ToolCallProviderMetadata = Record<string, Record<string, unknown>>;

export const OPENAI_REASONING_SIGNATURE_PREFIX = 'openmaic:openai-reasoning:v1:';

interface ToolCallPartLike {
  providerMetadata?: ToolCallProviderMetadata;
  providerOptions?: ToolCallProviderMetadata;
  // AI SDK fullStream tool-call parts carry many other fields (type, toolCallId,
  // toolName, input, ...); accept them so callers can pass a part literal.
  [key: string]: unknown;
}

/** Ingest: capture providerMetadata from an AI SDK fullStream tool-call part. */
export function captureToolCallMetadata(
  part: ToolCallPartLike,
): ToolCallProviderMetadata | undefined {
  const meta = part.providerMetadata ?? part.providerOptions;
  if (!meta || Object.keys(meta).length === 0) return undefined;
  return meta;
}

/** Egress: re-emit as providerOptions on the next turn's tool-call message part. */
export function emitToolCallProviderOptions(
  meta: ToolCallProviderMetadata | undefined,
): ToolCallProviderMetadata | undefined {
  return meta && Object.keys(meta).length > 0 ? meta : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Serialize only the non-secret OpenAI fields needed to continue a reasoning item. */
export function encodeOpenAIReasoningSignature(
  metadata: ToolCallProviderMetadata | undefined,
): string | undefined {
  const openai = metadata?.openai;
  if (!isRecord(openai)) return undefined;

  const itemId = nonEmptyString(openai.itemId);
  const reasoningEncryptedContent = nonEmptyString(openai.reasoningEncryptedContent);
  if (!itemId && !reasoningEncryptedContent) return undefined;

  return `${OPENAI_REASONING_SIGNATURE_PREFIX}${JSON.stringify({
    ...(itemId ? { itemId } : {}),
    ...(reasoningEncryptedContent ? { reasoningEncryptedContent } : {}),
  })}`;
}

/** Parse only signatures emitted by the versioned OpenMAIC OpenAI codec. */
export function decodeOpenAIReasoningSignature(
  signature: string | undefined,
): ToolCallProviderMetadata | undefined {
  if (!signature?.startsWith(OPENAI_REASONING_SIGNATURE_PREFIX)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(signature.slice(OPENAI_REASONING_SIGNATURE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (parsed.itemId !== undefined && !nonEmptyString(parsed.itemId)) return undefined;
  if (
    parsed.reasoningEncryptedContent !== undefined &&
    !nonEmptyString(parsed.reasoningEncryptedContent)
  ) {
    return undefined;
  }
  const itemId = nonEmptyString(parsed.itemId);
  const reasoningEncryptedContent = nonEmptyString(parsed.reasoningEncryptedContent);
  if (!itemId && !reasoningEncryptedContent) return undefined;

  return {
    openai: {
      ...(itemId ? { itemId } : {}),
      ...(reasoningEncryptedContent ? { reasoningEncryptedContent } : {}),
    },
  };
}
