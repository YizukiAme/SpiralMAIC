# Codex Stream and OAuth Resource Hardening

**Date:** 2026-07-17
**Status:** Approved for implementation

## Goal

Close three remaining lifecycle and resource-boundary gaps in the native Codex
provider without changing its public APIs, settings UI, model selection, Fast
mode, image generation, or deployment scope:

1. stop an already-started text response from delivering new chunks after
   logout, account replacement, or permanent credential invalidation;
2. bound the complete text response lifetime and resource consumption; and
3. bound every OAuth JSON response before decoding and parsing it.

The supported deployment remains one local/self-hosted user, one Node process,
one replica, and a persistent data directory.

## Rejected Alternatives

### End-of-stream currentness check only

Revalidating the credential lease only at EOF can prevent a non-streaming caller
from publishing a stale final result. It cannot retract SSE chunks that were
already sent, and it allows an old account response to continue streaming after
logout. An EOF check remains useful as defense in depth but is not sufficient.

### Per-chunk vault revalidation

Calling the existing asynchronous lease validator before every raw chunk would
repeatedly read the credential vault and still would not wake a stalled
`reader.read()` promptly after logout. It is too expensive and does not provide
the desired cancellation semantics.

### Global active-stream registry

A registry of per-stream controllers could cancel streams immediately, but it
adds process-global collection state, HMR cleanup, leak handling, and possible
logout/backpressure deadlocks. The product does not currently need active stream
metrics or graceful drain behavior, so generation-scoped cancellation is
smaller and safer.

## Credential Lifecycle Signal

`SharedCredentialState` will own one `AbortController` for the current credential
lifecycle. A single synchronous helper advances that lifecycle by:

1. retaining the previous controller;
2. incrementing the catalog/lifecycle generation;
3. installing a fresh controller; and
4. aborting the previous controller.

The helper is used by:

- logout, before asynchronous vault clearing or revocation;
- interactive login replacement, before new credentials are published; and
- permanent refresh invalidation after the matching credentials are cleared.

A normal same-account refresh-token rotation does not advance the lifecycle and
does not cancel valid in-flight work.

Internal credential leases capture both the lifecycle generation and its
corresponding signal. Acquisition verifies that neither changed while the
credential snapshot was loaded. A permitted same-lifecycle refresh preserves
the same signal. These additions are server-internal and do not change
`CodexTokenProvider`.

## Response Lifecycle Guard

Each upstream Responses attempt gets an internal guard combining:

- the credential lifecycle signal;
- the caller's `AbortSignal`, when supplied; and
- the transport's total deadline.

The final lease validation happens before sending. The combined signal is
passed to `fetch`, and currentness is checked again after headers arrive so a
test or nonstandard fetch implementation that ignores abort cannot publish a
late stale response.

For a 401, the first response body and guard are disposed before the existing
conditional refresh and single replay. The replay receives a new guard while
retaining the same normalized body and session identity.

A successful response is returned through a lifecycle-aware `Response` wrapper
that owns the upstream body reader. The wrapper:

- races stalled reads against lifecycle, caller, total, and idle cancellation;
- checks synchronous lifecycle cancellation immediately before enqueueing;
- cancels the upstream reader on every failure or consumer cancellation;
- stops delivering new chunks after credential lifecycle invalidation;
- performs one full asynchronous lease check at normal EOF before closing; and
- disposes all timers and listeners idempotently.

Chunks delivered before invalidation cannot be retracted. Logout does not wait
for downstream backpressure or stream cleanup; it only publishes cancellation
synchronously and continues its existing authoritative local-clear flow.

Lifecycle invalidation maps to the existing safe authentication-required
classification. Caller cancellation remains caller cancellation rather than
being mislabeled as a login failure. No abort reason or upstream body is exposed.

## Text Resource Limits

The following deliberately generous limits are security budgets rather than
upstream format promises:

| Limit | Value |
| --- | ---: |
| Total fetch and response lifetime | 15 minutes |
| Continuous response-body idle time | 3 minutes |
| Raw response bytes | 32 MiB |
| Parsed stream parts | 250,000 |
| Content items / tracked blocks | 4,096 |
| One accumulated tool input | 4 MiB |

The raw-byte, deadline, and idle limits are enforced by the transport-owned
response wrapper. They apply to both streaming and non-streaming generation.

The middleware stream sanitizer enforces parsed-part, content-item, and
tool-input limits before forwarding parts. Non-streaming generation aggregates
the same sanitized stream rather than bypassing those limits. This bounds event
and object amplification after the raw SSE bytes have been decoded by the AI
SDK.

Resource-limit failures use existing safe Codex stream/upstream error messages.
They never include generated content, tool input, account data, credentials, or
raw upstream events.

## Bounded OAuth JSON

All four OAuth JSON consumers use one server-only bounded reader:

- authorization-code token exchange;
- device user-code creation;
- device authorization polling; and
- token refresh.

The reader has a 1 MiB byte limit. It first rejects an oversized valid
`Content-Length`, then streams the body while independently enforcing the actual
byte count. It performs strict UTF-8 decoding and `JSON.parse` only after the
body is complete and within budget.

The reader runs inside the existing `withCodexOAuthRequestTimeout` callback, so
the same 10-second deadline covers fetch, body reading, decoding, and parsing.
It consumes the wrapper-created signal, cancels its reader on abort, and does not
retain or log the response body.

Status-specific behavior remains unchanged:

- device-start 404/5xx and device-poll 403/404 do not consume a body;
- refresh 401/5xx does not consume a body;
- invalid or oversized successful JSON is `INVALID_RESPONSE`;
- response-body transport failure remains a retryable network failure; and
- a refresh 4xx with an invalid body remains `REFRESH_REJECTED` unless the HTTP
  status alone is already terminal.

## Testing

Implementation follows red-green-refactor for each boundary.

### Lifecycle tests

- logout synchronously aborts the old lifecycle while vault/revoke work is
  pending;
- same- and different-account interactive login replacement abort old leases;
- permanent refresh invalidation aborts old leases;
- normal same-account refresh does not abort them;
- a new lifecycle is not affected by a prior abort; and
- retained development/HMR state is normalized safely.

### Transport tests

- logout before headers prevents a late response from being returned even when
  mock fetch ignores abort;
- logout before the first chunk delivers zero chunks;
- logout after one chunk preserves that chunk but never delivers the next;
- a stalled body read wakes and cancels on lifecycle invalidation;
- 401 replay retains its normalized body/session and receives cancellation;
- caller cancellation and lifecycle cancellation settle exactly once;
- total, idle, raw-byte, part, item, and tool-input limits fail safely; and
- normal EOF, source error, and consumer cancellation release readers,
  listeners, and timers.

### OAuth tests

- normal, empty, malformed, invalid UTF-8, declared-oversized, and
  chunked-oversized JSON;
- body stream failure and parent abort;
- body that never completes is bounded by the existing request deadline;
- device-start, device-poll, authorization exchange, and refresh preserve their
  existing public classifications; and
- no error or DTO contains token, device ID, account ID, or response content.

## Verification

After targeted tests pass, run:

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check:i18n-keys
pnpm test
pnpm build
```

No real account request or image generation is required for these
transport-boundary changes. The branch is not pushed and no pull request is
created.
