import { describe, expect, it, vi } from 'vitest';

import {
  acceptanceExitCode,
  formatSafeReport,
  parseAcceptanceArgs,
  parseJsonSse,
  runCodexAcceptance,
  validateCodexCatalog,
  validateCodexImageCapability,
  validateCodexImageJson,
  validateEditorEvents,
  validateOutlineEvents,
  validateSceneJson,
  validateVerificationJson,
  type SafeReport,
} from '@/scripts/codex-acceptance-lib';
import type { GeneratedSlideContent } from '@/lib/types/generation';
import {
  ACCEPTANCE_JSON_MAX_BYTES,
  ACCEPTANCE_IMAGE_JSON_MAX_BYTES,
  ACCEPTANCE_SSE_MAX_BYTES,
  ACCEPTANCE_SSE_MAX_DATA_LINES,
  ACCEPTANCE_SSE_MAX_EVENTS,
  ACCEPTANCE_SSE_MAX_FRAME_BYTES,
  ACCEPTANCE_SSE_MAX_FRAMES,
  requireJson,
  requireCodexImageJson,
  responseEvents,
  safeFetch,
} from '@/scripts/codex-acceptance-http';

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function sse(events: unknown[], status = 200): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function catalog(priority: boolean, imageAvailable = false) {
  const capabilities = {
    streaming: true,
    tools: true,
    ...(priority ? { serviceTiers: ['priority'] } : {}),
  };
  return {
    success: true,
    providers: {
      'openai-codex': {
        models: ['gpt-acceptance'],
        fastModels: priority ? ['gpt-acceptance'] : [],
        modelCatalog: [
          {
            id: 'gpt-acceptance',
            name: 'GPT Acceptance',
            capabilities,
            source: 'probed',
          },
        ],
      },
    },
    image: imageAvailable ? { 'codex-image': { models: ['gpt-image-2'] } } : {},
  };
}

function pngBase64(width = 1536, height = 864): string {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
}

const outlineEvents = [
  { type: 'languageDirective', data: 'Teach in English.' },
  {
    type: 'outline',
    index: 0,
    data: {
      id: 'outline-1',
      type: 'slide',
      title: 'Two plus two',
      description: 'A tiny arithmetic lesson.',
      keyPoints: ['2 + 2 = 4'],
      order: 0,
    },
  },
  {
    type: 'done',
    outlines: [
      {
        id: 'outline-1',
        type: 'slide',
        title: 'Two plus two',
        description: 'A tiny arithmetic lesson.',
        keyPoints: ['2 + 2 = 4'],
        order: 0,
      },
    ],
    languageDirective: 'Teach in English.',
    taskEngineMode: false,
  },
];

const editorEvents = [
  { type: 'agent_start' },
  {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'read_scene_content',
    args: { sceneId: 'acceptance-scene' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'read_scene_content',
    result: { content: [{ type: 'text', text: 'private scene text' }] },
    isError: false,
  },
  {
    type: 'turn_end',
    message: { role: 'assistant', content: [] },
    toolResults: [],
  },
  { type: 'turn_start' },
  {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'private answer' }] },
    assistantMessageEvent: { type: 'text_delta', delta: 'private answer' },
  },
  { type: 'agent_end', messages: [] },
];

const canonicalTextElement = {
  id: 'element-1',
  type: 'text',
  left: 80,
  top: 80,
  width: 840,
  height: 120,
  rotate: 0,
  content: '<p>2 + 2 = 4</p>',
  defaultFontName: 'Arial',
  defaultColor: '#000000',
} satisfies GeneratedSlideContent['elements'][number];

const canonicalSlideContent = {
  elements: [canonicalTextElement],
  background: { type: 'solid', color: '#ffffff' },
  remark: 'A short arithmetic slide.',
} satisfies GeneratedSlideContent;

function connectedFetch(priority: boolean, editorEnabled = true, imageResponse?: () => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/access-code/status') {
      return json({ success: true, enabled: false, authenticated: false });
    }
    if (url.pathname === '/api/codex/auth') {
      return json({
        available: true,
        reason: 'AVAILABLE',
        methods: ['browser', 'device'],
        connected: true,
        email: 'must-not-print@example.test',
      });
    }
    if (url.pathname === '/api/server-providers') {
      return json(catalog(priority, imageResponse !== undefined));
    }
    if (url.pathname === '/api/generate/image' && imageResponse) return imageResponse();
    if (url.pathname === '/api/verify-model') {
      return json({
        success: true,
        message: 'Connection successful',
        response: 'full generated text must never be printed',
      });
    }
    if (url.pathname === '/api/generate/scene-outlines-stream') return sse(outlineEvents);
    if (url.pathname === '/api/generate/scene-content') {
      return json({
        success: true,
        content: canonicalSlideContent,
        effectiveOutline: {
          id: 'acceptance-outline',
          type: 'slide',
          title: 'Two plus two',
          description: 'Show that 2 + 2 = 4.',
          keyPoints: ['2 + 2 = 4'],
          order: 0,
        },
      });
    }
    if (url.pathname === '/api/agent/edit') {
      return editorEnabled ? sse(editorEvents) : new Response('Not found', { status: 404 });
    }
    throw new Error(`unexpected test route ${url.pathname} ${init?.method ?? 'GET'}`);
  });
}

describe('Codex acceptance argument parsing', () => {
  it('accepts one HTTP(S) origin and signed-out mode', () => {
    expect(
      parseAcceptanceArgs(['--base-url', 'https://example.test:3443/', '--expect-signed-out']),
    ).toEqual({
      baseUrl: 'https://example.test:3443',
      expectSignedOut: true,
      editorMode: 'enabled',
      includeImage: false,
    });
    expect(parseAcceptanceArgs(['--', '--base-url', 'http://localhost:3000'])).toEqual({
      baseUrl: 'http://localhost:3000',
      expectSignedOut: false,
      editorMode: 'enabled',
      includeImage: false,
    });
    expect(
      parseAcceptanceArgs(['--base-url', 'http://localhost:3000', '--editor-mode', 'disabled']),
    ).toEqual({
      baseUrl: 'http://localhost:3000',
      expectSignedOut: false,
      editorMode: 'disabled',
      includeImage: false,
    });
    expect(parseAcceptanceArgs(['--base-url', 'http://localhost:3000', '--include-image'])).toEqual(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'enabled',
        includeImage: true,
      },
    );
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.42:3000',
    'http://127.1:3000',
    'http://2130706433:3000',
    'http://[::1]:3000',
  ])('allows cleartext acceptance only for loopback origin %s', (baseUrl) => {
    expect(parseAcceptanceArgs(['--base-url', baseUrl]).baseUrl).toMatch(/^http:/);
  });

  it.each(['http://example.test:3000', 'http://192.168.1.10:3000', 'http://[::2]:3000'])(
    'rejects a remote cleartext acceptance origin %s',
    (baseUrl) => {
      expect(() => parseAcceptanceArgs(['--base-url', baseUrl])).toThrowError('argument');
    },
  );

  it.each([
    [[]],
    [['--base-url']],
    [['--base-url', 'file:///tmp/openmaic']],
    [['--base-url', 'https://user:password@example.test']],
    [['--base-url', 'https://example.test/path']],
    [['--base-url', 'https://example.test?secret=x']],
    [['--base-url', 'https://example.test', '--unknown']],
    [['--base-url', 'https://example.test', '--editor-mode']],
    [['--base-url', 'https://example.test', '--editor-mode', 'auto']],
    [
      [
        '--base-url',
        'https://example.test',
        '--editor-mode',
        'enabled',
        '--editor-mode',
        'disabled',
      ],
    ],
    [['--base-url', 'https://one.test', '--base-url', 'https://two.test']],
    [['--base-url', 'https://example.test', '--include-image', '--include-image']],
    [['--base-url', 'https://example.test', '--expect-signed-out', '--include-image']],
  ])('rejects invalid or ambiguous arguments: %j', (argv) => {
    expect(() => parseAcceptanceArgs(argv)).toThrowError('argument');
  });
});

describe('safe acceptance reports', () => {
  it('formats only the report allowlist and fully drops credentials and raw errors', () => {
    const unsafe = {
      outcome: 'FAIL',
      stage: 'catalog',
      modelId: 'gpt-safe',
      httpStatus: 502,
      connected: false,
      modelCount: 0,
      errorCategory: 'upstream',
      accessCode: 'access-code-sentinel',
      cookie: 'openmaic_access=cookie-sentinel',
      email: 'person@example.test',
      rawSse: 'data: bearer-token-sentinel',
      response: 'full-generation-sentinel',
      error: new Error('provider-body-sentinel'),
    } as SafeReport & Record<string, unknown>;

    const line = formatSafeReport(unsafe);

    expect(line).toBe(
      'FAIL stage=catalog model=gpt-safe http=502 connected=false modelCount=0 error=upstream',
    );
    expect(line).not.toMatch(
      /access-code-sentinel|cookie-sentinel|person@example|bearer-token|full-generation|provider-body/,
    );
  });

  it('treats SKIP as non-failing and any FAIL as a failing process', () => {
    expect(
      acceptanceExitCode([
        { outcome: 'PASS', stage: 'auth' },
        { outcome: 'SKIP', stage: 'fast', priorityAdvertised: false },
      ]),
    ).toBe(0);
    expect(
      acceptanceExitCode([
        { outcome: 'PASS', stage: 'auth' },
        { outcome: 'FAIL', stage: 'scene-json', errorCategory: 'invalid-shape' },
      ]),
    ).toBe(1);
  });

  it('prints only the allowlisted image metadata and drops payload-like fields', () => {
    const report = {
      outcome: 'PASS',
      stage: 'image-generation',
      modelId: 'gpt-image-2',
      httpStatus: 200,
      providerPresent: true,
      generated: true,
      mimeType: 'image/png',
      width: 1536,
      height: 864,
      base64: 'private-image-payload',
      prompt: 'private-image-prompt',
    } as SafeReport & Record<string, unknown>;

    expect(formatSafeReport(report)).toBe(
      'PASS stage=image-generation model=gpt-image-2 http=200 mime=image/png width=1536 height=864',
    );
    expect(formatSafeReport(report)).not.toMatch(/private-image-payload|private-image-prompt/);
  });
});

describe('SSE and JSON validation', () => {
  it('parses chunked CRLF SSE in wire order without exposing raw frames', async () => {
    const chunks = [
      'event: message\r\ndata: {"type":"outline",',
      '"index":0,"data":{"id":"one"}}\r\n\r\n',
      ': heartbeat\r\ndata: {"type":"done","outlines":[{"id":"one"}]}\r\n\r\n',
    ];

    await expect(parseJsonSse(chunks)).resolves.toEqual([
      { type: 'outline', index: 0, data: { id: 'one' } },
      { type: 'done', outlines: [{ id: 'one' }] },
    ]);
  });

  it('rejects a JSON response larger than the bounded acceptance budget', async () => {
    const sentinel = 'oversized-json-private-sentinel';
    const response = new Response(
      JSON.stringify({ sentinel, padding: 'x'.repeat(ACCEPTANCE_JSON_MAX_BYTES) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const error = (await requireJson(response).catch((caught) => caught)) as Error;
    expect(error.message).toBe('invalid-json');
    expect(error.message).not.toContain(sentinel);
  });

  it('uses a separate bounded budget for one opt-in image response', async () => {
    const largerThanGeneric = JSON.stringify({ padding: 'x'.repeat(ACCEPTANCE_JSON_MAX_BYTES) });
    await expect(requireJson(new Response(largerThanGeneric))).rejects.toThrowError('invalid-json');
    await expect(requireCodexImageJson(new Response(largerThanGeneric))).resolves.toMatchObject({
      padding: expect.any(String),
    });

    const cancel = vi.fn();
    const oversized = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-length': String(ACCEPTANCE_IMAGE_JSON_MAX_BYTES + 1) },
    });
    await expect(requireCodexImageJson(oversized)).rejects.toThrowError('invalid-json');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('prechecks declared JSON length and cancels the unread response body', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(ACCEPTANCE_JSON_MAX_BYTES + 1),
        },
      },
    );

    await expect(requireJson(response)).rejects.toThrowError('invalid-json');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized SSE chunk and closes the chunk source without retaining raw data', async () => {
    const sentinel = 'oversized-sse-private-sentinel';
    const oversized = `data: ${JSON.stringify({ sentinel, padding: 'x'.repeat(ACCEPTANCE_SSE_MAX_BYTES) })}\n\n`;
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    let delivered = false;
    const chunks: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (delivered) return { done: true as const, value: undefined };
            delivered = true;
            return { done: false as const, value: oversized };
          },
          return: returned,
        };
      },
    };

    const error = (await parseJsonSse(chunks).catch((caught) => caught)) as Error;
    expect(error.message).toBe('invalid-sse');
    expect(error.message).not.toContain(sentinel);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it('rejects one oversized SSE frame below the total byte ceiling', async () => {
    const frame = `data: ${JSON.stringify({ padding: 'x'.repeat(ACCEPTANCE_SSE_MAX_FRAME_BYTES) })}\n\n`;

    await expect(parseJsonSse([frame])).rejects.toThrowError('invalid-sse');
  });

  it('bounds SSE frame, data-line, and parsed-event counts independently', async () => {
    const tooManyFrames = Array.from(
      { length: ACCEPTANCE_SSE_MAX_FRAMES + 1 },
      () => 'event: close\ndata: {}\n\n',
    );
    const tooManyDataLines = [
      `${Array.from(
        { length: ACCEPTANCE_SSE_MAX_DATA_LINES + 1 },
        (_value, index) =>
          `data: ${index === 0 ? '[' : ''}0${index < ACCEPTANCE_SSE_MAX_DATA_LINES ? ',' : ']'}`,
      ).join('\n')}\n\n`,
    ];
    const tooManyEvents = Array.from(
      { length: ACCEPTANCE_SSE_MAX_EVENTS + 1 },
      () => 'data: {"type":"bounded"}\n\n',
    );

    await expect(parseJsonSse(tooManyFrames)).rejects.toThrowError('invalid-sse');
    await expect(parseJsonSse(tooManyDataLines)).rejects.toThrowError('invalid-sse');
    await expect(parseJsonSse(tooManyEvents)).rejects.toThrowError('invalid-sse');
  });

  it('cancels the response reader when SSE parsing overflows', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ padding: 'x'.repeat(ACCEPTANCE_SSE_MAX_BYTES) })}\n\n`,
            ),
          );
        },
        cancel,
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

    await expect(responseEvents(response)).rejects.toThrowError('invalid-sse');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('requires an incremental outline before the completion event', () => {
    expect(validateOutlineEvents(outlineEvents)).toEqual({
      eventCount: 3,
      outlineCount: 1,
      incremental: true,
      completed: true,
    });
    expect(() => validateOutlineEvents([{ type: 'done', outlines: [{ id: 'one' }] }])).toThrowError(
      'invalid-sse',
    );
    expect(() =>
      validateOutlineEvents([
        { type: 'outline', index: 0, data: { id: 'one' } },
        { type: 'done', outlines: [{ id: 'one' }] },
      ]),
    ).toThrowError('invalid-sse');
  });

  it('requires one canonical terminal outline event last and rejects trailing or drifted events', () => {
    const terminal = outlineEvents.at(-1)!;
    expect(() =>
      validateOutlineEvents([...outlineEvents, { type: 'languageDirective', data: 'late' }]),
    ).toThrowError('invalid-sse');
    expect(() => validateOutlineEvents([...outlineEvents, terminal])).toThrowError('invalid-sse');
    expect(() =>
      validateOutlineEvents([
        outlineEvents[0],
        outlineEvents[1],
        {
          ...terminal,
          outlines: [
            {
              ...(terminal as { outlines: Array<Record<string, unknown>> }).outlines[0],
              title: 'Different terminal title',
            },
          ],
        },
      ]),
    ).toThrowError('invalid-sse');
    expect(() =>
      validateOutlineEvents([
        outlineEvents[0],
        { ...(outlineEvents[1] as Record<string, unknown>), privateField: 'plausible-drift' },
        terminal,
      ]),
    ).toThrowError('invalid-sse');
    expect(() =>
      validateOutlineEvents([{ type: 'error', error: 'safe category only' }, outlineEvents[1]]),
    ).toThrowError('invalid-sse');
  });

  it('requires tool call, matching completion, and later assistant output in that order', () => {
    expect(validateEditorEvents(editorEvents)).toEqual({
      eventCount: 7,
      toolCallCount: 1,
      toolCalled: true,
      toolCompleted: true,
      assistantContinued: true,
    });
    expect(() =>
      validateEditorEvents([editorEvents[0], editorEvents[1], editorEvents[4], editorEvents[2]]),
    ).toThrowError('invalid-sse');
    expect(() =>
      validateEditorEvents([
        {
          type: 'message_update',
          message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect.' }] },
          assistantMessageEvent: { type: 'text_delta', delta: 'I will inspect.' },
        },
        editorEvents[1],
        editorEvents[2],
        {
          type: 'turn_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect.' }] },
          toolResults: [],
        },
        { type: 'agent_end', messages: [] },
      ]),
    ).toThrowError('invalid-sse');
  });

  it('rejects unmatched or duplicate target-tool completions around an otherwise valid sequence', () => {
    const unmatchedCompletion = {
      ...(editorEvents[2] as Record<string, unknown>),
      toolCallId: 'unmatched-tool',
    };
    expect(() =>
      validateEditorEvents([editorEvents[0], unmatchedCompletion, ...editorEvents.slice(1)]),
    ).toThrowError('invalid-sse');
    expect(() =>
      validateEditorEvents([
        ...editorEvents.slice(0, 3),
        editorEvents[2],
        ...editorEvents.slice(3),
      ]),
    ).toThrowError('invalid-sse');
  });

  it('requires exactly one terminal agent_end last and rejects retry or early terminal events', () => {
    const terminal = editorEvents.at(-1)!;
    expect(() =>
      validateEditorEvents([editorEvents[0], terminal, ...editorEvents.slice(1, -1), terminal]),
    ).toThrowError('invalid-sse');
    expect(() =>
      validateEditorEvents([...editorEvents.slice(0, -1), { type: 'retry', attempt: 1 }, terminal]),
    ).toThrowError('invalid-sse');
    expect(() =>
      validateEditorEvents([
        ...editorEvents,
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
        },
      ]),
    ).toThrowError('invalid-sse');
    expect(() => validateEditorEvents([...editorEvents, terminal])).toThrowError('invalid-sse');
  });

  it('accepts only the strict public catalog and rejects added identity fields', () => {
    expect(validateCodexCatalog(catalog(true))).toMatchObject({
      modelId: 'gpt-acceptance',
      modelCount: 1,
      fastModelCount: 1,
      priorityAdvertised: true,
    });

    const leaked = catalog(true);
    Object.assign(leaked.providers['openai-codex'], {
      accountId: 'account-secret',
      email: 'secret@example.test',
    });
    expect(() => validateCodexCatalog(leaked)).toThrowError('invalid-shape');
  });

  it('validates the route-shaped GeneratedSlideContent response without returning generated text', () => {
    expect(
      validateVerificationJson({
        success: true,
        message: 'Connection successful',
        response: 'private generated response',
      }),
    ).toEqual({ generated: true });
    expect(
      validateSceneJson({
        success: true,
        content: canonicalSlideContent,
        effectiveOutline: {
          id: 'acceptance-outline',
          type: 'slide',
          title: 'Two plus two',
          description: 'Show that 2 + 2 = 4.',
          keyPoints: ['2 + 2 = 4'],
          order: 0,
        },
      }),
    ).toEqual({ json: true, simpleScene: true, sceneCount: 1 });
    expect(() => validateVerificationJson({ success: true, response: '' })).toThrowError(
      'invalid-shape',
    );
    expect(() =>
      validateVerificationJson({
        success: true,
        message: 'Connection successful',
        response: '   \n\t',
      }),
    ).toThrowError('invalid-shape');
    expect(() =>
      validateVerificationJson({
        success: true,
        message: 'Connection successful',
        response: 'OK',
        token: 'must-not-cross-route',
      }),
    ).toThrowError('invalid-shape');
    expect(() =>
      validateSceneJson({
        success: true,
        content: {
          type: 'slide',
          canvas: {
            id: 'legacy-envelope',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#000000'],
              fontColor: '#000000',
              fontName: 'Arial',
            },
            elements: [canonicalTextElement],
          },
        },
        effectiveOutline: {
          id: 'acceptance-outline',
          type: 'slide',
          title: 'Two plus two',
          description: 'Show that 2 + 2 = 4.',
          keyPoints: ['2 + 2 = 4'],
          order: 0,
        },
      }),
    ).toThrowError('invalid-shape');
    expect(() =>
      validateSceneJson({
        success: true,
        content: {
          ...canonicalSlideContent,
          background: { type: 'image', image: { src: '/background.png' } },
        },
        effectiveOutline: {
          id: 'acceptance-outline',
          type: 'slide',
          title: 'Two plus two',
          description: 'Show that 2 + 2 = 4.',
          keyPoints: ['2 + 2 = 4'],
          order: 0,
        },
      }),
    ).toThrowError('invalid-shape');
    expect(() =>
      validateSceneJson({
        success: true,
        content: {
          ...canonicalSlideContent,
          elements: [{ ...canonicalTextElement, type: 'widget' }],
        },
        effectiveOutline: {
          id: 'acceptance-outline',
          type: 'slide',
          title: 'Two plus two',
          description: 'Show that 2 + 2 = 4.',
          keyPoints: ['2 + 2 = 4'],
          order: 0,
        },
      }),
    ).toThrowError('invalid-shape');
    expect(() =>
      validateSceneJson({
        success: true,
        content: {
          ...canonicalSlideContent,
          elements: [
            {
              id: 'element-1',
              type: 'text',
              left: 0,
              top: 0,
              width: 100,
              height: 40,
              rotate: 0,
            },
          ],
        },
        effectiveOutline: {
          id: 'acceptance-outline',
          type: 'slide',
          title: 'Two plus two',
          description: 'Show that 2 + 2 = 4.',
          keyPoints: ['2 + 2 = 4'],
          order: 0,
        },
      }),
    ).toThrowError('invalid-shape');
  });

  it('accepts only the fixed Codex image capability and canonical PNG metadata', () => {
    expect(validateCodexImageCapability(catalog(false, false))).toEqual({ available: false });
    expect(validateCodexImageCapability(catalog(false, true))).toEqual({ available: true });
    expect(
      validateCodexImageJson({
        success: true,
        result: { base64: pngBase64(), width: 1536, height: 864 },
      }),
    ).toEqual({ mimeType: 'image/png', width: 1536, height: 864 });

    const leakedCapability = catalog(false, true);
    const leakedImageProvider = leakedCapability.image['codex-image'];
    expect(leakedImageProvider).toBeDefined();
    Object.assign(leakedImageProvider!, { accountId: 'private-account' });
    expect(() => validateCodexImageCapability(leakedCapability)).toThrowError('invalid-shape');
    expect(() =>
      validateCodexImageJson({
        success: true,
        result: { base64: `${pngBase64()}\n`, width: 1536, height: 864 },
      }),
    ).toThrowError('invalid-shape');
    expect(() =>
      validateCodexImageJson({
        success: true,
        result: { base64: pngBase64(), width: 1024, height: 1024 },
      }),
    ).toThrowError('invalid-shape');
    expect(() =>
      validateCodexImageJson({
        success: true,
        result: { base64: pngBase64(), width: 1536, height: 864 },
        prompt: 'must-not-cross-route',
      }),
    ).toThrowError('invalid-shape');
  });

  it('accepts a safe 1254x1254 Codex PNG and returns its actual dimensions', () => {
    expect(
      validateCodexImageJson({
        success: true,
        result: { base64: pngBase64(1254, 1254), width: 1254, height: 1254 },
      }),
    ).toEqual({ mimeType: 'image/png', width: 1254, height: 1254 });
  });

  it('rejects a Codex image when DTO dimensions do not match PNG IHDR', () => {
    expect(() =>
      validateCodexImageJson({
        success: true,
        result: { base64: pngBase64(1254, 1254), width: 1024, height: 1024 },
      }),
    ).toThrowError('invalid-shape');
  });
});

describe('black-box acceptance flow', () => {
  it('rejects a direct remote HTTP runner call before sending an access code', async () => {
    const accessCode = 'direct-runner-access-secret';
    const fetcher = vi.fn(async () => json({ success: true }));

    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://remote.example',
        expectSignedOut: false,
        editorMode: 'enabled',
        includeImage: false,
        accessCode,
      },
      { fetcher },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(reports).toEqual([{ outcome: 'FAIL', stage: 'arguments', errorCategory: 'argument' }]);
    expect(reports.map(formatSafeReport).join('\n')).not.toContain(accessCode);
  });

  it.each(['http://127.0.0.1:3000', 'https://remote.example'])(
    'keeps direct runner support for safe origin %s',
    async (baseUrl) => {
      const fetcher = connectedFetch(false, false);
      const reports = await runCodexAcceptance(
        { baseUrl, expectSignedOut: false, editorMode: 'disabled', includeImage: false },
        { fetcher },
      );

      expect(fetcher).toHaveBeenCalled();
      expect(acceptanceExitCode(reports)).toBe(0);
    },
  );

  it('rejects remote HTTP at the low-level fetch boundary before invoking the fetcher', async () => {
    const fetcher = vi.fn(async () => json({ success: true }));

    await expect(
      safeFetch(fetcher, 'http://remote.example/api/access-code/verify', {}, 1_000),
    ).rejects.toThrowError('argument');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies a local image API connection failure as a network source', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('private-local-network-detail');
    });

    const caught = await safeFetch(
      fetcher,
      'http://localhost:3000/api/generate/image',
      { method: 'POST' },
      1_000,
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      category: 'network',
      failureSource: 'network',
    });
    expect(String(caught)).not.toContain('private-local-network-detail');
  });

  it('classifies the local image API deadline as a timeout source', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const rejectForAbort = () => reject(signal.reason);
          if (signal.aborted) rejectForAbort();
          else signal.addEventListener('abort', rejectForAbort, { once: true });
        }),
    );

    const caught = await safeFetch(
      fetcher,
      'http://localhost:3000/api/generate/image',
      { method: 'POST' },
      5,
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      category: 'network',
      failureSource: 'timeout',
    });
  });

  it('requires Fast when advertised, uses priority on the same model, and accepts editor ordering', async () => {
    const fetcher = connectedFetch(true);
    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'enabled',
        includeImage: false,
      },
      { fetcher },
    );

    expect(reports.map(({ outcome, stage }) => ({ outcome, stage }))).toEqual([
      { outcome: 'PASS', stage: 'access-session' },
      { outcome: 'PASS', stage: 'auth' },
      { outcome: 'PASS', stage: 'catalog' },
      { outcome: 'PASS', stage: 'verify-normal' },
      { outcome: 'PASS', stage: 'fast' },
      { outcome: 'PASS', stage: 'outline-stream' },
      { outcome: 'PASS', stage: 'scene-json' },
      { outcome: 'PASS', stage: 'editor-tools' },
    ]);
    expect(acceptanceExitCode(reports)).toBe(0);

    const calls = fetcher.mock.calls;
    const verifyCalls = calls.filter(
      ([input]) => new URL(String(input)).pathname === '/api/verify-model',
    );
    const streamCall = calls.find(
      ([input]) => new URL(String(input)).pathname === '/api/generate/scene-outlines-stream',
    );
    expect(verifyCalls).toHaveLength(2);
    expect(JSON.parse(String(verifyCalls[0]?.[1]?.body))).toEqual({
      model: 'openai-codex:gpt-acceptance',
    });
    expect(JSON.parse(String(verifyCalls[1]?.[1]?.body))).toEqual({
      model: 'openai-codex:gpt-acceptance',
      serviceTier: 'priority',
    });
    expect(new Headers(streamCall?.[1]?.headers).get('x-model')).toBe(
      'openai-codex:gpt-acceptance',
    );
    expect(new Headers(streamCall?.[1]?.headers).get('x-service-tier')).toBeNull();
    expect(JSON.parse(String(streamCall?.[1]?.body))).not.toHaveProperty('serviceTier');
    for (const [input, init] of calls.filter(([input]) => {
      const path = new URL(String(input)).pathname;
      return [
        '/api/verify-model',
        '/api/generate/scene-outlines-stream',
        '/api/generate/scene-content',
        '/api/agent/edit',
      ].includes(path);
    })) {
      const requestHeaders = new Headers(init?.headers);
      expect(requestHeaders.get('x-openmaic-expected-provider'), String(input)).toBe(
        'openai-codex',
      );
      expect(requestHeaders.get('x-openmaic-expected-model'), String(input)).toBe('gpt-acceptance');
    }
  });

  it('emits an explicit non-failing Fast SKIP and omits priority when unadvertised', async () => {
    const fetcher = connectedFetch(false, false);
    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: false,
      },
      { fetcher },
    );

    expect(reports.find((report) => report.stage === 'fast')).toEqual({
      outcome: 'SKIP',
      stage: 'fast',
      modelId: 'gpt-acceptance',
      priorityAdvertised: false,
    });
    expect(reports.find((report) => report.stage === 'editor-tools')).toMatchObject({
      outcome: 'SKIP',
      stage: 'editor-tools',
      editorEnabled: false,
      httpStatus: 404,
    });
    expect(acceptanceExitCode(reports)).toBe(0);
    const streamCall = fetcher.mock.calls.find(
      ([input]) => new URL(String(input)).pathname === '/api/generate/scene-outlines-stream',
    );
    expect(new Headers(streamCall?.[1]?.headers).get('x-service-tier')).toBeNull();
    expect(JSON.parse(String(streamCall?.[1]?.body))).not.toHaveProperty('serviceTier');
  });

  it('never calls image generation without the explicit opt-in flag even when advertised', async () => {
    const fetcher = connectedFetch(false, false, () =>
      json({
        success: true,
        result: { base64: pngBase64(), width: 1536, height: 864 },
      }),
    );
    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: false,
      },
      { fetcher },
    );

    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/api/generate/image',
      ),
    ).toHaveLength(0);
    expect(reports.some((report) => report.stage === 'image-generation')).toBe(false);
  });

  it('reports an explicit image SKIP without generation when capability is absent', async () => {
    const fetcher = connectedFetch(false, false);
    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: true,
      },
      { fetcher },
    );

    expect(reports.find((report) => report.stage === 'image-generation')).toEqual({
      outcome: 'SKIP',
      stage: 'image-generation',
      modelId: 'gpt-image-2',
      errorCategory: 'unavailable',
    });
    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/api/generate/image',
      ),
    ).toHaveLength(0);
  });

  it('makes exactly one fixed 16:9 image request and reports actual PNG metadata only', async () => {
    const fetcher = connectedFetch(false, false, () =>
      json({
        success: true,
        result: { base64: pngBase64(1254, 1254), width: 1254, height: 1254 },
      }),
    );
    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: true,
      },
      { fetcher },
    );

    const imageCalls = fetcher.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === '/api/generate/image',
    );
    expect(imageCalls).toHaveLength(1);
    const [, init] = imageCalls[0]!;
    expect(new Headers(init?.headers).get('x-image-provider')).toBe('codex-image');
    expect(new Headers(init?.headers).get('x-image-model')).toBe('gpt-image-2');
    expect(JSON.parse(String(init?.body))).toMatchObject({ aspectRatio: '16:9' });
    expect(JSON.parse(String(init?.body)).prompt).toEqual(expect.any(String));
    expect(reports.find((report) => report.stage === 'image-generation')).toEqual({
      outcome: 'PASS',
      stage: 'image-generation',
      modelId: 'gpt-image-2',
      httpStatus: 200,
      mimeType: 'image/png',
      width: 1254,
      height: 1254,
    });
    const output = reports.map(formatSafeReport).join('\n');
    expect(output).toContain(
      'PASS stage=image-generation model=gpt-image-2 http=200 mime=image/png width=1254 height=1254',
    );
    expect(output).not.toContain(pngBase64(1254, 1254));
  });

  it('keeps image acceptance independent when the text catalog is unavailable', async () => {
    const fallback = connectedFetch(false, false, () =>
      json({
        success: true,
        result: { base64: pngBase64(), width: 1536, height: 864 },
      }),
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/api/server-providers') {
        return json({
          success: true,
          providers: {},
          image: { 'codex-image': { models: ['gpt-image-2'] } },
        });
      }
      return fallback(input, init);
    });

    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: true,
      },
      { fetcher },
    );

    expect(reports.find((report) => report.stage === 'catalog')).toMatchObject({
      outcome: 'FAIL',
      errorCategory: 'invalid-shape',
    });
    expect(reports.find((report) => report.stage === 'image-generation')).toMatchObject({
      outcome: 'PASS',
      modelId: 'gpt-image-2',
      mimeType: 'image/png',
      width: 1536,
      height: 864,
    });
    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/api/generate/image',
      ),
    ).toHaveLength(1);
  });

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'unavailable'],
    [429, 'rate-limited'],
    [502, 'upstream'],
  ] as const)(
    'fails one advertised image request safely for HTTP %i',
    async (status, errorCategory) => {
      const privateBody = 'private-image-upstream-body';
      const fetcher = connectedFetch(false, false, () =>
        json({ success: false, error: privateBody, base64: 'private-image-base64' }, status),
      );
      const reports = await runCodexAcceptance(
        {
          baseUrl: 'http://localhost:3000',
          expectSignedOut: false,
          editorMode: 'disabled',
          includeImage: true,
        },
        { fetcher },
      );

      expect(
        fetcher.mock.calls.filter(
          ([input]) => new URL(String(input)).pathname === '/api/generate/image',
        ),
      ).toHaveLength(1);
      expect(reports.find((report) => report.stage === 'image-generation')).toMatchObject({
        outcome: 'FAIL',
        stage: 'image-generation',
        modelId: 'gpt-image-2',
        httpStatus: status,
        errorCategory,
      });
      expect(reports.map(formatSafeReport).join('\n')).not.toMatch(
        /private-image-upstream-body|private-image-base64/,
      );
    },
  );

  it('reports safe image API and upstream HTTP diagnostics without reading the body', async () => {
    const privateBody = 'private-image-upstream-body';
    const fetcher = connectedFetch(false, false, () =>
      json({ success: false, error: privateBody }, 502, {
        'x-openmaic-codex-image-error-source': 'upstream-http',
        'x-openmaic-codex-image-upstream-status': '503',
      }),
    );
    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: true,
      },
      { fetcher },
    );

    const report = reports.find((candidate) => candidate.stage === 'image-generation');
    expect(report).toMatchObject({
      outcome: 'FAIL',
      httpStatus: 502,
      failureSource: 'upstream-http',
      upstreamStatus: 503,
      errorCategory: 'upstream',
    });
    expect(formatSafeReport(report!)).toBe(
      'FAIL stage=image-generation model=gpt-image-2 http=502 source=upstream-http upstream=503 error=upstream',
    );
    expect(formatSafeReport(report!)).not.toContain(privateBody);
  });

  it.each([
    ['network', 'network'],
    ['invalid-response', 'invalid-response'],
    ['timeout', 'timeout'],
  ] as const)('prints a safe %s image failure source', async (source, expected) => {
    const fetcher = connectedFetch(false, false, () =>
      json({ success: false, error: 'private failure body' }, source === 'timeout' ? 504 : 502, {
        'x-openmaic-codex-image-error-source': source,
      }),
    );
    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: true,
      },
      { fetcher },
    );

    const output = formatSafeReport(
      reports.find((candidate) => candidate.stage === 'image-generation')!,
    );
    expect(output).toContain(`source=${expected}`);
    expect(output).not.toContain('private failure body');
  });

  it.each([
    [
      'network',
      () => {
        throw new Error('private-image-network-detail');
      },
      'network',
    ],
    ['invalid JSON', () => new Response('{private-image-invalid-json'), 'invalid-json'],
    [
      'invalid PNG',
      () =>
        json({
          success: true,
          result: { base64: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', width: 1536, height: 864 },
        }),
      'invalid-shape',
    ],
  ] as const)(
    'fails one advertised image request safely for %s',
    async (_label, imageResponse, errorCategory) => {
      const fetcher = connectedFetch(false, false, imageResponse);
      const reports = await runCodexAcceptance(
        {
          baseUrl: 'http://localhost:3000',
          expectSignedOut: false,
          editorMode: 'disabled',
          includeImage: true,
        },
        { fetcher },
      );

      expect(
        fetcher.mock.calls.filter(
          ([input]) => new URL(String(input)).pathname === '/api/generate/image',
        ),
      ).toHaveLength(1);
      expect(reports.find((report) => report.stage === 'image-generation')).toMatchObject({
        outcome: 'FAIL',
        modelId: 'gpt-image-2',
        errorCategory,
      });
      expect(reports.map(formatSafeReport).join('\n')).not.toMatch(
        /private-image-network-detail|private-image-invalid-json/,
      );
    },
  );

  it('fails a missing editor route by default and skips it only when disabled is explicit', async () => {
    const defaultReports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'enabled',
        includeImage: false,
      },
      { fetcher: connectedFetch(false, false) },
    );
    expect(defaultReports.find((report) => report.stage === 'editor-tools')).toMatchObject({
      outcome: 'FAIL',
      stage: 'editor-tools',
      httpStatus: 404,
      errorCategory: 'unavailable',
    });

    const unexpectedEnabledReports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'disabled',
        includeImage: false,
      },
      { fetcher: connectedFetch(false, true) },
    );
    expect(
      unexpectedEnabledReports.find((report) => report.stage === 'editor-tools'),
    ).toMatchObject({
      outcome: 'FAIL',
      stage: 'editor-tools',
      errorCategory: 'invalid-shape',
    });
  });

  it('signed-out mode verifies disconnected auth and provider absence without generation calls', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/access-code/status') {
        return json({ success: true, enabled: false, authenticated: false });
      }
      if (path === '/api/codex/auth') {
        return json({
          available: true,
          reason: 'AVAILABLE',
          methods: ['browser', 'device'],
          connected: false,
        });
      }
      if (path === '/api/server-providers') {
        return json({ success: true, providers: { openai: { models: ['gpt-other'] } } });
      }
      throw new Error('generation must not run in signed-out mode');
    });

    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: true,
        editorMode: 'enabled',
        includeImage: false,
      },
      { fetcher },
    );

    expect(reports).toEqual([
      {
        outcome: 'PASS',
        stage: 'access-session',
        httpStatus: 200,
        authenticated: true,
      },
      {
        outcome: 'PASS',
        stage: 'auth',
        httpStatus: 200,
        available: true,
        connected: false,
      },
      {
        outcome: 'PASS',
        stage: 'signed-out-provider',
        httpStatus: 200,
        providerPresent: false,
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects a signed-out auth shape that still exposes account identity', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/access-code/status') {
        return json({ success: true, enabled: false, authenticated: false });
      }
      if (path === '/api/codex/auth') {
        return json({
          available: true,
          reason: 'AVAILABLE',
          methods: ['device'],
          connected: false,
          email: 'stale-identity@example.test',
        });
      }
      throw new Error('provider lookup must not run after an invalid auth shape');
    });

    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: true,
        editorMode: 'enabled',
        includeImage: false,
      },
      { fetcher },
    );

    expect(reports.at(-1)).toEqual({
      outcome: 'FAIL',
      stage: 'auth',
      errorCategory: 'invalid-shape',
    });
  });

  it('blocks redirects while obtaining an access cookie and redacts every secret', async () => {
    const accessCode = 'access-code-secret';
    const cookie = 'openmaic_access=cookie-secret';
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      const path = new URL(String(input)).pathname;
      if (path === '/api/access-code/status' && !new Headers(init?.headers).has('cookie')) {
        return json({ success: true, enabled: true, authenticated: false });
      }
      if (path === '/api/access-code/verify') {
        expect(String(init?.body)).toContain(accessCode);
        return json({ success: true, valid: true }, 200, {
          'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }
      if (path === '/api/access-code/status') {
        expect(new Headers(init?.headers).get('cookie')).toBe(cookie);
        return json({ success: true, enabled: true, authenticated: true });
      }
      if (path === '/api/codex/auth') {
        return json(
          {
            success: false,
            error: `provider body ${accessCode} ${cookie}`,
            token: 'provider-token-secret',
          },
          502,
        );
      }
      throw new Error(`unexpected ${path} ${accessCode} ${cookie}`);
    });

    const reports = await runCodexAcceptance(
      {
        baseUrl: 'http://localhost:3000',
        expectSignedOut: false,
        editorMode: 'enabled',
        includeImage: false,
        accessCode,
      },
      { fetcher },
    );
    const output = reports.map(formatSafeReport).join('\n');

    expect(reports.at(-1)).toMatchObject({
      outcome: 'FAIL',
      stage: 'auth',
      httpStatus: 502,
      errorCategory: 'upstream',
    });
    expect(output).not.toMatch(
      /access-code-secret|cookie-secret|provider-token-secret|provider body|set-cookie/i,
    );
  });
});
