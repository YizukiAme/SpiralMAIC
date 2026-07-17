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

## Explicitly out of scope

- **Images** through the Codex subscription transport
- **WebSocket** transport
- **multi-account** hosting or account switching within one server data directory
- upstream **thread-id** state

The integration uses text generation over public OpenMAIC HTTP routes. These exclusions are not
deployment knobs and must not be inferred from a successful acceptance run.

## Acceptance and operations

Real-account checks are manual and must not run in CI. Follow
[`docs/codex-real-account-acceptance.md`](codex-real-account-acceptance.md) before a release or
deployment change. The harness prints only safe PASS/FAIL/SKIP facts; it never prints the access
code, session cookie, account identity, generated text, or upstream response body.
