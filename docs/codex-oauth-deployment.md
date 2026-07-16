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
runtime uses a private PID/liveness lock to reject a second supported local process or maintenance
helper, and reclaims an owner only after that PID is dead. This is a local process-safety boundary,
not a distributed coordination system; a shared filesystem does not make horizontal scaling safe.

The in-process registry records the acquired device/inode together with the owner PID and nonce.
Every same-process or HMR reentry reopens the owner file without following symlinks and verifies all
four values before trusting it. A logical release only reduces in-process usage; it does not unlink
the authoritative lock pathname or surrender filesystem ownership while that process is alive.
After the owner exits, the file intentionally remains as a dead-owner tombstone. The next supported
process verifies that the PID is dead and that the device/inode and owner record are unchanged before
it reclaims the tombstone. Do not delete or replace this file manually.

This constraint applies even when an orchestrator can mount the same persistent volume into
multiple replicas: keep the deployment at `replica=1`. Rolling updates must stop the old process
before starting the replacement. If overlap occurs, runtime-lock acquisition makes the replacement
fail safely; it does not authorize overlapping replicas.

## Configuration

Start from `.env.example` and set at least:

```env
OPENMAIC_ENABLE_CODEX_OAUTH=true
ACCESS_CODE=replace-with-an-instance-access-code
```

For a local, bare-metal process only, browser PKCE can be enabled:

```env
OPENMAIC_CODEX_BROWSER_LOGIN=true
```

Browser PKCE listens on localhost port `1455`, so it is not the remote Docker/VPS login path. Keep
`OPENMAIC_CODEX_BROWSER_LOGIN=false` for Docker or a remote host and use the device-code button in
Settings instead.

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
serverless platform for this integration. Preserve the named volume across container restarts and
image upgrades. Removing the volume signs the user out and deletes the server-side catalog cache.

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
