import { describe, expect, it, vi } from 'vitest';

import { wrapCodexLanguageModel } from '@/lib/ai/codex-model';

type LanguageModelV3 = Parameters<typeof wrapCodexLanguageModel>[0];
type ModelCallOptions = Parameters<LanguageModelV3['doStream']>[0];

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function createStream(parts: Array<Record<string, unknown>>) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function createLanguageModel(overrides: Partial<LanguageModelV3> = {}): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'openai.responses',
    modelId: 'gpt-test',
    supportedUrls: {},
    doGenerate: vi.fn(async () => ({
      content: [],
      finishReason: { unified: 'stop', raw: 'completed' },
      usage: USAGE,
      warnings: [],
    })),
    doStream: vi.fn(async () => ({
      stream: createStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ]),
    })),
    ...overrides,
  } as LanguageModelV3;
}

async function collectStream(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return parts;
}

describe('Codex language model middleware', () => {
  it('normalizes call options while preserving the raw stream', async () => {
    const streamParts = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        usage: USAGE,
        finishReason: { unified: 'stop', raw: 'completed' },
      },
    ];
    const doStream = vi.fn(async (_options: ModelCallOptions) => ({
      stream: createStream(streamParts) as never,
    }));
    const model = wrapCodexLanguageModel(createLanguageModel({ doStream }));

    const result = await model.doStream({
      prompt: [{ role: 'system', content: 'Keep the OpenMAIC course prompt.' }],
      maxOutputTokens: 100,
      temperature: 0.2,
      topP: 0.9,
      topK: 20,
      presencePenalty: 1,
      frequencyPenalty: 1,
      seed: 7,
      providerOptions: {
        openai: {
          store: true,
          include: ['message.output_text.logprobs'],
          reasoningEffort: 'high',
        },
        other: { keep: true },
      },
    });

    expect(await collectStream(result.stream)).toEqual(streamParts);
    const options = doStream.mock.calls[0]?.[0] as ModelCallOptions;
    expect(options.prompt).toEqual([
      { role: 'system', content: 'Keep the OpenMAIC course prompt.' },
    ]);
    expect(options.maxOutputTokens).toBeUndefined();
    expect(options.temperature).toBeUndefined();
    expect(options.topP).toBeUndefined();
    expect(options.topK).toBeUndefined();
    expect(options.presencePenalty).toBeUndefined();
    expect(options.frequencyPenalty).toBeUndefined();
    expect(options.seed).toBeUndefined();
    expect(options.providerOptions).toEqual({
      openai: {
        store: false,
        include: ['message.output_text.logprobs', 'reasoning.encrypted_content'],
        reasoningEffort: 'high',
        systemMessageMode: 'developer',
        forceReasoning: true,
      },
      other: { keep: true },
    });
  });

  it('implements generate by aggregating the raw stream without losing metadata', async () => {
    const timestamp = new Date('2026-07-15T00:00:00.000Z');
    const warnings = [{ type: 'other', message: 'provider warning' }] as const;
    const doGenerate = vi.fn(async () => {
      throw new Error('underlying doGenerate must not be called');
    });
    const doStream = vi.fn(async () => ({
      request: { body: { sent: true } },
      response: { headers: { 'x-request-id': 'request-1' } },
      stream: createStream([
        { type: 'stream-start', warnings: [...warnings] },
        {
          type: 'response-metadata',
          id: 'response-1',
          timestamp,
          modelId: 'gpt-test-actual',
        },
        {
          type: 'text-start',
          id: 'text-1',
          providerMetadata: { openai: { itemId: 'message-1' } },
        },
        { type: 'text-delta', id: 'text-1', delta: 'Hello ' },
        {
          type: 'text-delta',
          id: 'text-1',
          delta: 'world',
          providerMetadata: { openai: { phase: 'final_answer' } },
        },
        {
          type: 'text-end',
          id: 'text-1',
          providerMetadata: { openai: { annotations: [{ type: 'citation' }] } },
        },
        {
          type: 'reasoning-start',
          id: 'reasoning-1:0',
          providerMetadata: { openai: { itemId: 'reasoning-1' } },
        },
        {
          type: 'reasoning-delta',
          id: 'reasoning-1:0',
          delta: 'Think ',
          providerMetadata: { openai: { reasoningEncryptedContent: 'ciphertext' } },
        },
        { type: 'reasoning-delta', id: 'reasoning-1:0', delta: 'carefully' },
        {
          type: 'reasoning-end',
          id: 'reasoning-1:0',
          providerMetadata: { openai: { retained: 'sibling' } },
        },
        {
          type: 'tool-input-start',
          id: 'call-1',
          toolName: 'lookup',
          providerMetadata: { google: { start: true } },
        },
        { type: 'tool-input-delta', id: 'call-1', delta: '{"city":' },
        {
          type: 'tool-input-delta',
          id: 'call-1',
          delta: '"Paris"}',
          providerMetadata: { google: { delta: true } },
        },
        {
          type: 'tool-input-end',
          id: 'call-1',
          providerMetadata: { google: { end: true } },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'lookup',
          input: '{"city":"Paris"}',
          providerMetadata: { openai: { itemId: 'tool-item-1' } },
        },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          providerMetadata: { openai: { responseId: 'response-1' } },
        },
      ]) as never,
    }));
    const model = wrapCodexLanguageModel(createLanguageModel({ doGenerate, doStream }));

    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });

    expect(doGenerate).not.toHaveBeenCalled();
    expect(doStream).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Hello world',
          providerMetadata: {
            openai: {
              itemId: 'message-1',
              phase: 'final_answer',
              annotations: [{ type: 'citation' }],
            },
          },
        },
        {
          type: 'reasoning',
          text: 'Think carefully',
          providerMetadata: {
            openai: {
              itemId: 'reasoning-1',
              reasoningEncryptedContent: 'ciphertext',
              retained: 'sibling',
            },
          },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'lookup',
          input: '{"city":"Paris"}',
          providerMetadata: {
            google: { start: true, delta: true, end: true },
            openai: { itemId: 'tool-item-1' },
          },
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: USAGE,
      warnings: [...warnings],
      request: { body: { sent: true } },
      response: {
        id: 'response-1',
        timestamp,
        modelId: 'gpt-test-actual',
        headers: { 'x-request-id': 'request-1' },
      },
      providerMetadata: { openai: { responseId: 'response-1' } },
    });
  });

  it('surfaces non-Error stream error parts as safe Error instances', async () => {
    const model = wrapCodexLanguageModel(
      createLanguageModel({
        doStream: vi.fn(async () => ({
          stream: createStream([{ type: 'error', error: 'upstream-secret-body' }]) as never,
        })),
      }),
    );

    const error = await Promise.resolve(
      model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('upstream-secret-body');
  });

  it.each([
    {
      name: 'missing finish metadata',
      parts: [{ type: 'stream-start', warnings: [] }],
      message: /missing finish part/,
    },
    {
      name: 'an unknown required stream part',
      parts: [
        { type: 'future-required-part' },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ],
      message: /unsupported part future-required-part/,
    },
    {
      name: 'unterminated content',
      parts: [
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'partial' },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ],
      message: /unterminated content id text-1/,
    },
  ])('rejects $name instead of silently returning partial output', async ({ parts, message }) => {
    const model = wrapCodexLanguageModel(
      createLanguageModel({
        doStream: vi.fn(async () => ({ stream: createStream(parts) as never })),
      }),
    );

    await expect(
      Promise.resolve(
        model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }),
      ),
    ).rejects.toThrow(message);
  });
});
