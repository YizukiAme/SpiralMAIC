import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_DECODED_STREAM_LIMITS,
  CODEX_STREAM_ERROR_MESSAGE,
  aggregateCodexStream,
  guardCodexStream,
  wrapCodexLanguageModel,
} from '@/lib/ai/codex-model';
import { toModelMessages } from '@/lib/agent/runtime/stream-fn';
import { OPENAI_REASONING_SIGNATURE_PREFIX } from '@/lib/agent/runtime/provider-metadata';

type LanguageModelV3 = Parameters<typeof wrapCodexLanguageModel>[0];
type ModelCallOptions = Parameters<LanguageModelV3['doStream']>[0];

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

const SAFE_STREAM_ERROR_MESSAGE = CODEX_STREAM_ERROR_MESSAGE;

function expectSafeStreamError(error: unknown, secret?: string): asserts error is Error {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: 'CodexStreamError',
    message: SAFE_STREAM_ERROR_MESSAGE,
  });
  for (const field of ['cause', 'originalError', 'responseBody', 'data']) {
    expect(error).not.toHaveProperty(field);
  }
  expect(Object.keys(error as object)).toEqual([]);
  if (secret) expect(String(error)).not.toContain(secret);
}

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

async function readAfter(
  stream: ReadableStream<unknown>,
  successfulReads: number,
): Promise<unknown> {
  const reader = stream.getReader();
  try {
    for (let index = 0; index < successfulReads; index += 1) {
      await expect(reader.read()).resolves.toMatchObject({ done: false });
    }
    return await reader.read().catch((caught: unknown) => caught);
  } finally {
    reader.releaseLock();
  }
}

const TEST_DECODED_STREAM_LIMITS = {
  maxParts: 64,
  maxContentItems: 64,
  maxToolInputBytes: 64,
};

function streamResult(parts: Array<Record<string, unknown>>, options: { stayOpen?: boolean } = {}) {
  const cancel = vi.fn();
  let index = 0;
  const stream = new ReadableStream<Record<string, unknown>>({
    pull(controller) {
      const part = parts[index];
      if (part) {
        index += 1;
        controller.enqueue(part);
        return;
      }
      if (!options.stayOpen) controller.close();
    },
    cancel() {
      cancel();
    },
  });
  return {
    cancel,
    result: { stream: stream as never },
    stream,
  };
}

const CONTENT_ITEM_PARTS = [
  { name: 'text start', part: { type: 'text-start', id: 'text-1' } },
  { name: 'reasoning start', part: { type: 'reasoning-start', id: 'reasoning-1' } },
  {
    name: 'tool input start',
    part: { type: 'tool-input-start', id: 'tool-streamed', toolName: 'lookup' },
  },
  {
    name: 'direct tool call',
    part: { type: 'tool-call', toolCallId: 'tool-direct', toolName: 'lookup', input: '{}' },
  },
  {
    name: 'tool approval request',
    part: {
      type: 'tool-approval-request',
      approvalId: 'approval-1',
      toolCallId: 'tool-approved',
    },
  },
  {
    name: 'tool result',
    part: {
      type: 'tool-result',
      toolCallId: 'tool-result',
      toolName: 'lookup',
      result: { ok: true },
    },
  },
  {
    name: 'file',
    part: { type: 'file', data: 'ZmlsZQ==', mediaType: 'text/plain' },
  },
  {
    name: 'source',
    part: {
      type: 'source',
      sourceType: 'url',
      id: 'source-1',
      url: 'https://example.com',
    },
  },
] as const;

describe('guardCodexStream decoded budgets', () => {
  it('exposes the decoded stream defaults', () => {
    expect(CODEX_DECODED_STREAM_LIMITS).toEqual({
      maxParts: 250_000,
      maxContentItems: 4_096,
      maxToolInputBytes: 4 * 1024 * 1024,
    });
  });

  it('accepts exactly maxParts and rejects one more on the stream path', async () => {
    const exact = streamResult([
      { type: 'raw', rawValue: { index: 1 } },
      { type: 'raw', rawValue: { index: 2 } },
    ]);
    const limits = { ...TEST_DECODED_STREAM_LIMITS, maxParts: 2 };

    await expect(
      collectStream(guardCodexStream(exact.result as never, limits).stream),
    ).resolves.toHaveLength(2);

    const over = streamResult(
      [
        { type: 'raw', rawValue: { index: 1 } },
        { type: 'raw', rawValue: { index: 2 } },
        { type: 'raw', rawValue: { index: 3 } },
      ],
      { stayOpen: true },
    );
    await expect(
      collectStream(guardCodexStream(over.result as never, limits).stream),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it('surfaces a safe budget error and releases the source when cancel never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const source = new ReadableStream<Record<string, unknown>>({
      start(controller) {
        controller.enqueue({ type: 'raw', rawValue: { secret: 'decoded-secret' } });
      },
      cancel,
    });
    const guarded = guardCodexStream(
      { stream: source as never },
      { ...TEST_DECODED_STREAM_LIMITS, maxParts: 0 },
    );

    const outcome = await Promise.race([
      guarded.stream
        .getReader()
        .read()
        .catch((error: unknown) => error),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).not.toBe('timed-out');
    expectSafeStreamError(outcome, 'decoded-secret');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(source.locked).toBe(false);
  });

  it('settles consumer cancellation and releases the source when cancel never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const source = new ReadableStream<Record<string, unknown>>({ cancel });
    const guarded = guardCodexStream({ stream: source as never });

    const outcome = await Promise.race([
      guarded.stream.cancel().then(() => 'cancelled' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).toBe('cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(source.locked).toBe(false);
  });

  it('applies the same maxParts boundary before generate aggregation', async () => {
    const finish = {
      type: 'finish',
      usage: USAGE,
      finishReason: { unified: 'stop', raw: 'completed' },
    };
    const limits = { ...TEST_DECODED_STREAM_LIMITS, maxParts: 2 };
    const exact = streamResult([{ type: 'stream-start', warnings: [] }, finish]);

    await expect(
      aggregateCodexStream(guardCodexStream(exact.result as never, limits)),
    ).resolves.toMatchObject({ content: [], usage: USAGE });

    const over = streamResult(
      [{ type: 'stream-start', warnings: [] }, { type: 'raw', rawValue: {} }, finish],
      { stayOpen: true },
    );
    await expect(
      aggregateCodexStream(guardCodexStream(over.result as never, limits)),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly maxContentItems and rejects one more', async () => {
    const parts = CONTENT_ITEM_PARTS.map(({ part }) => part);
    const limits = { ...TEST_DECODED_STREAM_LIMITS, maxContentItems: parts.length };
    const exact = streamResult([...parts]);

    await expect(
      collectStream(guardCodexStream(exact.result as never, limits).stream),
    ).resolves.toHaveLength(parts.length);

    const over = streamResult(
      [
        ...parts,
        {
          type: 'source',
          sourceType: 'url',
          id: 'source-over',
          url: 'https://example.com/over',
        },
      ],
      { stayOpen: true },
    );
    await expect(
      collectStream(guardCodexStream(over.result as never, limits).stream),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(CONTENT_ITEM_PARTS)('counts $name as one content item', async ({ part }) => {
    const source = streamResult([part], { stayOpen: true });

    await expect(
      collectStream(
        guardCodexStream(source.result as never, {
          ...TEST_DECODED_STREAM_LIMITS,
          maxContentItems: 0,
        }).stream,
      ),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'ASCII', input: 'test', bytes: 4 },
    { label: 'CJK', input: '你好', bytes: 6 },
    { label: 'emoji', input: '🙂', bytes: 4 },
  ])('counts streamed $label tool input as UTF-8 bytes', async ({ input, bytes }) => {
    const limits = { ...TEST_DECODED_STREAM_LIMITS, maxToolInputBytes: bytes };
    const exact = streamResult([
      { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'tool-1', delta: input },
    ]);

    await expect(
      collectStream(guardCodexStream(exact.result as never, limits).stream),
    ).resolves.toHaveLength(2);

    const over = streamResult(
      [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'tool-1', delta: `${input}a` },
      ],
      { stayOpen: true },
    );
    await expect(
      collectStream(guardCodexStream(over.result as never, limits).stream),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it('counts streamed tool-input deltas incrementally', async () => {
    const exactParts = [
      { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'tool-1', delta: 'A' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '你' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '🙂' },
    ];
    const limits = { ...TEST_DECODED_STREAM_LIMITS, maxToolInputBytes: 8 };
    const exact = streamResult(exactParts);

    await expect(
      collectStream(guardCodexStream(exact.result as never, limits).stream),
    ).resolves.toHaveLength(exactParts.length);

    const over = streamResult(
      [...exactParts, { type: 'tool-input-delta', id: 'tool-1', delta: '!' }],
      { stayOpen: true },
    );
    await expect(
      collectStream(guardCodexStream(over.result as never, limits).stream),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it('counts a final tool call after an empty streamed delta', async () => {
    const input = 'final-tool-input-secret';
    const source = streamResult(
      [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'tool-1', delta: '' },
        { type: 'tool-input-end', id: 'tool-1' },
        { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input },
      ],
      { stayOpen: true },
    );

    const error = await readAfter(
      guardCodexStream(source.result as never, {
        ...TEST_DECODED_STREAM_LIMITS,
        maxToolInputBytes: 1,
      }).stream,
      3,
    );
    expectSafeStreamError(error, input);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('counts a split surrogate pair as its concatenated UTF-8 bytes', async () => {
    const exactParts = [
      { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '\ud83d' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '\ude42' },
      { type: 'tool-input-end', id: 'tool-1' },
    ];
    const limits = { ...TEST_DECODED_STREAM_LIMITS, maxToolInputBytes: 4 };
    const exact = streamResult(exactParts);

    await expect(
      collectStream(guardCodexStream(exact.result as never, limits).stream),
    ).resolves.toHaveLength(exactParts.length);

    const over = streamResult(
      [...exactParts.slice(0, -1), { type: 'tool-input-delta', id: 'tool-1', delta: 'a' }],
      { stayOpen: true },
    );
    await expect(
      collectStream(guardCodexStream(over.result as never, limits).stream),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it('counts a trailing high surrogate before forwarding its delta', async () => {
    const source = streamResult(
      [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'tool-1', delta: '\ud83d' },
      ],
      { stayOpen: true },
    );

    const error = await readAfter(
      guardCodexStream(source.result as never, {
        ...TEST_DECODED_STREAM_LIMITS,
        maxToolInputBytes: 2,
      }).stream,
      1,
    );
    expectSafeStreamError(error);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an orphan tool-input delta before forwarding it', async () => {
    const secret = 'orphan-tool-input-secret';
    const source = streamResult([{ type: 'tool-input-delta', id: 'missing-tool', delta: secret }], {
      stayOpen: true,
    });

    const error = await readAfter(
      guardCodexStream(source.result as never, TEST_DECODED_STREAM_LIMITS).stream,
      0,
    );
    expectSafeStreamError(error, secret);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('counts repeated direct tool-call events independently', async () => {
    const direct = {
      type: 'tool-call',
      toolCallId: 'repeated-tool',
      toolName: 'lookup',
      input: '{}',
    };
    const limits = {
      ...TEST_DECODED_STREAM_LIMITS,
      maxContentItems: 2,
      maxToolInputBytes: 2,
    };
    const exact = streamResult([direct, direct]);

    await expect(
      collectStream(guardCodexStream(exact.result as never, limits).stream),
    ).resolves.toHaveLength(2);

    const over = streamResult([direct, direct, direct], { stayOpen: true });
    await expect(
      collectStream(guardCodexStream(over.result as never, limits).stream),
    ).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized final tool call after non-empty streamed input', async () => {
    const input = 'oversized-final-tool-input-secret';
    const source = streamResult(
      [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'tool-1', delta: 'a' },
        { type: 'tool-input-end', id: 'tool-1' },
        { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input },
      ],
      { stayOpen: true },
    );

    const error = await readAfter(
      guardCodexStream(source.result as never, {
        ...TEST_DECODED_STREAM_LIMITS,
        maxToolInputBytes: 1,
      }).stream,
      3,
    );
    expectSafeStreamError(error, input);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a repeated final for one completed streamed tool item', async () => {
    const final = {
      type: 'tool-call',
      toolCallId: 'tool-1',
      toolName: 'lookup',
      input: '{}',
    };
    const source = streamResult(
      [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-end', id: 'tool-1' },
        final,
        final,
      ],
      { stayOpen: true },
    );

    const error = await readAfter(
      guardCodexStream(source.result as never, {
        ...TEST_DECODED_STREAM_LIMITS,
        maxContentItems: 1,
      }).stream,
      3,
    );
    expectSafeStreamError(error);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'final before tool-input end',
      parts: [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input: '{}' },
      ],
      successfulReads: 1,
    },
    {
      label: 'delta after tool-input end',
      parts: [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-end', id: 'tool-1' },
        { type: 'tool-input-delta', id: 'tool-1', delta: '{}' },
      ],
      successfulReads: 2,
    },
    {
      label: 'repeated tool-input end',
      parts: [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-end', id: 'tool-1' },
        { type: 'tool-input-end', id: 'tool-1' },
      ],
      successfulReads: 2,
    },
  ])('rejects the premature streamed tool phase: $label', async ({ parts, successfulReads }) => {
    const source = streamResult(parts, { stayOpen: true });

    const error = await readAfter(
      guardCodexStream(source.result as never, TEST_DECODED_STREAM_LIMITS).stream,
      successfulReads,
    );
    expectSafeStreamError(error);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not double-count final tool-call input after streamed deltas', async () => {
    const input = 'A你🙂';
    const source = streamResult([
      { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
      { type: 'tool-input-delta', id: 'tool-1', delta: 'A' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '你' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '🙂' },
      { type: 'tool-input-end', id: 'tool-1' },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input },
    ]);

    await expect(
      collectStream(
        guardCodexStream(source.result as never, {
          ...TEST_DECODED_STREAM_LIMITS,
          maxToolInputBytes: 8,
        }).stream,
      ),
    ).resolves.toHaveLength(6);
  });

  it('counts a direct final tool call once', async () => {
    const input = 'A你🙂';
    const limits = { ...TEST_DECODED_STREAM_LIMITS, maxToolInputBytes: 8 };
    const exact = streamResult([
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input },
    ]);

    await expect(
      collectStream(guardCodexStream(exact.result as never, limits).stream),
    ).resolves.toHaveLength(1);

    const over = streamResult(
      [{ type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input: `${input}!` }],
      { stayOpen: true },
    );
    const error = await collectStream(guardCodexStream(over.result as never, limits).stream).catch(
      (caught: unknown) => caught,
    );
    expectSafeStreamError(error, input);
    expect(over.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'generated delta',
      parts: [{ type: 'text-delta', id: 'text-1', delta: 'generated-delta-secret' }],
      limits: { ...TEST_DECODED_STREAM_LIMITS, maxParts: 0 },
      secret: 'generated-delta-secret',
    },
    {
      label: 'tool input',
      parts: [
        { type: 'tool-input-start', id: 'tool-1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'tool-1', delta: 'tool-input-secret' },
      ],
      limits: { ...TEST_DECODED_STREAM_LIMITS, maxToolInputBytes: 1 },
      secret: 'tool-input-secret',
    },
  ])(
    'does not expose the rejected $label in the limit error',
    async ({ parts, limits, secret }) => {
      const source = streamResult(parts, { stayOpen: true });

      const error = await collectStream(
        guardCodexStream(source.result as never, limits).stream,
      ).catch((caught: unknown) => caught);
      expectSafeStreamError(error, secret);
      expect(source.cancel).toHaveBeenCalledTimes(1);
    },
  );
});

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

  it('merges priority with existing OpenAI reasoning options', async () => {
    const doStream = vi.fn(async (_options: ModelCallOptions) => ({
      stream: createStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ]) as never,
    }));
    const model = wrapCodexLanguageModel(createLanguageModel({ doStream }), {
      serviceTier: 'priority',
    });

    await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });

    expect(doStream.mock.calls[0]?.[0].providerOptions?.openai).toMatchObject({
      reasoningEffort: 'high',
      serviceTier: 'priority',
    });
  });

  it('strips only decoded OpenAI item ids at Codex egress without mutating replay metadata', async () => {
    const doStream = vi.fn(async (_options: ModelCallOptions) => ({
      stream: createStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ]) as never,
    }));
    const model = wrapCodexLanguageModel(createLanguageModel({ doStream }));
    const prompt = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'reasoning',
            text: 'summary',
            providerOptions: {
              openai: {
                itemId: 'reasoning-item-1',
                reasoningEncryptedContent: 'ciphertext-1',
                retained: 'openai-sibling',
              },
              google: { thoughtSignature: 'reasoning-google-signature' },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: { city: 'Paris' },
            providerOptions: {
              openai: { itemId: 'tool-item-1', retained: 'tool-sibling' },
              google: { thoughtSignature: 'tool-google-signature' },
            },
          },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'lookup',
            output: { type: 'text', value: 'sunny' },
          },
        ],
      },
    ];
    const originalPrompt = structuredClone(prompt);

    await model.doStream({ prompt: prompt as ModelCallOptions['prompt'] });

    const replay = doStream.mock.calls[0]?.[0].prompt as Array<Record<string, unknown>>;
    expect(replay).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'summary',
            providerOptions: {
              openai: {
                reasoningEncryptedContent: 'ciphertext-1',
                retained: 'openai-sibling',
              },
              google: { thoughtSignature: 'reasoning-google-signature' },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: { city: 'Paris' },
            providerOptions: {
              openai: { retained: 'tool-sibling' },
              google: { thoughtSignature: 'tool-google-signature' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'lookup',
            output: { type: 'text', value: 'sunny' },
          },
        ],
      },
    ]);
    expect(prompt).toEqual(originalPrompt);
  });

  it('drops empty OpenAI replay metadata from a legacy itemId-only signature', async () => {
    const doStream = vi.fn(async (_options: ModelCallOptions) => ({
      stream: createStream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ]) as never,
    }));
    const model = wrapCodexLanguageModel(createLanguageModel({ doStream }));
    const prompt = toModelMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'legacy summary',
            thinkingSignature: `${OPENAI_REASONING_SIGNATURE_PREFIX}{"itemId":"legacy-reasoning-item"}`,
          },
        ],
        api: 'unknown',
        provider: 'unknown',
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
      } as never,
    ]);
    expect(prompt).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'legacy summary',
            providerOptions: { openai: { itemId: 'legacy-reasoning-item' } },
          },
        ],
      },
    ]);

    await model.doStream({
      prompt: prompt as ModelCallOptions['prompt'],
    });

    expect(doStream.mock.calls[0]?.[0].prompt).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'legacy summary' }],
      },
    ]);
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

  it('wires the decoded content budget through the actual generate middleware path', async () => {
    const source = streamResult(
      [
        { type: 'stream-start', warnings: [] },
        ...Array.from({ length: CODEX_DECODED_STREAM_LIMITS.maxContentItems + 1 }, (_, index) => ({
          type: 'source',
          sourceType: 'url',
          id: `source-${index}`,
          url: 'https://example.com',
        })),
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ],
      { stayOpen: true },
    );
    const model = wrapCodexLanguageModel(
      createLanguageModel({ doStream: vi.fn(async () => source.result as never) }),
    );

    const error = await Promise.resolve(
      model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).catch((caught: unknown) => caught);

    expectSafeStreamError(error);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a hung source cancel when aggregation rejects a malformed stream', async () => {
    const secret = 'aggregate-source-secret';
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const source = new ReadableStream<Record<string, unknown>>({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: 'missing', delta: secret });
      },
      cancel,
    });

    const outcome = await Promise.race([
      aggregateCodexStream({ stream: source as never }).catch((error: unknown) => error),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).not.toBe('timed-out');
    expectSafeStreamError(outcome, secret);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(source.locked).toBe(false);
  });

  it.each([
    ['an Error', new Error('raw-error-secret')],
    ['a non-Error', { message: 'object-error-secret', token: 'secret-token' }],
  ])('replaces %s stream error part with a fresh safe error', async (_label, upstreamError) => {
    const model = wrapCodexLanguageModel(
      createLanguageModel({
        doStream: vi.fn(async () => ({
          stream: createStream([{ type: 'error', error: upstreamError }]) as never,
        })),
      }),
    );

    const error = await Promise.resolve(
      model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }),
    ).catch((caught: unknown) => caught);

    expectSafeStreamError(error, 'secret');
    expect(error).not.toBe(upstreamError);
  });

  it.each(['generate', 'stream'] as const)(
    'sanitizes an underlying doStream rejection on the %s path',
    async (path) => {
      const upstreamError = Object.assign(new Error('do-stream-rejection-secret'), {
        responseBody: 'secret-response-body',
      });
      const model = wrapCodexLanguageModel(
        createLanguageModel({ doStream: vi.fn(async () => Promise.reject(upstreamError)) }),
      );
      const options: ModelCallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      };

      const error = await Promise.resolve(
        path === 'generate' ? model.doGenerate(options) : model.doStream(options),
      ).catch((caught: unknown) => caught);

      expectSafeStreamError(error, 'secret');
      expect(error).not.toBe(upstreamError);
      expect(error).not.toHaveProperty('responseBody');
    },
  );

  it.each([401, 403, 429] as const)(
    'copies safe status %s from a rejection cause without retaining the cause',
    async (statusCode) => {
      const upstreamError = Object.assign(new Error('outer-secret'), {
        cause: Object.assign(new Error('inner-secret'), { upstreamStatus: statusCode }),
      });
      const model = wrapCodexLanguageModel(
        createLanguageModel({ doStream: vi.fn(async () => Promise.reject(upstreamError)) }),
      );

      const error = await Promise.resolve(
        model.doStream({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }),
      ).catch((caught: unknown) => caught);

      expectSafeStreamError(error, 'secret');
      expect(error).toHaveProperty('statusCode', statusCode);
      expect(error).not.toHaveProperty('upstreamStatus');
    },
  );

  it.each(['403', 403.5, 200, 500, Number.NaN, { value: 403 }])(
    'does not copy an unapproved or non-numeric status %o',
    async (statusCode) => {
      const model = wrapCodexLanguageModel(
        createLanguageModel({
          doStream: vi.fn(async () => Promise.reject({ statusCode, message: 'status-secret' })),
        }),
      );

      const error = await Promise.resolve(
        model.doStream({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }),
      ).catch((caught: unknown) => caught);

      expectSafeStreamError(error, 'secret');
      expect(error).not.toHaveProperty('statusCode');
    },
  );

  it('sanitizes every streaming error part while preserving all other parts', async () => {
    const rawError = new Error('stream-part-secret');
    const streamParts = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      { type: 'error', error: rawError },
      { type: 'error', error: { message: 'second-stream-secret' } },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        usage: USAGE,
        finishReason: { unified: 'stop', raw: 'completed' },
      },
    ];
    const model = wrapCodexLanguageModel(
      createLanguageModel({
        doStream: vi.fn(async () => ({ stream: createStream(streamParts) as never })),
      }),
    );

    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
    const parts = await collectStream(result.stream);

    expect(parts.filter((part) => (part as { type?: string }).type !== 'error')).toEqual(
      streamParts.filter((part) => part.type !== 'error'),
    );
    const errorParts = parts.filter(
      (part): part is { type: 'error'; error: unknown } =>
        (part as { type?: string }).type === 'error',
    );
    expect(errorParts).toHaveLength(2);
    for (const part of errorParts) expectSafeStreamError(part.error, 'secret');
    expect(errorParts[0]?.error).not.toBe(rawError);
  });

  it('sanitizes an asynchronous source-stream failure', async () => {
    const upstreamError = new Error('reader-failure-secret');
    const model = wrapCodexLanguageModel(
      createLanguageModel({
        doStream: vi.fn(async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.error(upstreamError);
            },
          }) as never,
        })),
      }),
    );
    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });

    const error = await collectStream(result.stream).catch((caught: unknown) => caught);
    expectSafeStreamError(error, 'secret');
    expect(error).not.toBe(upstreamError);
  });

  it.each([
    {
      name: 'missing finish metadata',
      parts: [{ type: 'stream-start', warnings: [] }],
      secret: undefined,
    },
    {
      name: 'an unknown required stream part',
      parts: [
        { type: 'future-required-part-secret' },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ],
      secret: 'future-required-part-secret',
    },
    {
      name: 'a delta carrying an unknown secret id',
      parts: [
        { type: 'text-delta', id: 'upstream-secret-id', delta: 'partial' },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ],
      secret: 'upstream-secret-id',
    },
    {
      name: 'unterminated content',
      parts: [
        { type: 'text-start', id: 'unterminated-secret-id' },
        { type: 'text-delta', id: 'unterminated-secret-id', delta: 'partial' },
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: 'stop', raw: 'completed' },
        },
      ],
      secret: 'unterminated-secret-id',
    },
  ])('rejects $name with one stable safe error', async ({ parts, secret }) => {
    const model = wrapCodexLanguageModel(
      createLanguageModel({
        doStream: vi.fn(async () => ({ stream: createStream(parts) as never })),
      }),
    );

    const error = await Promise.resolve(
      model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).catch((caught: unknown) => caught);

    expectSafeStreamError(error, secret);
  });

  it('cancels the source reader when aggregation fails', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'future-required-part-secret' });
      },
      cancel,
    });
    const model = wrapCodexLanguageModel(
      createLanguageModel({ doStream: vi.fn(async () => ({ stream: stream as never })) }),
    );

    await expect(
      Promise.resolve(
        model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }),
      ),
    ).rejects.toThrow(SAFE_STREAM_ERROR_MESSAGE);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
