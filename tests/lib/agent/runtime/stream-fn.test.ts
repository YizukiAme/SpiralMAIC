/**
 * Tests for the promoted stream-fn adapter — `toModelMessages` conversion.
 */
import { describe, it, expect } from 'vitest';
import { toModelMessages, createPartMapper } from '@/lib/agent/runtime/stream-fn';
import type { ToolCallProviderMetadata } from '@/lib/agent/runtime/provider-metadata';
import {
  decodeOpenAIReasoningSignature,
  encodeOpenAIReasoningSignature,
} from '@/lib/agent/runtime/provider-metadata';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message as PiMessage,
  ToolCall,
} from '@earendil-works/pi-ai';

function emptyPartial(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'unknown' as never,
    provider: 'unknown' as never,
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
}

describe('createPartMapper — reasoning/thinking channel', () => {
  it('maps reasoning-delta parts to thinking_start + thinking_delta and accumulates a thinking content block', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-start' });
    mapper.handle({ type: 'reasoning-delta', text: 'We ' });
    mapper.handle({ type: 'reasoning-delta', text: 'think' });

    const types = events.map((e) => e.type);
    expect(types).toEqual(['thinking_start', 'thinking_delta', 'thinking_delta']);
    expect(partial.content).toHaveLength(1);
    expect(partial.content[0]).toEqual({ type: 'thinking', thinking: 'We think' });
  });

  it('emits thinking_end with the full reasoning when the reasoning part ends', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'done' });
    mapper.handle({ type: 'reasoning-end' });

    const end = events.find((e) => e.type === 'thinking_end') as Extract<
      AssistantMessageEvent,
      { type: 'thinking_end' }
    >;
    expect(end).toBeDefined();
    expect(end.content).toBe('done');
  });

  it('keeps thinking and text as separate content blocks, thinking first', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'reasoning' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 'answer' });
    mapper.finalize();

    expect(partial.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
    ]);
  });

  it('finalize closes an unterminated thinking block', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));
    mapper.handle({ type: 'reasoning-delta', text: 'x' });
    mapper.finalize();
    expect(events.some((e) => e.type === 'thinking_end')).toBe(true);
  });

  it('opens a SECOND thinking block when reasoning resumes after it ended (same turn)', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'first' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 'answer' });
    mapper.handle({ type: 'reasoning-delta', text: 'second' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.finalize();

    // Two distinct thinking blocks, not one merged block.
    const thinking = partial.content.filter((c) => (c as { type: string }).type === 'thinking');
    expect(thinking).toEqual([
      { type: 'thinking', thinking: 'first' },
      { type: 'thinking', thinking: 'second' },
    ]);
    expect(events.filter((e) => e.type === 'thinking_start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'thinking_end')).toHaveLength(2);
  });

  it('preserves order for a reasoning→text→reasoning→text interleave in one turn', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));

    mapper.handle({ type: 'reasoning-delta', text: 'r1' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 't1' });
    mapper.handle({ type: 'reasoning-delta', text: 'r2' });
    mapper.handle({ type: 'reasoning-end' });
    mapper.handle({ type: 'text-delta', text: 't2' });
    mapper.finalize();

    // Stream order must be preserved as four distinct blocks — t2 must NOT be
    // merged back into the first text block.
    expect(partial.content).toEqual([
      { type: 'thinking', thinking: 'r1' },
      { type: 'text', text: 't1' },
      { type: 'thinking', thinking: 'r2' },
      { type: 'text', text: 't2' },
    ]);
  });

  it('ignores empty reasoning deltas (no thinking block created)', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (e) => events.push(e));
    mapper.handle({ type: 'reasoning-delta', text: '' });
    expect(events).toHaveLength(0);
    expect(partial.content).toHaveLength(0);
  });

  it('attaches merged OpenAI reasoning metadata from start and end to the thinking block', () => {
    const partial = emptyPartial();
    const events: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (event) => events.push(event));

    mapper.handle({
      type: 'reasoning-start',
      id: 'reasoning-1:0',
      providerMetadata: { openai: { itemId: 'reasoning-1' } },
    });
    mapper.handle({ type: 'reasoning-delta', id: 'reasoning-1:0', text: 'private summary' });
    mapper.handle({
      type: 'reasoning-end',
      id: 'reasoning-1:0',
      providerMetadata: { openai: { reasoningEncryptedContent: 'ciphertext-1' } },
    });

    const thinking = partial.content[0] as { thinkingSignature?: string };
    expect(decodeOpenAIReasoningSignature(thinking.thinkingSignature)).toEqual({
      openai: {
        itemId: 'reasoning-1',
        reasoningEncryptedContent: 'ciphertext-1',
      },
    });
  });

  it('captures reasoning metadata from an empty delta before returning', () => {
    const partial = emptyPartial();
    const mapper = createPartMapper(partial, () => undefined);

    mapper.handle({
      type: 'reasoning-start',
      id: 'reasoning-1:0',
      providerMetadata: { openai: { itemId: 'reasoning-1' } },
    });
    mapper.handle({
      type: 'reasoning-delta',
      id: 'reasoning-1:0',
      text: '',
      providerMetadata: { openai: { reasoningEncryptedContent: 'empty-delta-ciphertext' } },
    });
    mapper.handle({ type: 'reasoning-end', id: 'reasoning-1:0' });

    const thinking = partial.content[0] as { thinkingSignature?: string };
    expect(decodeOpenAIReasoningSignature(thinking.thinkingSignature)).toEqual({
      openai: {
        itemId: 'reasoning-1',
        reasoningEncryptedContent: 'empty-delta-ciphertext',
      },
    });
  });

  it('captures metadata on a non-empty delta that opens its reasoning block', () => {
    const partial = emptyPartial();
    const mapper = createPartMapper(partial, () => undefined);

    mapper.handle({
      type: 'reasoning-delta',
      id: 'reasoning-1:0',
      text: 'delta-only reasoning',
      providerMetadata: {
        openai: {
          itemId: 'reasoning-1',
          reasoningEncryptedContent: 'delta-only-ciphertext',
        },
      },
    });
    mapper.handle({ type: 'reasoning-end', id: 'reasoning-1:0' });

    const thinking = partial.content[0] as { thinkingSignature?: string };
    expect(decodeOpenAIReasoningSignature(thinking.thinkingSignature)).toEqual({
      openai: {
        itemId: 'reasoning-1',
        reasoningEncryptedContent: 'delta-only-ciphertext',
      },
    });
  });

  it('binds finish metadata by reasoning item id when multiple thinking blocks exist', () => {
    const partial = emptyPartial();
    const mapper = createPartMapper(partial, () => undefined);

    mapper.handle({
      type: 'reasoning-start',
      id: 'reasoning-1:0',
      providerMetadata: { openai: { itemId: 'reasoning-1' } },
    });
    mapper.handle({ type: 'reasoning-delta', id: 'reasoning-1:0', text: 'first' });
    mapper.handle({
      type: 'reasoning-end',
      id: 'reasoning-1:0',
      providerMetadata: { openai: { reasoningEncryptedContent: 'ciphertext-1' } },
    });
    mapper.handle({
      type: 'reasoning-start',
      id: 'reasoning-2:0',
      providerMetadata: { openai: { itemId: 'reasoning-2' } },
    });
    mapper.handle({ type: 'reasoning-delta', id: 'reasoning-2:0', text: 'second' });
    mapper.handle({ type: 'reasoning-end', id: 'reasoning-2:0' });
    mapper.handle({
      type: 'finish',
      providerMetadata: {
        openai: { itemId: 'reasoning-2', reasoningEncryptedContent: 'ciphertext-2' },
      },
    });

    const thinking = partial.content.filter(
      (content): content is { type: 'thinking'; thinking: string; thinkingSignature?: string } =>
        content.type === 'thinking',
    );
    expect(decodeOpenAIReasoningSignature(thinking[0]?.thinkingSignature)).toEqual({
      openai: { itemId: 'reasoning-1', reasoningEncryptedContent: 'ciphertext-1' },
    });
    expect(decodeOpenAIReasoningSignature(thinking[1]?.thinkingSignature)).toEqual({
      openai: { itemId: 'reasoning-2', reasoningEncryptedContent: 'ciphertext-2' },
    });
  });

  it('binds id-less finish metadata when there is exactly one reasoning block', () => {
    const partial = emptyPartial();
    const mapper = createPartMapper(partial, () => undefined);

    mapper.handle({
      type: 'reasoning-start',
      id: 'reasoning-1:0',
      providerMetadata: { openai: { itemId: 'reasoning-1' } },
    });
    mapper.handle({ type: 'reasoning-delta', id: 'reasoning-1:0', text: 'only block' });
    mapper.handle({ type: 'reasoning-end', id: 'reasoning-1:0' });
    mapper.handle({
      type: 'finish',
      providerMetadata: { openai: { reasoningEncryptedContent: 'ciphertext-1' } },
    });

    const thinking = partial.content[0] as { thinkingSignature?: string };
    expect(decodeOpenAIReasoningSignature(thinking.thinkingSignature)).toEqual({
      openai: { itemId: 'reasoning-1', reasoningEncryptedContent: 'ciphertext-1' },
    });
  });
});

describe('toModelMessages', () => {
  it('restores a recognized encrypted-reasoning signature as provider options', () => {
    const signature = encodeOpenAIReasoningSignature({
      openai: { itemId: 'reasoning-1', reasoningEncryptedContent: 'ciphertext-1' },
    });
    const messages: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'summary text', thinkingSignature: signature },
          { type: 'text', text: 'answer' },
        ],
        api: 'unknown' as never,
        provider: 'unknown' as never,
        model: 'test',
        usage: emptyPartial().usage,
        stopReason: 'stop',
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);
    const parts = (result[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts).toEqual([
      {
        type: 'reasoning',
        text: 'summary text',
        providerOptions: {
          openai: { itemId: 'reasoning-1', reasoningEncryptedContent: 'ciphertext-1' },
        },
      },
      { type: 'text', text: 'answer' },
    ]);
  });

  it.each(['unrelated-provider-signature', 'openmaic:openai-reasoning:v1:{bad-json'])(
    'keeps reasoning text but ignores an unrecognized signature: %s',
    (thinkingSignature) => {
      const thinking = { type: 'thinking' as const, thinking: 'summary text', thinkingSignature };
      const messages: PiMessage[] = [
        {
          role: 'assistant',
          content: [thinking],
          api: 'unknown' as never,
          provider: 'unknown' as never,
          model: 'test',
          usage: emptyPartial().usage,
          stopReason: 'stop',
          timestamp: 0,
        },
      ];

      const result = toModelMessages(messages);
      const parts = (result[0] as { content: Array<Record<string, unknown>> }).content;
      expect(parts).toEqual([{ type: 'reasoning', text: 'summary text' }]);
      expect(thinking.thinkingSignature).toBe(thinkingSignature);
    },
  );

  it('converts assistant toolCall with providerMetadata to tool-call part with providerOptions', () => {
    const toolCallWithMeta: ToolCall & { providerMetadata?: ToolCallProviderMetadata } = {
      type: 'toolCall',
      id: 'call-1',
      name: 'myTool',
      arguments: { x: 1 },
      providerMetadata: { google: { thoughtSignature: 's' } },
    };

    const messages: PiMessage[] = [
      {
        role: 'assistant',
        content: [toolCallWithMeta],
        api: 'unknown' as never,
        provider: 'unknown' as never,
        model: 'test',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    const parts = (result[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('tool-call');
    expect(parts[0].toolCallId).toBe('call-1');
    expect(parts[0].toolName).toBe('myTool');
    expect(parts[0].providerOptions).toEqual({ google: { thoughtSignature: 's' } });
  });

  it('converts toolResult message to AI SDK tool role message', () => {
    const messages: PiMessage[] = [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'myTool',
        content: [{ type: 'text', text: 'result text' }],
        isError: false,
        timestamp: 0,
      },
    ];

    const result = toModelMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    const content = (result[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('tool-result');
    expect(content[0].toolCallId).toBe('call-1');
    expect(content[0].toolName).toBe('myTool');
    expect(content[0].output).toEqual({ type: 'text', value: 'result text' });
  });
});
