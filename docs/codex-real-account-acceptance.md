# Codex real-account acceptance runbook

This is a manual release/deployment runbook using a consenting real ChatGPT account. It is **not CI**,
must not be scheduled, and must not run with unattended credentials. Complete automated tests and
code review before starting it.

The HTTP harness is black-box: it uses only public OpenMAIC routes. It never reads the OAuth vault
and never prints the instance access code, cookie, email, account ID, token, device authorization
ID, full generated text, raw SSE, request headers, or upstream response body.

## 1. Prepare one local process

Use a clean checkout and configure `.env.local` without committing it:

```env
OPENMAIC_ENABLE_CODEX_OAUTH=true
OPENMAIC_CODEX_BROWSER_LOGIN=true
ACCESS_CODE=replace-with-a-local-instance-access-code
NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true
```

The harness expects the editor route to be enabled by default, so a missing/404 route is a failure.
When the flag is deliberately false, invoke the harness with `--editor-mode disabled`; only that
explicit mode may report `SKIP stage=editor-tools`. Start exactly one process:

```bash
pnpm dev
```

If `ACCESS_CODE` is enabled, place it in the harness's dedicated environment variable without
putting the value in a command argument. For example, in zsh:

```bash
read -rs 'OPENMAIC_ACCEPTANCE_ACCESS_CODE?Instance access code: '
echo
export OPENMAIC_ACCEPTANCE_ACCESS_CODE
```

## 2. Manual browser PKCE login

1. Open `http://localhost:3000`, unlock the instance, and open Settings.
2. Select **Codex**, then **Sign in with ChatGPT**.
3. Complete the browser PKCE flow in the opened window. The local callback uses port `1455`.
4. Confirm Settings says **Connected with ChatGPT** and shows a non-empty model catalog. Do not
   copy account details into this runbook or a ticket.
5. Run the black-box harness:

   ```bash
   pnpm --silent accept:codex -- --base-url http://localhost:3000
   ```

Every line must begin with `PASS`, `FAIL`, or `SKIP`. Expect connected auth, a strict catalog,
normal verification, outline streaming, one simple slide JSON response, and (when enabled) an
editor tool call followed by tool completion and later assistant output. Fast must be `PASS` when
the selected catalog model advertises priority; it must be an explicit `SKIP` otherwise.

## 3. Logout and device-code login

1. In Settings, sign out of Codex.
2. Verify the signed-out public state:

   ```bash
   pnpm --silent accept:codex -- --base-url http://localhost:3000 --expect-signed-out
   ```

   It must report disconnected auth and `providerPresent=false`. Signed-out mode does not perform a
   logout itself.

3. Select **Use device code**, open the displayed verification page manually, and enter the
   one-time code manually. Never paste the code into a log or automation.
4. Wait for Settings to show connected, then rerun the normal harness command.

## 4. Offline force refresh and restart

The app holds a private runtime lock for its process lifetime. The force-refresh helper acquires the
same lock atomically before it imports the production token-provider runtime, and holds it until the
refresh finishes. This is the exclusion primitive that prevents **two vault writers**: if either the
app or helper already owns the lock, the other process fails safely without touching OAuth state.
Still stop the app first (for example, press `Ctrl-C` in the `pnpm dev` terminal).

Confirm the server is no longer reachable, then run:

```bash
pnpm --silent refresh:codex -- --base-url http://localhost:3000 --confirm-app-stopped
```

The confirmation flag is necessary but not sufficient: the command also probes `/api/health`. That
probe is an additional operator-safety check, not the exclusion primitive. The helper continues
only after a connection refusal and successful runtime-lock acquisition. An active response, an
ambiguous timeout/DNS/network failure, or a live lock owner makes it refuse to proceed; none is
permission to write. Run the helper from the same checkout so it targets the same local `data/`
directory. It prints no credentials.

The helper publishes its own cryptographically unique claim in the private lock directory. Its final
scoped release unlinks only that claim; it cannot move or delete a successor claim. A server keeps
its process-lifetime claim through the run. After a crash or ordinary restart, the next process
reclaims only a unique claim whose hashed scope matches and whose OS process start identity proves
the recorded owner is dead or its PID was reused. A live, malformed, foreign-scope, or otherwise
unverifiable claim fails closed. Do not remove a claim merely because its PID looks stale, and never
remove or inspect the OAuth credential vault while recovering the runtime lock.

Restart the one local process and rerun the normal harness:

```bash
pnpm dev
pnpm --silent accept:codex -- --base-url http://localhost:3000
```

Then stop and start the local process once more without force refresh. The account and current
catalog should survive an ordinary local process restart.

## 5. Docker named-volume login and restart

Set `OPENMAIC_ENABLE_CODEX_OAUTH=true`, `OPENMAIC_CODEX_BROWSER_LOGIN=false`, and `ACCESS_CODE` in
`.env.local`. The Compose deployment must remain one container with the `openmaic-data` named
volume mounted at `/app/data`:

```bash
docker compose up --build -d
docker compose ps
```

Use **Use device code** in Settings, complete login manually, and run the normal harness against the
published base URL. Restart without removing the named volume:

```bash
docker compose restart openmaic
pnpm --silent accept:codex -- --base-url http://localhost:3000
```

The login must survive. Do not scale the service, run a second container over the named volume, or
run the local offline refresh helper against a volume still mounted by the app.

`docker compose restart openmaic` restarts the existing container, so the verifiable container scope
remains stable and a new PID 1 start identity safely replaces the old claim. Recreating a crashed
container can produce a different scope; that case intentionally fails closed and requires the
operator recovery described in the deployment guide after every volume user is confirmed stopped.

## 6. Logout, cache deletion, provider fallback, and relogin

This destructive cache exercise tests recovery without deleting credentials unexpectedly:

1. Sign out in Settings and rerun the harness with `--expect-signed-out`.
2. Stop the app. For the local-process test, delete only the non-secret catalog cache:

   ```bash
   rm -f data/cache/openai-codex-models.v1.json
   ```

   Do not delete or inspect files under `data/auth/`.

3. Restart. Confirm Codex remains absent and the UI performs provider fallback to another configured
   provider rather than retaining a stale Codex selection.
4. Perform a device-code or browser PKCE relogin and rerun the normal harness. A fresh catalog must
   appear and generation must pass again.

For Docker, exercise logout/provider fallback/relogin without removing the named volume. Removing
the entire volume is a separate disaster-recovery action, not a cache-deletion test.

## 7. Final secret scan

Keep the app log in a local ignored file while testing. Review it without pasting matches into a
ticket. A quiet scan avoids echoing a discovered secret:

```bash
CODEX_SECRET_PATTERN='"?(?:access_token|accessToken|refresh_token|refreshToken|account_id|accountId|account_scope|accountScope|scope|device_auth_id|deviceAuthId|device_authorization_id|deviceAuthorizationId|code_verifier|codeVerifier|pkce_verifier|pkceVerifier|session_cookie|sessionCookie|cookie|authorization)"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{6,}|(?:authorization|set-cookie|cookie)\s*:\s*[^\r\n]{6,}|openmaic_access=[A-Za-z0-9._~+/=-]{6,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{6,}){1,2}|sk-[A-Za-z0-9_-]{16,}'
if [ ! -r .codex-acceptance.log ]; then
  echo 'FAIL: acceptance log is missing or unreadable'
else
  rg -q -i -- "$CODEX_SECRET_PATTERN" .codex-acceptance.log >/dev/null 2>&1
  log_scan_status=$?
  if [ "$log_scan_status" -eq 0 ]; then
    echo 'FAIL: credential-shaped data found in log; investigate locally'
  elif [ "$log_scan_status" -eq 1 ]; then
    echo 'PASS: no credential-shaped data found in log'
  else
    echo 'FAIL: log secret scan could not complete'
  fi
fi
```

In browser DevTools, inspect localStorage without returning keys or values. The result contains only
a safe outcome and count:

```js
(() => {
  const secretPattern = new RegExp(String.raw`"?(?:access_token|accessToken|refresh_token|refreshToken|account_id|accountId|account_scope|accountScope|scope|device_auth_id|deviceAuthId|device_authorization_id|deviceAuthorizationId|code_verifier|codeVerifier|pkce_verifier|pkceVerifier|session_cookie|sessionCookie|cookie|authorization)"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{6,}|(?:authorization|set-cookie|cookie)\s*:\s*[^\r\n]{6,}|openmaic_access=[A-Za-z0-9._~+/=-]{6,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{6,}){1,2}|sk-[A-Za-z0-9_-]{16,}`, 'i');
  const suspectStorageEntryCount = Object.entries(localStorage).filter(
    ([key, value]) => secretPattern.test(`${key}=${value}`),
  ).length;
  return {
    outcome: suspectStorageEntryCount === 0 ? 'PASS' : 'FAIL',
    suspectStorageEntryCount,
  };
})();
```

The count must be zero. Finally scan the git diff quietly and check its shape:

```bash
CODEX_SECRET_PATTERN='"?(?:access_token|accessToken|refresh_token|refreshToken|account_id|accountId|account_scope|accountScope|scope|device_auth_id|deviceAuthId|device_authorization_id|deviceAuthorizationId|code_verifier|codeVerifier|pkce_verifier|pkceVerifier|session_cookie|sessionCookie|cookie|authorization)"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{6,}|(?:authorization|set-cookie|cookie)\s*:\s*[^\r\n]{6,}|openmaic_access=[A-Za-z0-9._~+/=-]{6,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{6,}){1,2}|sk-[A-Za-z0-9_-]{16,}'
if ! git_delta=$(git diff --no-ext-diff HEAD); then
  echo 'FAIL: git diff could not be read'
else
  printf '%s' "$git_delta" | rg -q -i -- "$CODEX_SECRET_PATTERN" >/dev/null 2>&1
  diff_scan_status=$?
  if [ "$diff_scan_status" -eq 0 ]; then
    echo 'FAIL: credential-shaped data found in staged or unstaged git diff; investigate locally'
  elif [ "$diff_scan_status" -eq 1 ]; then
    echo 'PASS: no credential-shaped data found in staged or unstaged git diff'
  else
    echo 'FAIL: git diff secret scan could not complete'
  fi
  unset git_delta
fi
if git diff --no-ext-diff HEAD --check >/dev/null; then
  echo 'PASS: staged and unstaged git diff has no whitespace errors'
else
  echo 'FAIL: staged or unstaged git diff has whitespace errors; inspect locally'
fi
git status --short
```

Unset the harness-only access code when finished:

```bash
unset OPENMAIC_ACCEPTANCE_ACCESS_CODE
```
