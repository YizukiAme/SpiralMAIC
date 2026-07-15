# Codex Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the verified native Codex OAuth provider into the SpiralMAIC localhost:3000 worktree while preserving its unrelated dirty changes and aligning the Codex settings surface with other providers.

**Architecture:** Finish the naming and UI refinements in the isolated `SpiralMAIC-codex-oauth` worktree, where the complete provider already passes its functional suite. Then apply the single base-to-HEAD diff to the current SpiralMAIC working tree; the two trees share base `83b69c8`, and a dry-run has proven all twelve overlapping paths apply cleanly.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Zustand, Vercel AI SDK 6, Vitest, Playwright, pnpm.

## Global Constraints

- User-visible provider name is `Codex`; internal provider id remains `openai-codex`.
- The authentication action remains `Sign in with ChatGPT` / `使用 ChatGPT 登录`.
- OAuth credentials remain server-only and are never copied into Zustand, localStorage, logs, patches, or command output.
- Do not stash, reset, merge, cherry-pick, or commit the existing dirty SpiralMAIC worktree.
- Preserve SpiralMAIC store migration version 5 and every unrelated revisit/overtime locale addition.
- Do not modify `components/revisit/review-panel.tsx` or remove the `md:flex-row!` workaround.
- Image generation, multi-account, multi-instance, serverless, and WebSocket support remain out of scope.

---

### Task 1: Refine Codex naming, login state, and provider-style UI

**Files:**
- Modify: `tests/ai/codex-provider.test.ts`
- Modify: `tests/i18n/codex-oauth-locales.test.ts`
- Modify: `tests/settings/codex-oauth-client.test.ts`
- Modify: `tests/settings/codex-settings-surface.test.ts`
- Modify: `lib/ai/providers.ts`
- Modify: `lib/client/codex-oauth.ts`
- Modify: `components/settings/codex-provider-settings.tsx`
- Modify: `components/settings/index.tsx`
- Modify: `lib/i18n/locales/ar-SA.json`
- Modify: `lib/i18n/locales/en-US.json`
- Modify: `lib/i18n/locales/ja-JP.json`
- Modify: `lib/i18n/locales/ko-KR.json`
- Modify: `lib/i18n/locales/pt-BR.json`
- Modify: `lib/i18n/locales/ru-RU.json`
- Modify: `lib/i18n/locales/zh-CN.json`
- Modify: `lib/i18n/locales/zh-TW.json`
- Modify: `tests/store/settings-server-sync.test.ts`
- Modify: `e2e/tests/codex-oauth-settings.spec.ts`

**Interfaces:**
- Consumes: `PROVIDERS['openai-codex']`, `CodexOAuthClientSnapshot`, `CodexOAuthLoginMethod`, provider `ModelConfig`, locale JSON, settings source, and existing shared Button/Alert/Label styles.
- Produces: `CodexOAuthClientSnapshot.startingMethod: CodexOAuthLoginMethod | null`, the `Codex` display name, `connectTitle` locale key, standard read-only model rows, and the hidden Save action.

- [ ] **Step 1: Write failing provider and locale assertions**

Change the provider registry expectation to `name: 'Codex'`. Add `settings.codexOAuth.connectTitle` to `CODEX_KEYS`, and assert every locale has `settings.providerNames['openai-codex'] === 'Codex'`.

- [ ] **Step 2: Write a failing login-method test**

Use a deferred POST response in `tests/settings/codex-oauth-client.test.ts`, call `startDevice()`, and assert the in-flight snapshot contains:

```ts
expect(client.getSnapshot()).toMatchObject({
  busy: 'starting',
  startingMethod: 'device',
});
```

Resolve the POST with `pendingDevice()` and assert `startingMethod` returns to `null`.

- [ ] **Step 3: Write failing settings-surface assertions**

Require the component source to contain `settings.codexOAuth.connectTitle`, a `data-codex-model-row` marker, and standard success/error box classes. Require `components/settings/index.tsx` to guard the Save button when `selectedProviderId === 'openai-codex'`.

- [ ] **Step 4: Run focused tests and observe failure**

Run:

```bash
pnpm vitest run tests/ai/codex-provider.test.ts tests/i18n/codex-oauth-locales.test.ts tests/settings/codex-oauth-client.test.ts tests/settings/codex-settings-surface.test.ts
```

Expected: failures for the old `ChatGPT Codex` name, absent `connectTitle`, absent `startingMethod`, and old panel/footer markup.

- [ ] **Step 5: Rename the provider without changing auth copy**

Set the registry fallback and all eight `settings.providerNames.openai-codex` values to `Codex`. Update exact-name unit fixtures and E2E provider selectors. Do not change `signInBrowser`, `connected`, or quota/workspace strings.

- [ ] **Step 6: Track the starting login method**

Add `startingMethod` to the snapshot interface and initial states. Publish `browser` before the browser POST, publish `device` before the device POST (including fallback), and clear it whenever the attempt is accepted, cancelled, completed, failed, or signed out.

- [ ] **Step 7: Align the dedicated panel**

Use the shared header as the only provider title. Add a neutral `connectTitle`; render models in read-only bordered rows with capability/context metadata; render test results in the standard bordered success/error pattern; and apply destructive hover/text styling to Sign out.

- [ ] **Step 8: Hide the irrelevant Save action**

Compute whether the selected surface is Codex and render only Close in the footer for that surface. Leave Save unchanged for all other settings sections/providers.

- [ ] **Step 9: Run focused tests to green**

Run the Task 1 Vitest command. Expected: all tests pass.

- [ ] **Step 10: Run the Codex Playwright settings test**

Run:

```bash
pnpm playwright test e2e/tests/codex-oauth-settings.spec.ts
```

Expected: 3 tests pass, including popup fallback, device login, test feedback, and logout fallback.

- [ ] **Step 11: Commit the clean-worktree refinement**

Stage only the design, plan, UI, locale, and test files changed by Tasks 1–2, then commit as:

```bash
git commit -m "feat(codex): align oauth provider settings"
```

### Task 2: Import the verified feature into the live SpiralMAIC worktree

**Files:**
- Modify/Create: every functional path in `git diff --name-only 83b69c8..codex/native-codex-oauth`, excluding ignored `docs/` process artifacts
- Preserve: all pre-existing dirty and untracked files in `/Users/yizuki/Workshop/Codes/SpiralMAIC`

**Interfaces:**
- Consumes: a clean feature branch whose merge base is `83b69c8`.
- Produces: an unstaged combined SpiralMAIC worktree containing both existing revisit work and Codex OAuth.

- [ ] **Step 1: Stop localhost:3000 before changing dependencies**

Terminate only the process whose cwd is `/Users/yizuki/Workshop/Codes/SpiralMAIC`; leave other unrelated processes untouched.

- [ ] **Step 2: Re-run the patch dry-run**

Run from the main worktree:

```bash
git -C ../SpiralMAIC-codex-oauth diff --binary 83b69c8..HEAD -- . ':!docs' | git apply --check
```

Expected: exit 0 with no rejected hunks.

- [ ] **Step 3: Apply the complete feature diff as a working-tree patch**

Run the same pipeline without `--check`. Do not use `--index`; the existing Spiral changes must remain unstaged. The ignored design/plan documents stay only in the isolated worktree.

- [ ] **Step 4: Audit the twelve overlapping paths**

Confirm package.json contains `dagre-d3-es`, `html-to-image`, and `@ai-sdk/openai ^3.0.84`; settings migration remains version 5; all eight locale files contain both revisit additions and Codex keys; the settings server-sync test contains both suites.

- [ ] **Step 5: Validate dependencies**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: exit 0 without rewriting `pnpm-lock.yaml`.

### Task 3: Verify the combined application and localhost:3000

**Files:**
- Runtime only: `/Users/yizuki/Workshop/Codes/SpiralMAIC/data/auth/openai-codex.json` after a fresh login.

**Interfaces:**
- Consumes: the combined dirty worktree and feature flags.
- Produces: a verified live Codex provider on localhost:3000.

- [ ] **Step 1: Run focused combined tests**

Run the focused Codex/settings/i18n tests plus `tests/store/settings-server-sync.test.ts`. Expected: all pass.

- [ ] **Step 2: Run repository checks**

Run `pnpm check:i18n-keys`, `pnpm exec tsc --noEmit`, changed-file ESLint/Prettier, then `pnpm build`. Expected: every command exits 0.

- [ ] **Step 3: Run the full Vitest suite**

Run `pnpm test`. Expected: all test files and tests pass; any unrelated pre-existing failure must be reported rather than hidden.

- [ ] **Step 4: Start localhost:3000 with OAuth enabled**

Start development with:

```bash
OPENMAIC_ENABLE_CODEX_OAUTH=true OPENMAIC_CODEX_BROWSER_LOGIN=true pnpm dev
```

Expected: `/api/codex/auth` returns HTTP 200 with methods `browser` and `device`; `/api/server-providers` remains valid.

- [ ] **Step 5: Verify the real settings UI**

Open localhost:3000, select `Codex`, verify no API key/base URL or Save button appears, verify the experimental notice and both login methods, then complete a fresh browser login. Confirm the Connected badge, read-only model rows, Test connection action, and provider selection persist without OAuth secrets entering localStorage.

- [ ] **Step 6: Audit secrets and unrelated work**

Search tracked/untracked diffs for credential-shaped values without printing vault contents. Confirm `data/auth/openai-codex.json` is ignored, the pre-existing revisit work is still present, and no feature integration commit was created in the dirty main worktree.
