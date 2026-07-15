# Featured Demo Home-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the bundled demo card into a one-time import entry that disappears once the course is stored and leaves the imported course visible in “最近学习”.

**Architecture:** Keep featured-course identity in `lib/demo/featured-course.ts` and let the home page query that persisted identity independently of the generic recent-course list. On successful import, refresh the list, mark the demo present, expand recent courses, and stay on `/`. Remove only the obsolete empty-Spiral generation guidance and its dedicated state and copy.

**Tech Stack:** Next.js App Router, React, Dexie/IndexedDB, Vitest, Playwright, TypeScript, pnpm.

## Global Constraints

- Preserve all unrelated Spiral/revisit behavior and explanatory comments from `AGENTS.md`.
- Do not expand `StageListItem` with featured-demo metadata.
- A failed import must keep the featured card available for retry.
- The card must stay absent after a page reload when the current demo revision exists.
- Opening the imported classroom happens from “最近学习”, not automatically after import.

---

### Task 1: Remove the obsolete empty-home generation guidance

**Files:**
- Modify: `lib/revisit/home-surface.ts`
- Modify: `tests/revisit/home-surface.test.ts`
- Modify: `app/page.tsx`
- Modify: `e2e/tests/home-to-generation.spec.ts`
- Modify: `lib/i18n/locales/ar-SA.json`
- Modify: `lib/i18n/locales/en-US.json`
- Modify: `lib/i18n/locales/ja-JP.json`
- Modify: `lib/i18n/locales/ko-KR.json`
- Modify: `lib/i18n/locales/pt-BR.json`
- Modify: `lib/i18n/locales/ru-RU.json`
- Modify: `lib/i18n/locales/zh-CN.json`
- Modify: `lib/i18n/locales/zh-TW.json`

**Interfaces:**
- Consumes: `resolveHomeSurfaceState({ reverseChallengeEnabled })`.
- Produces: `HomeSurfaceState` with only `showPromptComposer` and `showSpiralLogo`.

- [ ] **Step 1: Write the failing state test**

Change the home-surface expectations so the result has no `showEmptyCoursePrompt`, and call the resolver with only `reverseChallengeEnabled`:

```ts
expect(resolveHomeSurfaceState({ reverseChallengeEnabled: true })).toEqual({
  showPromptComposer: false,
  showSpiralLogo: true,
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/revisit/home-surface.test.ts`

Expected: FAIL because the implementation still returns `showEmptyCoursePrompt` and requires the removed arguments.

- [ ] **Step 3: Remove the dedicated state and UI**

Return only the two stable mode properties:

```ts
export function resolveHomeSurfaceState(args: {
  reverseChallengeEnabled: boolean;
}): HomeSurfaceState {
  return {
    showPromptComposer: !args.reverseChallengeEnabled,
    showSpiralLogo: args.reverseChallengeEnabled,
  };
}
```

Delete `handleGenerateFirstCourse`, the `showEmptyCoursePrompt` JSX block, the corresponding E2E case, and both locale keys from all eight locales. Keep `classroomsLoaded` only if Task 2 uses it to prevent a transient demo-card flash.

- [ ] **Step 4: Verify GREEN and i18n consistency**

Run: `pnpm vitest run tests/revisit/home-surface.test.ts && pnpm check:i18n-keys`

Expected: PASS with no missing or extra locale keys.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx lib/revisit/home-surface.ts tests/revisit/home-surface.test.ts e2e/tests/home-to-generation.spec.ts lib/i18n/locales
git commit -m "revert: remove empty home generation prompt"
```

### Task 2: Hide the featured card from persisted course state

**Files:**
- Modify: `app/page.tsx`
- Modify: `e2e/tests/featured-demo-course.spec.ts`

**Interfaces:**
- Consumes: `findFeaturedDemoStage(): Promise<StageRecord | undefined>` and `openFeaturedDemoCourse(...): Promise<string>` from `lib/demo/featured-course.ts`.
- Produces: home-local `featuredDemoPresent: boolean | null`, where `null` means presence is still loading.

- [ ] **Step 1: Write the failing browser behavior**

Update the E2E scenario to assert the import stays on `/`, hides the featured region, expands recent learning, and remains hidden after reload:

```ts
await demo.getByRole('button', { name: '打开演示课程：厚壁菌门与肥胖' }).click();
await expect(page).toHaveURL(/\/$/);
await expect(page.getByRole('region', { name: '演示课程' })).toHaveCount(0);
await expect(page.getByText('最近学习')).toBeVisible();
await expect(page.getByText('厚壁菌门与肥胖')).toBeVisible();
await page.reload();
await expect(page.getByRole('region', { name: '演示课程' })).toHaveCount(0);
```

- [ ] **Step 2: Run the E2E and verify RED**

Run: `pnpm exec playwright test e2e/tests/featured-demo-course.spec.ts --project=chromium`

Expected: FAIL because the current handler navigates to `/classroom/:id` and always renders the card.

- [ ] **Step 3: Implement persisted presence and stay-home import**

Import `findFeaturedDemoStage`, initialize presence as `null`, and load it alongside classroom hydration. After a successful import, refresh classrooms, set presence to `true`, expand recent courses, and do not call `router.push`:

```ts
const [featuredDemoPresent, setFeaturedDemoPresent] = useState<boolean | null>(null);

useEffect(() => {
  let cancelled = false;
  void findFeaturedDemoStage()
    .then((stage) => {
      if (!cancelled) setFeaturedDemoPresent(Boolean(stage));
    })
    .catch((err) => {
      log.error('Failed to resolve featured demo course:', err);
      if (!cancelled) setFeaturedDemoPresent(false);
    });
  return () => {
    cancelled = true;
  };
}, []);

await openFeaturedDemoCourse({ onPhase: setFeaturedDemoPhase });
await loadClassrooms();
setFeaturedDemoPresent(true);
persistRecentOpen(true);
```

Render `<FeaturedDemoCourseCard>` only when `featuredDemoPresent === false`. Leave it visible when import throws.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec playwright test e2e/tests/featured-demo-course.spec.ts --project=chromium`

Expected: PASS; one featured stage exists, the home URL is unchanged, and reload keeps the card absent.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx e2e/tests/featured-demo-course.spec.ts
git commit -m "fix: dismiss imported demo course card"
```

### Task 3: Regression and production verification

**Files:**
- Verify all files changed in Tasks 1–2.

**Interfaces:**
- Consumes: the completed home-state behavior.
- Produces: verified production-ready main branch.

- [ ] **Step 1: Run focused unit and E2E coverage**

Run: `pnpm vitest run tests/demo/featured-course.test.ts tests/revisit/home-surface.test.ts && pnpm exec playwright test e2e/tests/featured-demo-course.spec.ts e2e/tests/home-to-generation.spec.ts --project=chromium`

Expected: PASS.

- [ ] **Step 2: Run static verification**

Run: `pnpm check:i18n-keys && pnpm exec tsc --noEmit && pnpm build`

Expected: PASS with a successful Next.js production build.

- [ ] **Step 3: Inspect the final diff and repository state**

Run: `git diff origin/main...HEAD --check && git status --short --branch`

Expected: no whitespace errors and only the intentional commits ahead of `origin/main`.

- [ ] **Step 4: Push and verify production**

Run: `git push origin main`, wait for Vercel READY, then verify `https://spiral-maic.vercel.app/` in a fresh browser context and after importing/reloading.

Expected: production exhibits the same one-time card behavior.
