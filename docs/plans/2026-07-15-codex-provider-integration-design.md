# Codex Provider Integration Design

## Goal

Bring the already verified native Codex OAuth provider into the SpiralMAIC worktree that serves localhost:3000 without discarding or committing the unrelated revisit work in progress. Present the provider as `Codex` while keeping `Sign in with ChatGPT` for the authentication action.

## Integration boundary

- Keep the internal provider id `openai-codex`, OAuth routes, vault format, and transport contract unchanged.
- Apply the complete diff from the clean `codex/native-codex-oauth` worktree to the dirty `codex/revisit-seat-spike` worktree as an unstaged working-tree patch.
- Do not stash, reset, merge, cherry-pick, or copy the existing OAuth credential file.
- Preserve all existing SpiralMAIC changes, including store migration version 5, revisit locale additions, and the `md:flex-row!` Tabs workaround.

## Provider UI

The Codex provider remains a normal entry in the shared provider list and shared settings header. Its content panel stays OAuth-specific because an API key and base URL are neither editable nor stored client-side.

- Show `Codex` as the provider name in all eight locales and in the registry fallback.
- Keep `Sign in with ChatGPT`, ChatGPT workspace, and ChatGPT plan copy because those describe the authentication and quota source.
- Replace the duplicated panel title with a compact experimental notice.
- Use a neutral `Connect Codex` card title, then expose browser and device-code actions as separate buttons.
- Render discovered models as the same read-only row cards used by ordinary providers.
- Render connection-test success and failure as bordered status panels with icons.
- Style sign-out as a destructive outline action.
- Track the login method being started so the spinner appears on the correct button, including browser-to-device fallback.
- Hide the global Save action when Codex is selected because OAuth state is persisted server-side immediately.

## Verification

First prove the new contracts fail in Vitest, then implement the smallest changes that make them pass. Run the focused Codex/settings/i18n suites in the clean worktree before importing the full diff. After integration, validate the combined lockfile, run focused tests plus TypeScript/i18n/build checks, restart localhost:3000 with the two OAuth feature flags, and verify the settings flow in a real browser. The main worktree must require a fresh login rather than silently sharing a refresh token with the still-running 3002 process.
