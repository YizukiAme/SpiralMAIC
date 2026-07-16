import { describe, expect, it, vi } from 'vitest';

import {
  acceptanceExitCode,
  formatSafeReport,
  parseAcceptanceArgs,
  parseJsonSse,
  runCodexAcceptance,
  validateCodexCatalog,
  validateEditorEvents,
  validateOutlineEvents,
  validateSceneJson,
  validateVerificationJson,
  type SafeReport,
} from '@/scripts/codex-acceptance-lib';

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function sse(events: unknown[], status = 200): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function catalog(priority: boolean) {
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
  };
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
  { type: 'turn_start' },
  {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'private answer' }] },
    assistantMessageEvent: { type: 'text_delta', delta: 'private answer' },
  },
  { type: 'agent_end', messages: [] },
];

function connectedFetch(priority: boolean, editorEnabled = true) {
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
    if (url.pathname === '/api/server-providers') return json(catalog(priority));
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
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: [{ id: 'element-1', type: 'text' }],
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
    ).toEqual({ baseUrl: 'https://example.test:3443', expectSignedOut: true });
    expect(parseAcceptanceArgs(['--', '--base-url', 'http://localhost:3000'])).toEqual({
      baseUrl: 'http://localhost:3000',
      expectSignedOut: false,
    });
  });

  it.each([
    [[]],
    [['--base-url']],
    [['--base-url', 'file:///tmp/openmaic']],
    [['--base-url', 'https://user:password@example.test']],
    [['--base-url', 'https://example.test/path']],
    [['--base-url', 'https://example.test?secret=x']],
    [['--base-url', 'https://example.test', '--unknown']],
    [['--base-url', 'https://one.test', '--base-url', 'https://two.test']],
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

  it('requires tool call, matching completion, and later assistant output in that order', () => {
    expect(validateEditorEvents(editorEvents)).toEqual({
      eventCount: 6,
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

  it('validates verification and simple slide JSON without returning generated text', () => {
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
        content: {
          type: 'slide',
          canvas: { elements: [{ id: 'element-1', type: 'text' }] },
        },
        effectiveOutline: { id: 'acceptance-outline', type: 'slide' },
      }),
    ).toEqual({ json: true, simpleScene: true, sceneCount: 1 });
    expect(() => validateVerificationJson({ success: true, response: '' })).toThrowError(
      'invalid-shape',
    );
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
        content: { type: 'slide', canvas: { elements: [] } },
        effectiveOutline: { id: 'acceptance-outline', type: 'slide' },
      }),
    ).toThrowError('invalid-shape');
  });
});

describe('black-box acceptance flow', () => {
  it('requires Fast when advertised, uses priority on the same model, and accepts editor ordering', async () => {
    const fetcher = connectedFetch(true);
    const reports = await runCodexAcceptance(
      { baseUrl: 'http://localhost:3000', expectSignedOut: false },
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
  });

  it('emits an explicit non-failing Fast SKIP and omits priority when unadvertised', async () => {
    const fetcher = connectedFetch(false, false);
    const reports = await runCodexAcceptance(
      { baseUrl: 'http://localhost:3000', expectSignedOut: false },
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
      { baseUrl: 'http://localhost:3000', expectSignedOut: true },
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
      { baseUrl: 'http://localhost:3000', expectSignedOut: true },
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
