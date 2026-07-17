# Codex Stream and OAuth Resource Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop stale Codex text streams after credential lifecycle changes and add bounded text-stream and OAuth JSON resource consumption.

**Architecture:** Add a generation-scoped lifecycle signal to internal credential leases, then combine it with caller cancellation and transport deadlines in a guarded upstream `Response`. Apply a second decoded-part budget around the AI SDK V3 stream, and replace every OAuth `response.json()` with a shared bounded reader.

**Tech Stack:** TypeScript, Node.js Web Streams and AbortController, Vercel AI SDK v6 / LanguageModelV3 middleware, Vitest.

## Global Constraints

- Keep the public `/api/codex/auth`, `/api/codex/auth/login`, `/api/server-providers`, and `CodexTokenProvider` contracts unchanged.
- Keep the supported deployment to one local/self-hosted user, one Node process, one replica, and persistent storage.
- Logout, interactive login replacement, and permanent refresh invalidation abort the old lifecycle; ordinary same-account refresh rotation does not.
- Chunks delivered before lifecycle invalidation are not retracted, but no later chunk may be delivered.
- Logout publishes cancellation synchronously and does not wait for stream backpressure or stream cleanup.
- Preserve the existing one-time conditional 401 refresh/replay with an identical normalized body and session identity.
- Text limits are: 15-minute total lifetime, 3-minute body idle time, 32 MiB raw bytes, 250,000 decoded parts, 4,096 content items, and 4 MiB for one accumulated tool input.
- OAuth JSON has a 1 MiB byte limit inside the existing 10-second request deadline.
- Errors and logs must not contain prompts, generated text, tool input, response bodies, tokens, account IDs, device IDs, cookies, or abort reasons.
- Do not change Fast, model discovery, image generation, settings UI, provider DTOs, or deployment availability behavior.
- Do not add dependencies, contact a real account, push the branch, or create a pull request.

---

### Task 1: Credential Lifecycle Signals

**Files:**
- Modify: `lib/server/codex/token-provider.ts`
- Modify: `lib/server/codex/runtime.ts`
- Test: `tests/server/codex/token-provider.test.ts`
- Test: `tests/server/codex/runtime.test.ts`

**Interfaces:**
- Produces:

```ts
export interface InternalCodexCredentialLease {
  readonly tokenProvider: CodexTokenProvider;
  readonly credentials: { accessToken: string; accountId: string };
  readonly lifecycleGeneration: number | null;
  readonly lifecycleSignal: AbortSignal | null;
}
```

- `refreshCodexCredentialLease()` preserves the captured signal for a permitted same-lifecycle refresh.
- `invalidateCodexCredentialLeases()` synchronously aborts old leases and creates a fresh lifecycle.
- Later tasks consume `lease.lifecycleSignal` but do not mutate it.

- [ ] **Step 1: Add failing lifecycle tests**

Add focused tests using the existing `MemoryVault`, deferred operations, and
managed provider fixtures:

```ts
it('aborts the old lease synchronously when logout starts', async () => {
  const provider = new ManagedCodexTokenProvider({ vault, tokenExchangeFetch });
  const lease = await acquireCodexCredentialLease(provider);
  const logout = provider.logout();

  expect(lease.lifecycleSignal?.aborted).toBe(true);
  await logout;
});

it('aborts old leases on interactive replacement but not normal refresh rotation', async () => {
  const provider = new ManagedCodexTokenProvider({ vault, tokenExchangeFetch });
  const stale = await acquireCodexCredentialLease(provider);

  invalidateCodexCredentialLeases(provider);
  expect(stale.lifecycleSignal?.aborted).toBe(true);

  const current = await acquireCodexCredentialLease(provider);
  await refreshCodexCredentialLease(current);
  expect(current.lifecycleSignal?.aborted).toBe(false);
});
```

Extend the existing permanent-refresh-failure test to retain a lease before the
refresh and assert that `invalid_grant` aborts it. Add a runtime test proving
that the login-manager replacement barrier aborts before the new vault save
becomes observable.

- [ ] **Step 2: Run the lifecycle tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/server/codex/token-provider.test.ts tests/server/codex/runtime.test.ts
```

Expected: FAIL because `lifecycleSignal` is absent and lifecycle advancement
only increments `catalogGeneration`.

- [ ] **Step 3: Implement one controller per shared lifecycle**

Extend shared state and initialize it:

```ts
interface SharedCredentialState {
  generation: number;
  catalogGeneration: number;
  lifecycleController: AbortController;
  operationInFlight: ActiveCredentialOperation | null;
  logoutInFlight: Promise<void> | null;
}

function createSharedCredentialState(): SharedCredentialState {
  return {
    generation: 0,
    catalogGeneration: 0,
    lifecycleController: new AbortController(),
    operationInFlight: null,
    logoutInFlight: null,
  };
}

function advanceCodexCredentialLifecycle(state: SharedCredentialState): void {
  const staleController = state.lifecycleController;
  state.catalogGeneration += 1;
  state.lifecycleController = new AbortController();
  staleController.abort();
}
```

Normalize a retained state whose controller is missing or invalid. Bump the
shared-state registry symbol from `v3` to `v4` and the runtime symbol from `v5`
to `v6`, with comments explaining the lifecycle-signal boundary.

Capture generation and signal atomically in `acquireCodexCredentialLease()`:

```ts
const lifecycleGeneration = authority.sharedState.catalogGeneration;
const lifecycleSignal = authority.sharedState.lifecycleController.signal;
const credentials = await tokenProvider.getValidCredentials();
if (
  !lifecycleSignal.aborted &&
  lifecycleGeneration === authority.sharedState.catalogGeneration &&
  lifecycleSignal === authority.sharedState.lifecycleController.signal &&
  (await managedLeaseCredentialsMatch(authority, credentials))
) {
  return Object.freeze({
    tokenProvider,
    credentials: { ...credentials },
    lifecycleGeneration,
    lifecycleSignal,
  });
}
```

Unmanaged providers receive `lifecycleSignal: null`. Currentness requires a
managed lease's signal to remain un-aborted and identical to the controller for
its generation. Refresh preserves `lease.lifecycleSignal`.

Replace all direct `catalogGeneration += 1` lifecycle barriers with
`advanceCodexCredentialLifecycle()`:

- `invalidateCodexCredentialLeases()`;
- synchronous logout start; and
- successful permanent refresh clear.

Do not call it for ordinary token rotation.

- [ ] **Step 4: Run the lifecycle tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/server/codex/token-provider.test.ts tests/server/codex/runtime.test.ts
```

Expected: PASS with no unhandled abort or rejection warnings.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/server/codex/token-provider.ts lib/server/codex/runtime.ts \
  tests/server/codex/token-provider.test.ts tests/server/codex/runtime.test.ts
git commit -m "fix(codex): abort stale credential lifecycles"
```

---

### Task 2: Guard the Upstream Responses Body

**Files:**
- Create: `lib/server/codex/response-guard.ts`
- Modify: `lib/server/codex/transport.ts`
- Test: `tests/server/codex/response-guard.test.ts`
- Test: `tests/server/codex/transport.test.ts`

**Interfaces:**
- Consumes `InternalCodexCredentialLease.lifecycleSignal` from Task 1.
- Produces:

```ts
export const CODEX_RESPONSE_LIMITS = {
  totalTimeoutMs: 15 * 60_000,
  idleTimeoutMs: 3 * 60_000,
  maxBytes: 32 * 1024 * 1024,
} as const;

export type CodexResponseGuardFailure =
  | 'caller-abort'
  | 'lifecycle-abort'
  | 'timeout'
  | 'idle-timeout'
  | 'body-too-large'
  | 'body-read-failed'
  | 'stale-at-eof';

export interface CodexResponseRequestGuard {
  readonly signal: AbortSignal;
  race<T>(operation: Promise<T>): Promise<T>;
  bind(
    response: Response,
    assertCurrent: () => Promise<boolean>,
  ): Response;
  dispose(): void;
}

export function createCodexResponseRequestGuard(options: {
  callerSignal?: AbortSignal;
  lifecycleSignal?: AbortSignal | null;
  limits?: Partial<typeof CODEX_RESPONSE_LIMITS>;
}): CodexResponseRequestGuard;
```

- `createCodexResponseRequestGuard()` accepts caller and lifecycle signals,
  optional test-only limit/scheduler overrides, and maps no secret input into
  failures.

- [ ] **Step 1: Add failing guard tests**

Create tests with small injected limits instead of waiting for production
timeouts:

```ts
it('stops before the next chunk after lifecycle invalidation', async () => {
  const lifecycle = new AbortController();
  const source = controllableByteStream();
  const guard = createCodexResponseRequestGuard({
    lifecycleSignal: lifecycle.signal,
    limits: { totalTimeoutMs: 1_000, idleTimeoutMs: 500, maxBytes: 32 },
  });
  const guarded = guard.bind(new Response(source.stream), async () => true);
  const reader = guarded.body!.getReader();

  source.enqueue(Uint8Array.of(1));
  await expect(reader.read()).resolves.toMatchObject({ done: false });
  lifecycle.abort();
  source.enqueue(Uint8Array.of(2));

  await expect(reader.read()).rejects.toMatchObject({
    failure: 'lifecycle-abort',
  });
  expect(source.cancel).toHaveBeenCalledTimes(1);
});
```

Cover:

- lifecycle abort before headers while `race()` wraps an operation that ignores
  the signal;
- lifecycle abort before the first chunk and after one chunk;
- caller abort classification;
- total timeout and idle timeout with fake timers;
- exact `maxBytes` succeeds and one extra byte fails;
- EOF invokes `assertCurrent()` and refuses stale completion;
- consumer cancel reaches the source exactly once; and
- normal EOF, source error, and abort dispose listeners and timers.

- [ ] **Step 2: Run guard tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/server/codex/response-guard.test.ts
```

Expected: FAIL because the module and guard do not exist.

- [ ] **Step 3: Implement the request/body guard**

Implement a private safe error carrying only `failure`:

```ts
export class CodexResponseGuardError extends Error {
  constructor(public readonly failure: CodexResponseGuardFailure) {
    super('Codex response transport failed');
    this.name = 'CodexResponseGuardError';
  }
}
```

`createCodexResponseRequestGuard()` must:

1. create one internal `AbortController`;
2. synchronously classify already-aborted caller/lifecycle signals;
3. subscribe once to each parent signal;
4. start the absolute timeout when the guard is created;
5. expose `race()` so an injected fetch that ignores abort still settles;
6. wrap `response.body.getReader()` in a new `ReadableStream<Uint8Array>`;
7. reset the idle timer only after an actual non-empty upstream byte chunk;
8. increment actual chunk bytes and reject before enqueueing beyond 32 MiB;
9. check lifecycle cancellation immediately before every enqueue;
10. perform `assertCurrent()` at EOF before `close()`; and
11. make cancel/dispose idempotent and clear every timer/listener.

Preserve response status, status text, and headers:

```ts
return new Response(guardedBody, {
  status: response.status,
  statusText: response.statusText,
  headers: response.headers,
});
```

- [ ] **Step 4: Integrate the guard into transport with failing race tests**

Add transport tests for:

```ts
it('cancels a successful response when logout happens after headers', async () => {
  const lease = await acquireCodexCredentialLease(provider);
  const source = controllableByteStream();
  const transport = createCodexResponsesTransport({
    tokenProvider: provider,
    upstreamFetch: vi.fn(async () => new Response(source.stream)),
  });

  const response = await transport(CODEX_RESPONSES_ENDPOINT, {
    method: 'POST',
    body: '{}',
  });
  const reader = response.body!.getReader();
  const logout = provider.logout();

  await expect(reader.read()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  await logout;
});
```

Also prove:

- a fetch that ignores abort and returns late cannot publish its response;
- the first 401 guard is disposed before conditional refresh;
- replay uses the same `body` and `session-id`;
- replay remains cancelable by later logout; and
- a body-limit error contains no upstream bytes, account, or token.

Run:

```bash
pnpm exec vitest run tests/server/codex/transport.test.ts
```

Expected: FAIL because transport still returns the original response.

- [ ] **Step 5: Integrate credential leases and guarded responses**

For calls without a capability lease, acquire an internal credential lease
instead of calling `getValidCredentials()` directly. For calls with a
capability lease, retain its credential lease. Each attempt:

```ts
const guard = createCodexResponseRequestGuard({
  callerSignal: init?.signal ?? undefined,
  lifecycleSignal: credentialLease.lifecycleSignal,
});

const response = await guard.race(
  upstreamFetch(CODEX_RESPONSES_ENDPOINT, {
    ...init,
    signal: guard.signal,
    body,
    headers: createHeaders(init?.headers, credentials, sessionId),
    redirect: 'manual',
  }),
);
```

After headers, revalidate the credential/capability lease. If stale, cancel the
response, dispose the guard, and throw the existing safe 401 error. On 401 and
other non-success statuses, cancel and dispose before refresh/classification.
On success, return `guard.bind(response, assertCurrent)`.

Map `lifecycle-abort` and `stale-at-eof` to `AUTH_REQUIRED`; map caller abort to
the existing safe network cancellation path; map time, idle, size, and read
failures to `UPSTREAM_ERROR`. Never attach the guard error as a public `cause`.

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/server/codex/response-guard.test.ts \
  tests/server/codex/transport.test.ts tests/server/codex/token-provider.test.ts
```

Expected: PASS with every source cancellation asserted exactly once.

- [ ] **Step 7: Commit Task 2**

```bash
git add lib/server/codex/response-guard.ts lib/server/codex/transport.ts \
  tests/server/codex/response-guard.test.ts tests/server/codex/transport.test.ts
git commit -m "fix(codex): guard response stream lifecycles"
```

---

### Task 3: Bound Decoded AI SDK Stream Parts

**Files:**
- Modify: `lib/ai/codex-model.ts`
- Test: `tests/ai/codex-model.test.ts`

**Interfaces:**
- Produces internal testable limits:

```ts
export const CODEX_DECODED_STREAM_LIMITS = {
  maxParts: 250_000,
  maxContentItems: 4_096,
  maxToolInputBytes: 4 * 1024 * 1024,
} as const;
```

- `guardCodexStream(result, overrides?)` is used by both `wrapStream` and
  `wrapGenerate`.

- [ ] **Step 1: Add failing decoded-budget tests**

Use small overrides so boundaries are readable:

```ts
it('applies the same part budget to stream and generate paths', async () => {
  const result = streamResult([
    { type: 'stream-start', warnings: [] },
    { type: 'raw', rawValue: {} },
    { type: 'raw', rawValue: {} },
  ]);

  const guarded = guardCodexStream(result, {
    maxParts: 2,
    maxContentItems: 8,
    maxToolInputBytes: 64,
  });

  await expect(readAll(guarded.stream)).rejects.toThrow(CODEX_STREAM_ERROR_MESSAGE);
});
```

Cover:

- exactly `maxParts` succeeds and one more fails;
- exactly `maxContentItems` succeeds and one more fails;
- streamed tool-input deltas are counted as UTF-8 bytes;
- ASCII, CJK, and emoji byte counting;
- exactly 4 MiB succeeds and one byte more fails using small overrides;
- final `tool-call.input` does not double-count already streamed deltas;
- a direct final tool call without deltas is counted;
- source cancellation occurs on every limit failure; and
- errors contain no generated delta or tool input.

- [ ] **Step 2: Run decoded-budget tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/ai/codex-model.test.ts
```

Expected: FAIL because `guardCodexStream` and the decoded limits do not exist.

- [ ] **Step 3: Implement one shared decoded guard**

Extend the current safe stream wrapper rather than adding a second independent
reader. Track:

```ts
let partCount = 0;
let contentItemCount = 0;
const toolInputs = new Map<string, { bytes: number; streamed: boolean }>();
const encoder = new TextEncoder();
```

Increment content items for text/reasoning starts, tool-input starts, direct
tool calls without a prior start, tool approvals/results, files, and sources.
For each `tool-input-delta`, add `encoder.encode(part.delta).byteLength`. For a
final tool call:

- if the ID has streamed deltas, do not add the final full input again;
- otherwise count the final input once; and
- reject before forwarding a part that exceeds any limit.

Limit failures cancel the source and throw `createCodexStreamError()` without a
public cause.

Use the same guarded stream for both middleware paths:

```ts
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
```

- [ ] **Step 4: Run Task 3 tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/ai/codex-model.test.ts tests/ai/codex-provider.test.ts
```

Expected: PASS, including existing encrypted-reasoning and tool-call replay
tests.

- [ ] **Step 5: Commit Task 3**

```bash
git add lib/ai/codex-model.ts tests/ai/codex-model.test.ts
git commit -m "fix(codex): bound decoded response streams"
```

---

### Task 4: Bound OAuth JSON Responses

**Files:**
- Create: `lib/server/codex/bounded-json.ts`
- Modify: `lib/server/codex/oauth.ts`
- Modify: `lib/server/codex/login-manager.ts`
- Modify: `lib/server/codex/token-provider.ts`
- Test: `tests/server/codex/bounded-json.test.ts`
- Test: `tests/server/codex/oauth.test.ts`
- Test: `tests/server/codex/login-manager.test.ts`
- Test: `tests/server/codex/token-provider.test.ts`

**Interfaces:**
- Produces:

```ts
export const CODEX_OAUTH_JSON_MAX_BYTES = 1024 * 1024;

export type BoundedJsonResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'empty' | 'too-large' | 'invalid-json' };

export class BoundedJsonReadError extends Error {}

export function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maxBytes?: number,
): Promise<BoundedJsonResult>;
```

- Callers retain responsibility for status and object-shape classification.

- [ ] **Step 1: Add failing bounded-reader tests**

Create:

```ts
it('rejects a chunked body as soon as it exceeds the byte budget', async () => {
  const cancelled = vi.fn();
  const response = responseFromChunks(
    [Uint8Array.of(123, 34, 97, 34), Uint8Array.of(58, 49, 125)],
    cancelled,
  );

  await expect(readBoundedJson(response, new AbortController().signal, 6)).resolves.toEqual({
    ok: false,
    reason: 'too-large',
  });
  expect(cancelled).toHaveBeenCalledTimes(1);
});
```

Cover:

- normal JSON;
- valid `Content-Length` over the limit without reading;
- chunked actual bytes over the limit;
- empty body;
- malformed JSON and invalid UTF-8;
- body stream failure throws only `BoundedJsonReadError`;
- parent abort cancels the reader; and
- no result/error contains response content.

- [ ] **Step 2: Run bounded-reader tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/server/codex/bounded-json.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the bounded reader**

Implementation requirements:

```ts
const declaredLength = Number(response.headers.get('content-length'));
if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
  await response.body?.cancel().catch(() => undefined);
  return { ok: false, reason: 'too-large' };
}
```

Read with `response.body.getReader()`, append only while the cumulative actual
byte count is at most the limit, and cancel immediately on overflow or parent
abort. Decode with:

```ts
new TextDecoder('utf-8', { fatal: true }).decode(bytes);
```

Return safe invalid results for empty, invalid UTF-8, and invalid JSON. Throw a
body-content-free `BoundedJsonReadError` only for stream transport failures.
Always release the reader lock and remove the abort listener.

- [ ] **Step 4: Add failing integration tests for all four consumers**

Add one oversize or stalled-body regression to each consumer:

- authorization exchange: oversized 200 becomes `INVALID_RESPONSE`;
- device start: oversized 200 becomes public `INVALID_RESPONSE`;
- device poll: oversized 200 becomes public `INVALID_RESPONSE`;
- refresh: oversized 200 becomes `INVALID_RESPONSE` without clearing the
  existing vault.

Replace any mock that only hangs `response.json()` with a genuinely stalled
`ReadableStream`, proving the existing 10-second wrapper covers body reads.
Retain tests showing skipped statuses do not read their bodies:
device-start 404/5xx, device-poll 403/404, and refresh 401/5xx.

Run:

```bash
pnpm exec vitest run tests/server/codex/oauth.test.ts \
  tests/server/codex/login-manager.test.ts tests/server/codex/token-provider.test.ts
```

Expected: FAIL because consumers still call `response.json()`.

- [ ] **Step 5: Replace every OAuth `response.json()`**

Call `readBoundedJson(response, signal)` inside the existing
`withCodexOAuthRequestTimeout()` callback. Preserve the approved status
semantics:

```ts
const json = await readBoundedJson(response, signal);
return {
  response,
  payload: json.ok ? json.payload : null,
  invalidJson: !json.ok,
};
```

For authorization exchange, map an invalid result to `INVALID_RESPONSE` and a
`BoundedJsonReadError` to retryable `NETWORK_ERROR`. For refresh, invalid
successful JSON reaches the existing token parser and becomes
`INVALID_RESPONSE`; invalid non-401 4xx remains `REFRESH_REJECTED`.

- [ ] **Step 6: Run Task 4 tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/server/codex/bounded-json.test.ts \
  tests/server/codex/oauth.test.ts tests/server/codex/login-manager.test.ts \
  tests/server/codex/token-provider.test.ts
```

Expected: PASS with no raw OAuth body in snapshots or assertion output.

- [ ] **Step 7: Commit Task 4**

```bash
git add lib/server/codex/bounded-json.ts lib/server/codex/oauth.ts \
  lib/server/codex/login-manager.ts lib/server/codex/token-provider.ts \
  tests/server/codex/bounded-json.test.ts tests/server/codex/oauth.test.ts \
  tests/server/codex/login-manager.test.ts tests/server/codex/token-provider.test.ts
git commit -m "fix(codex): bound oauth json responses"
```

---

### Task 5: Integration Verification and Final Review

**Files:**
- Modify only if a verification failure identifies a defect in Tasks 1-4.
- Review: `docs/superpowers/specs/2026-07-17-codex-stream-resource-hardening-design.md`
- Review: `docs/superpowers/plans/2026-07-17-codex-stream-resource-hardening.md`

**Interfaces:**
- Consumes all prior task commits.
- Produces no new public interface.

- [ ] **Step 1: Run the complete targeted Codex regression**

```bash
pnpm exec vitest run tests/server/codex tests/ai/codex-model.test.ts \
  tests/ai/codex-provider.test.ts tests/api/codex-auth.test.ts \
  tests/api/codex-auth-login.test.ts tests/api/codex-image-routes.test.ts
```

Expected: all selected files pass with zero failures and no unhandled
rejections.

- [ ] **Step 2: Run static and repository-wide verification**

Run in order:

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check:i18n-keys
pnpm test
pnpm build
```

Expected: every command exits `0`. Existing explicitly skipped tests may remain
skipped; no new skip is allowed.

- [ ] **Step 3: Verify security and scope invariants**

Run:

```bash
git diff 72fb8a75..HEAD --check
git diff 72fb8a75..HEAD | rg -n \
  \"access-token|refresh-token|account-id|device_auth_id|code_verifier|b64_json\" || true
git status --short
```

Expected: no whitespace error, no real secret/content fixture, and only
intentional plan/spec tracking state. Confirm by inspection that public DTOs,
Fast, image transport, and settings files are unchanged.

- [ ] **Step 4: Request independent whole-branch review**

Review from base `72fb8a75` to current HEAD against the design and this plan.
Require the reviewer to classify Critical/Important/Minor findings and focus on:

- lifecycle invalidation races;
- timers, listeners, and reader cleanup;
- 401 replay identity stability;
- resource-boundary off-by-one behavior;
- OAuth status-classification regressions; and
- sensitive-data exposure.

Fix every Critical or Important finding with a focused failing test, rerun its
covering suite, and request re-review.

- [ ] **Step 5: Commit any review fixes**

If review fixes were required:

```bash
git add -u
git diff --cached --check
git commit -m "fix(codex): close stream hardening review gaps"
```

If no fix was required, do not create an empty commit.
