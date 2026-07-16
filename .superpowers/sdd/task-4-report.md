# Task 4 Report — real-account acceptance harness and deployment documentation

## Status

DONE. Added a secret-safe black-box Codex acceptance harness, an opt-in offline production-token
refresh helper, and the bounded single-process deployment and manual real-account runbooks. No real
OAuth flow was performed.

## Implementation

- Added `pnpm accept:codex -- --base-url <origin>`, using only public application routes. It can
  establish an access-code session from `OPENMAIC_ACCEPTANCE_ACCESS_CODE`, refuses redirects, and
  formats only allowlisted PASS/FAIL/SKIP facts.
- Checks connected/signed-out auth, strict reconstructed public catalog shape, normal generation,
  same-model priority/Fast when advertised (otherwise explicit SKIP), ordered outline SSE,
  non-stream simple slide JSON, and editor read-tool start/completion followed by a new assistant
  turn. Disabled editor routing is an explicit SKIP.
- Added `pnpm refresh:codex -- --base-url <loopback-origin> --confirm-app-stopped`. It accepts only a
  loopback origin, requires explicit confirmation, treats only connection refusal as stopped,
  dynamically imports the production runtime after that check, and invokes
  `getValidCredentials({ forceRefresh: true })` without returning or printing credentials.
- Extended the existing public model-verification route so an exact Codex-only `priority` request
  can exercise Fast on the same catalog-selected model. No diagnostic API was added.
- Added English deployment and real-account acceptance documentation, README links, and `.env`
  topology guidance. The docs bound deployment to one user, one Node process, `replica=1`, and
  persistent `/app/data`; exclude serverless/shared-volume scaling; explain entitlement-dependent
  priority/Fast; and keep Images, WebSocket, multi-account, and thread-id out of scope.
- The manual runbook covers browser PKCE, logout/device code, the black-box harness, offline force
  refresh, local and Docker named-volume restarts, logout/cache removal/provider fallback/relogin,
  and fail-closed log/localStorage/staged-and-unstaged git-diff secret scans. It explicitly excludes
  real-account acceptance from CI.

## Files changed

- `.env.example`
- `README.md`
- `README-zh.md`
- `app/api/verify-model/route.ts`
- `package.json`
- `scripts/codex-acceptance-lib.ts`
- `scripts/codex-acceptance.ts`
- `scripts/codex-force-refresh-lib.ts`
- `scripts/codex-force-refresh.ts`
- `docs/codex-oauth-deployment.md`
- `docs/codex-real-account-acceptance.md`
- `tests/api/verify-model.test.ts`
- `tests/scripts/codex-acceptance.test.ts`
- `tests/scripts/codex-force-refresh.test.ts`
- `tests/scripts/codex-acceptance-package.test.ts`

## TDD evidence

- Initial RED: the three new script suites failed because both helper modules, both package scripts,
  and both required docs were absent.
- Fast RED/GREEN: route and harness assertions failed until an exact Codex `priority` tier was
  forwarded and the advertised Fast check reused the normal check's exact model.
- CLI/parser RED/GREEN: four assertions exposed the package runner's leading `--` and permissive
  outline/verification shapes; both parsers now accept one runner delimiter and response validators
  fail closed.
- Redirect RED/GREEN: the access-session test failed because fetch used the default redirect mode;
  every harness request now forces `redirect: "error"`, preventing replay of codes, cookies, or
  payloads to a redirect target.
- Editor-order RED/GREEN: a pi-agent first-turn `turn_end` with pre-tool text falsely satisfied
  continuation. The validator now requires a new post-tool `turn_start` and subsequent assistant
  update/end; the false-positive regression fails on the old behavior and passes now.
- Final focused regression: 4 files, 44/44 tests passed.

## Verification

- `pnpm exec vitest run tests/api/verify-model.test.ts tests/scripts/codex-acceptance.test.ts tests/scripts/codex-force-refresh.test.ts tests/scripts/codex-acceptance-package.test.ts` — 4 files, 44 tests passed.
- `pnpm exec tsc --noEmit --pretty false` — passed after final review fixes.
- Targeted ESLint over every changed TypeScript file — passed with no warnings after final review
  fixes. Earlier full `pnpm lint` passed with 0 errors and 13 unrelated existing warnings.
- Changed-file Prettier formatting — passed.
- `pnpm build` — passed.
- Package entry checks resolved and failed safely as intended: unreachable acceptance origin emitted
  `FAIL stage=access-session error=network`; refresh without confirmation emitted
  `FAIL stage=offline-force-refresh error=confirmation-required`.
- `pnpm test` was run once as required — 385 files passed, 2 skipped; 3,336 tests passed, 3 skipped.
  The final redirect/editor changes were then covered by the focused 44/44 run, typecheck, and
  targeted lint rather than running the broad suite a second time.
- `git diff --check` — passed.

## Self-review and concerns

- Confirmed the harness never formats the access code, cookie, email, account/scope, token,
  verifier, device authorization ID, headers, generated text, raw SSE/provider data, or upstream
  body/error. Non-OK bodies are not parsed.
- Confirmed signed-out mode stops before generation and requires provider absence; catalog parsing
  rebuilds the public DTO rather than trusting added fields; Fast is a required PASS only when the
  chosen model advertises priority.
- Confirmed the refresh helper imports no vault/runtime code before confirmation plus the stopped
  probe, and retains no returned credential object.
- The stopped-app check is deliberately a fail-closed observation, not a distributed lock. A user
  must keep the app and every other maintenance command stopped for the helper's duration; the
  deployment and runbook state this two-writer boundary. Eliminating an app-start-after-probe race
  would require production-wide cross-process coordination outside Task 4's helper-only scope.
- No constrained Tabs/review-panel, prompt-loader, or revisit time-semantics code was touched.
- Automated output contains only existing Node `module.register()` and localStorage warnings; no
  real-account or real-credential operation was run.

## Independent review fix wave — 2026-07-16

This section appends and supersedes the earlier review caveats where stated. Every Critical,
Important, and quality-follow-up item in `task-4-review-findings.md` was implemented without a real
OAuth flow and without adding a diagnostic endpoint.

### Review fixes

- Added a general resolved-model assertion to model resolution. Acceptance requests assert the
  exact `openai-codex` provider/model after stage routing has selected the effective model and before
  provider discovery or transport construction. The assertion never changes routing, and callers
  that omit it preserve existing behavior. Verify, outline, scene, and editor requests all send the
  assertion headers.
- Package entry points now use `node --no-warnings --import tsx`; documentation uses
  `pnpm --silent`. Subprocess coverage requires allowlisted stdout, empty stderr, and meaningful
  success/failure exit codes.
- Outline and editor SSE validators are ordered state machines. They require one terminal event
  last, exact canonical terminal data, one matching `read_scene_content` start/completion, a new
  post-tool turn, later assistant output, and reject retries, drift, unmatched/duplicate completion,
  early/multiple terminal, and trailing events.
- Verification text must contain non-whitespace. Outline and scene validation now require canonical
  public fields, canvas identity and viewport, theme, supported element types with their required
  fields, and an exact effective outline rather than arbitrary objects or strings.
- Editor mode is explicit and defaults to enabled. A missing route fails in default mode; only
  `--editor-mode disabled` permits a 404 SKIP.
- The runbook uses one shared quiet secret-shape expression for logs, localStorage, and the complete
  staged-plus-unstaged `git diff HEAD`. It covers snake_case and camelCase access/refresh tokens,
  account ID/scope, device auth/authorization ID, code/PKCE verifiers, cookies,
  authorization/bearer, JWT, and API-key forms, and fails closed without printing matches.
- Added a private process-lifetime lock in `data/auth`. Acquisition atomically publishes a complete
  owner record; same-PID/HMR imports are reentrant; a live other PID fails closed; a dead owner is
  reclaimed only after liveness and inode/owner snapshot validation. The app retains the lease for
  its process lifetime. The offline helper acquires the same lock before importing the production
  runtime and holds it through refresh. Public availability and helper errors remain sanitized.
- Split the former 1,304-line acceptance core into a 24-line stable barrel plus focused types,
  safe-reporting, HTTP/session, canonical-validator/SSE, and orchestration modules. CLI and test
  imports remain stable.

### Strict TDD evidence

- Resolved-model assertion RED: 2 regressions failed because a configured stage route could replace
  the asserted provider/model and the verify route did not forward assertions. GREEN: resolve-model
  plus verify-route suites passed 41/41.
- SSE/canonical JSON/editor-mode RED: 6 regressions failed on terminal ordering, permissive JSON,
  and implicit editor SKIP. GREEN: acceptance suite passed 27/27. A later adversarial regression
  independently demonstrated that unmatched/duplicate target-tool completions were accepted
  (1 RED); the tightened state machine then passed 28/28.
- Runtime-lock RED: the new suite first failed on the absent lock module plus 3 helper cases; wiring
  tests then produced 2 failures showing the normal runtime did not retain the lease, and 2 more
  showing availability/locales lacked a sanitized locked state. GREEN: lock, availability, locale,
  and helper suites passed 31/31; the actual-runtime plus helper subset passed 15/15.
- Quiet package RED: 3 assertions exposed old package commands, Node warning stderr, and stale docs.
  GREEN: package suite passed 4/4.
- Expanded secret scan RED: 1/5 failed because no single shared pattern existed. GREEN: package and
  documentation suite passed 5/5, using aggregated sentinel assertions that never echo a match.
- Behavior-preserving split GREEN: acceptance, refresh, and package suites passed 42/42 immediately
  after the module split. Static checking then found one moved-property narrowing issue and one
  explicit terminal-flow type issue; both were fixed before the verification ladder.

### Review-wave verification

- Focused final regression command over resolve-model, verify route, acceptance, refresh, package,
  runtime lock, availability, runtime, and locale suites: 9 files, 110/110 tests passed.
- `pnpm exec tsc --noEmit --pretty false`: passed with no output.
- `pnpm lint`: passed with 0 errors and 13 unrelated existing warnings.
- `pnpm check`: all matched files use Prettier code style.
- `pnpm build`: passed, including TypeScript and 45/45 static pages.
- Quiet package smokes:
  - unreachable acceptance origin: exit 1, stdout exactly
    `FAIL stage=access-session error=network`, stderr 0 bytes;
  - refresh without confirmation: exit 1, stdout exactly
    `FAIL stage=offline-force-refresh error=confirmation-required`, stderr 0 bytes;
  - the package suite's local mock-server PASS path also requires only report lines and empty stderr.
- Exactly one final full `pnpm test` was run after all implementation fixes: 386 files passed,
  2 skipped; 3,356 tests passed, 3 skipped.

### Superseded concern and final self-review

- The earlier statement that the stopped-app probe was the only boundary is superseded. The shared
  runtime lock is now the exclusion primitive; the HTTP probe remains an additional operator check.
  This is still deliberately not a distributed lock and does not expand the supported topology:
  single user, one Node process, `replica=1`, no serverless or shared-volume horizontal scaling.
- Lock ownership is never inferred from file presence alone: owner shape, no-follow regular-file
  status, inode identity, PID liveness, and nonce ownership are checked before reclaim or cleanup.
- The expected-model assertion is comparison-only and runs after all route resolution, so it cannot
  select a provider/model or send a mismatched request upstream.
- No OAuth vault contents, real credentials, real OAuth flow, or new diagnostic route were used.
  No constrained revisit/Tabs/prompt-loader/time-semantics file was touched.

## Final re-review exact-fix wave — 2026-07-16

This final wave implements only the two findings in `task-4-review-findings-2.md`.

### Exact fixes

- The scene acceptance fixture and validator now use the route's real `GeneratedSlideContent`
  response contract: `content` contains `elements` plus optional canonical `background` and
  `remark`, rather than a stored-scene `{ type: "slide", canvas }` envelope. The validator accepts
  only supported `PPTElement` kinds with their required fields, validates solid/image/gradient
  backgrounds, retains strict response/effective-outline validation, and rejects the old envelope,
  malformed backgrounds, unsupported element types, and elements missing required fields.
- Runtime-lock registry entries now retain the acquired device/inode with PID and nonce. Every
  same-PID/HMR reentry reopens the fixed lock path with no-follow semantics and matches the complete
  snapshot before trusting the registry. Logical release only decrements the reference count; it
  never unlinks or removes the process-lifetime registry ownership. Normal exit also leaves the
  authoritative owner file as a dead-owner tombstone, so only the next acquirer can reclaim it after
  the existing PID-liveness and inode-safe moved-snapshot checks. An old owner therefore performs no
  pathname unlink that could remove a replacement/successor inode.
- Deployment and real-account runbooks document device/inode reentry checks, logical-release
  semantics, dead-owner tombstones, next-process reclamation, and the instruction not to delete the
  runtime lock manually.

### Strict TDD evidence

- Scene contract RED: the route-shaped `GeneratedSlideContent` fixture failed with
  `SafeAcceptanceError: invalid-shape` at the old canvas-envelope validator (1 failed, 27 skipped).
  GREEN: the full acceptance suite passed 28/28, including the actual route fixture and retained
  malformed-but-plausible cases.
- Runtime ownership RED: 4 of 8 lock tests failed for the four reviewed gaps: last logical release
  removed the lock, copied-payload/new-inode reentry was trusted, an exiting old owner unlinked a
  replacement inode, and orderly exit removed the file instead of leaving a reclaimable tombstone.
  The first implementation run exposed a duplicate local identifier during transform; after the
  minimal correction, lock, availability, and offline-helper suites passed 29/29.
- Documentation RED: the new inode/lifetime/tombstone contract test failed because the existing docs
  had no device/inode cleanup semantics. After documenting them and making the assertion tolerate
  normal Markdown line wrapping, the package/documentation suite passed 6/6.

### Verification before final full suite

- Covering focused command over acceptance, package/docs, runtime lock, availability, runtime, and
  offline helper: 6 files, 68/68 tests passed.
- `pnpm exec tsc --noEmit --pretty false`: passed with no output.
- `pnpm lint`: passed with 0 errors and 13 unrelated existing warnings.
- `pnpm check`: all matched files use Prettier code style.
- `pnpm build`: passed, including TypeScript and 45/45 static pages.
- Exactly one final full `pnpm test` was run after both fixes: 386 files passed, 2 skipped;
  3,359 tests passed, 3 skipped.
- No real OAuth, credential/vault read, diagnostic endpoint, unrelated scope change, or push was
  performed.
