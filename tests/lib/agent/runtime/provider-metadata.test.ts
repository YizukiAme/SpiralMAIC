import { describe, it, expect } from 'vitest';
import {
  captureToolCallMetadata,
  decodeOpenAIReasoningSignature,
  encodeOpenAIReasoningSignature,
  emitToolCallProviderOptions,
  OPENAI_REASONING_SIGNATURE_PREFIX,
} from '@/lib/agent/runtime/provider-metadata';

describe('provider-metadata seam', () => {
  it('captures google thoughtSignature from a fullStream tool-call part', () => {
    const part = {
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'x',
      input: {},
      providerMetadata: { google: { thoughtSignature: 'sig-abc' } },
    };
    expect(captureToolCallMetadata(part)).toEqual({ google: { thoughtSignature: 'sig-abc' } });
  });
  it('returns undefined when no provider metadata present', () => {
    expect(
      captureToolCallMetadata({ type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {} }),
    ).toBeUndefined();
  });
  it('re-emits captured metadata as providerOptions for the next turn', () => {
    expect(emitToolCallProviderOptions({ google: { thoughtSignature: 'sig-abc' } })).toEqual({
      google: { thoughtSignature: 'sig-abc' },
    });
  });
  it('round-trips: capture then emit is identity', () => {
    const meta = { google: { thoughtSignature: 's' } };
    expect(
      emitToolCallProviderOptions(captureToolCallMetadata({ providerMetadata: meta })),
    ).toEqual(meta);
  });
});

describe('OpenAI encrypted reasoning signature', () => {
  it('round-trips only itemId and encrypted reasoning content with a versioned prefix', () => {
    const signature = encodeOpenAIReasoningSignature({
      openai: {
        itemId: 'reasoning-1',
        reasoningEncryptedContent: 'encrypted-content',
        responseId: 'must-not-be-serialized',
        accessToken: 'must-not-be-serialized',
        accountId: 'must-not-be-serialized',
      },
    });

    expect(signature).toMatch(new RegExp(`^${OPENAI_REASONING_SIGNATURE_PREFIX}`));
    expect(JSON.parse(signature!.slice(OPENAI_REASONING_SIGNATURE_PREFIX.length))).toEqual({
      itemId: 'reasoning-1',
      reasoningEncryptedContent: 'encrypted-content',
    });
    expect(decodeOpenAIReasoningSignature(signature)).toEqual({
      openai: {
        itemId: 'reasoning-1',
        reasoningEncryptedContent: 'encrypted-content',
      },
    });
  });

  it.each([
    undefined,
    '',
    'unrelated-provider-signature',
    `${OPENAI_REASONING_SIGNATURE_PREFIX}{bad-json`,
    `${OPENAI_REASONING_SIGNATURE_PREFIX}{"itemId":1}`,
  ])('ignores unknown or malformed signature %s', (signature) => {
    expect(decodeOpenAIReasoningSignature(signature)).toBeUndefined();
  });
});
