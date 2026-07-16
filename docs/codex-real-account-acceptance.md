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

The editor flag is optional. When it is false, the harness must report `SKIP stage=editor-tools`.
Start exactly one process:

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
   pnpm accept:codex -- --base-url http://localhost:3000
   ```

Every line must begin with `PASS`, `FAIL`, or `SKIP`. Expect connected auth, a strict catalog,
normal verification, outline streaming, one simple slide JSON response, and (when enabled) an
editor tool call followed by tool completion and later assistant output. Fast must be `PASS` when
the selected catalog model advertises priority; it must be an explicit `SKIP` otherwise.

## 3. Logout and device-code login

1. In Settings, sign out of Codex.
2. Verify the signed-out public state:

   ```bash
   pnpm accept:codex -- --base-url http://localhost:3000 --expect-signed-out
   ```

   It must report disconnected auth and `providerPresent=false`. Signed-out mode does not perform a
   logout itself.

3. Select **Use device code**, open the displayed verification page manually, and enter the
   one-time code manually. Never paste the code into a log or automation.
4. Wait for Settings to show connected, then rerun the normal harness command.

## 4. Offline force refresh and restart

The force-refresh helper imports the production token-provider runtime and writes the same vault as
the app. Stop the app first (for example, press `Ctrl-C` in the `pnpm dev` terminal). This ordering
prevents **two vault writers**.

Confirm the server is no longer reachable, then run:

```bash
pnpm refresh:codex -- --base-url http://localhost:3000 --confirm-app-stopped
```

The confirmation flag is necessary but not sufficient: the command also probes `/api/health`. It
continues only after a connection refusal. An active response or an ambiguous timeout/DNS/network
failure makes the helper refuse to proceed; it is not permission to write. Run the helper from the
same checkout so it targets the same local `data/` directory. It prints no credentials.

Restart the one local process and rerun the normal harness:

```bash
pnpm dev
pnpm accept:codex -- --base-url http://localhost:3000
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
pnpm accept:codex -- --base-url http://localhost:3000
```

The login must survive. Do not scale the service, run a second container over the named volume, or
run the local offline refresh helper against a volume still mounted by the app.

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
if [ ! -r .codex-acceptance.log ]; then
  echo 'FAIL: acceptance log is missing or unreadable'
else
  rg -q -i 'authorization:[[:space:]]*bearer|openmaic_access=|"(access_token|refresh_token)"|eyJ[A-Za-z0-9_-]{20,}' .codex-acceptance.log
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
  const suspectStorageEntryCount = Object.entries(localStorage).filter(
    ([key, value]) =>
      /codex.*(?:token|account|email)|(?:access|refresh)[_-]?token|openmaic_access/i.test(key) ||
      /authorization:\s*bearer|openmaic_access=|"?(?:access|refresh)[_-]?token"?\s*:|eyJ[A-Za-z0-9_-]{20,}/i.test(
        value,
      ),
  ).length;
  return {
    outcome: suspectStorageEntryCount === 0 ? 'PASS' : 'FAIL',
    suspectStorageEntryCount,
  };
})();
```

The count must be zero. Finally scan the git diff quietly and check its shape:

```bash
if ! git_delta=$(git diff --no-ext-diff HEAD); then
  echo 'FAIL: git diff could not be read'
else
  printf '%s' "$git_delta" | rg -q -i 'authorization:[[:space:]]*bearer|openmaic_access=[A-Za-z0-9._~+/=-]{12,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}'
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
