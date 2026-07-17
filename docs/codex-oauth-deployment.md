# Experimental Codex OAuth deployment

The native ChatGPT/Codex sign-in is an **experimental, single-user** integration for a
self-hosted OpenMAIC instance. It consumes the signed-in user's ChatGPT plan quota and is not a
general OpenAI API-key replacement.

## Supported topology

Run exactly one persistent OpenMAIC server as a single Node process:

- one user;
- one Node process;
- `replica=1`;
- a persistent volume mounted at `/app/data` for Docker; and
- an `ACCESS_CODE` on every production instance.

There is **no serverless support** and **no shared-volume horizontal scaling**. Do not place two
OpenMAIC processes, containers, or maintenance commands over the same data directory. The OAuth
runtime uses a private lock directory containing one cryptographically unique claim per contender.
Each claim is written and fsynced before an atomic hard-link publishes it. A process can unlink only
its own unique claim, or a different unique claim whose owner is verifiably dead; the fixed directory
is never renamed or removed by the runtime. This removes the fixed-path successor race in which a
stale cleanup could otherwise move or delete a newer live owner.

The v2 directory deliberately occupies the legacy coordination pathname
`data/auth/.openmaic-codex-runtime.lock`. A legacy v1 process publishes a file at that path, while
v2 publishes a directory. During an overlapping upgrade, each version therefore observes the
other shape as occupied and fails closed instead of opening an independent lock namespace.

After every old v1 process has stopped, an old PID-only **legacy v1 lock file** can remain at that
path. V2 does not automatically reclaim it because PID reuse cannot be ruled out from the legacy
record. Stop every app, helper, and container that can mount the data volume; verify that none is
running and that the application endpoint is unreachable; then verify the path is the old regular
file rather than a v2 directory before removing only that lock file. Never remove the OAuth vault or
model cache as part of this migration. If ownership is ambiguous, leave the file in place and keep
the integration unavailable.

Claims carry a hashed runtime scope, PID, and OS-derived process start identity. PID is never enough
by itself: a matching PID with a different start identity is PID reuse and can be reclaimed. On
Linux the scope binds the boot plus host/container context and `/proc/<pid>/stat` supplies start
identity; on Darwin the boot session and OS process start time are used. A different or unverifiable
scope, an unreadable process identity, a malformed claim, or an unknown directory entry fails closed
and is never treated as dead. Same-process/HMR reentry also reopens the directory and its own claim
without following symlinks and validates directory plus claim device/inode, mode, and contents.

The final scoped maintenance release unlinks only its own unique claim. A normal server keeps its
process-lifetime claim until actual process exit or the next same-scope recovery. Therefore an
ordinary `docker compose restart openmaic` works even though Node is PID 1: the container scope stays
stable while the new PID 1 has a different start identity. A crash followed by recreation into an
unverifiable *different* container scope deliberately fails closed. In that exceptional case, stop
and verify every process/container using the volume before an operator removes stale claim files;
never guess that a foreign-scope claim is dead and never remove OAuth credential files.

This is a local process-safety boundary, not a distributed coordination system; a shared filesystem
does not make horizontal scaling safe.

This constraint applies even when an orchestrator can mount the same persistent volume into
multiple replicas: keep the deployment at `replica=1`. Rolling updates must stop the old process
before starting the replacement. If overlap occurs, runtime-lock acquisition makes the replacement
fail safely; it does not authorize overlapping replicas.

## Configuration

Codex sign-in is available after installation; there is no feature flag to enable it. Settings
presents both login methods in this order:

1. **Sign in with ChatGPT** opens browser PKCE. Choose it when the OpenMAIC process and browser run
   on the same computer because its callback listens on localhost port `1455`.
2. **Use device code** opens the device authorization flow. Docker/VPS and other remote-host users
   can select this method directly.

Every production instance still requires:

```env
ACCESS_CODE=replace-with-an-instance-access-code
```

Codex OAuth is deliberately rejected in known serverless environments and in production without
`ACCESS_CODE`. The data directory must be writable by the one OpenMAIC process.

## Local process

Use one of the normal single-process startup modes:

```bash
pnpm dev
```

or:

```bash
pnpm build
pnpm start
```

Do not run both commands against the same checkout and `data/` directory. Stop the running app
before invoking the offline force-refresh helper described in the
[real-account acceptance runbook](codex-real-account-acceptance.md). The helper's HTTP probe is an
additional operator check; the shared runtime lock is what excludes concurrent vault access.

## Docker

The checked-in Compose file already gives the single `openmaic` service a named volume:

```yaml
services:
  openmaic:
    volumes:
      - openmaic-data:/app/data
volumes:
  openmaic-data:
```

Start it without scaling:

```bash
docker compose up --build -d
```

Do not use `docker compose up --scale openmaic=2`, Kubernetes replicas greater than one, or a
serverless platform for this integration. Preserve the named volume across ordinary container
restarts. Recreating a crashed container can change its verifiable scope and intentionally require
the fail-closed operator recovery described above. Removing the volume signs the user out and
deletes the server-side catalog cache.

## Models and Fast

The connected account's public catalog is authoritative. **Fast is the priority service tier**,
not a separate model, and it is **entitlement-dependent**. OpenMAIC offers Fast only for a model
whose current account catalog advertises `priority`; the acceptance harness requires that path to
pass when advertised and reports `SKIP` otherwise.

Disconnecting hides the Codex provider from the server provider catalog. The UI must then fall back
to another configured provider until the user signs in again.

## Codex image generation

Codex image generation reuses the existing ChatGPT/Codex login; there is no separate image API key,
base URL, or model picker. The model is fixed to `gpt-image-2`. Supported aspect ratios map to these
requested size hints:

| Aspect ratio | Requested size hint |
| --- | --- |
| `16:9` | `1536x864` |
| `4:3` | `1024x768` |
| `1:1` | `1024x1024` |
| `9:16` | `864x1536` |

These hints are not guaranteed output dimensions. The backend can return a different response
`size`, and the decoded image can differ from both request and response metadata. Request/response/ratio
drift is soft evidence: it is recorded only as bounded, non-content operational metadata and does
not by itself turn a safe HTTP 200 image into a `502`.

The decoded PNG IHDR supplies the actual image dimensions. The public DTO width and height must be
positive integers and must exactly match that IHDR. The shared resource-safety contract accepts at
most a 20 MiB decoded PNG payload, an edge of 8,192 pixels, and 16,777,216 pixels total. MIME,
canonical base64, PNG structure, DTO/IHDR agreement, and these limits remain hard failures. Enforcing
an exact aspect ratio would require a post-success crop or resize rather than a `502` rejection of an
otherwise safe image.

The single non-contractual manual incident observation is recorded only in the
[real-account acceptance runbook](codex-real-account-acceptance.md#single-non-contractual-manual-incident-observation).
It is operational evidence, not an output-size promise.

This is an experimental integration with a third-party subscription-backend route, not a general
OpenAI Images API. It fails closed unless the existing Codex login, account entitlement, exact
backend route, and response contract can all be verified; it does not fall back to another image
transport.

Requests identify this client truthfully with `originator: openmaic`, an `OpenMAIC/<version>` user
agent, and a `version` header containing the OpenMAIC package version. They do not claim to be a
Codex CLI build.

Image generation counts against the signed-in account's general ChatGPT/Codex plan limits.
[Official usage guidance](https://learn.chatgpt.com/docs/image-generation) estimates that image turns
consume included limits about 3–5x faster than similar turns without image generation, depending on
image quality and size. Treat that ratio as planning guidance rather than a guaranteed per-request
charge, because account entitlements and plan limits can change.

## Explicitly out of scope

- **WebSocket** transport
- reference-image editing and **multi-image** requests
- user-selectable output format or quality, transparent background, and **2K/4K UI** controls
- image-model discovery, a Responses API fallback, and **CLIProxyAPI**
- **multi-account** hosting or account switching within one server data directory
- **multi-instance** deployment or horizontal scaling
- upstream **thread-id** state

The integration uses text and fixed-model, single-image generation over public OpenMAIC HTTP routes.
These exclusions are not deployment knobs and must not be inferred from a successful acceptance
run.

## Acceptance and operations

Real-account checks are manual and must not run in CI. Follow
[`docs/codex-real-account-acceptance.md`](codex-real-account-acceptance.md) before a release or
deployment change. Image acceptance is opt-in with `--include-image`; each invocation with that flag
makes one local `/api/generate/image` request when the server advertises `codex-image`. The transport
uses one upstream POST and permits one additional POST only after a `401` credential refresh; it does
not retry `429`, `5xx`, network, or timeout failures. If that capability is absent, the harness
reports `SKIP` without an image request or quota impact. The
default harness makes no image request. The harness prints only safe PASS/FAIL/SKIP facts; it never
prints the access code, session cookie, account identity, generated text or image, prompt, base64,
or upstream response body.

For the real-account UI cycle in the runbook, use exactly one **Retry** on one existing failed-image
task. Do not also run the CLI `--include-image` option in that same cycle, and never replace the local
route with a direct upstream probe. The CLI option is reserved for a separate, explicitly approved
black-box cycle so quota impact remains one image turn at a time.
