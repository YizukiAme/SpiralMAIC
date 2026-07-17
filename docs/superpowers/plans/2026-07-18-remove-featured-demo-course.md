# Remove Featured Demo Course Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the bundled featured-demo course, runtime entry point, repository assets, and dedicated metadata without changing normal classroom import.

**Architecture:** Delete the current feature from the latest `main` tree instead of reverting historical commits across the upstream merge. Keep the shared classroom-import service, narrow its public options back to progress reporting only, and preserve already-imported browser data without migration.

**Tech Stack:** Next.js App Router, React, Dexie/IndexedDB, Vitest, Playwright, TypeScript, pnpm.

## Global Constraints

- Preserve every change from the latest OpenMAIC upstream merge.
- Preserve manual MAIC classroom import and its shared import service.
- Do not delete or migrate already-imported browser courses.
- Preserve unrelated Spiral/revisit behavior and explanatory comments from `AGENTS.md`.
- Historical documents under `docs/superpowers/` remain as decision records.

---

### Task 1: Remove the home entry point and bundled artifacts

**Files:**
- Modify: `app/page.tsx`
- Modify: `e2e/tests/home-to-generation.spec.ts`
- Delete: `e2e/tests/featured-demo-course.spec.ts`
- Delete: `components/demo/featured-demo-course-card.tsx`
- Delete: `lib/demo/featured-course.ts`
- Delete: `tests/demo/featured-course.test.ts`
- Delete: `tests/demo/featured-course-artifact.test.ts`
- Delete: `public/demo/firmicutes-obesity.maic.zip`
- Delete: `public/demo/firmicutes-obesity-cover.png`
- Delete: `scripts/prepare-featured-demo-course.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the current `HomePage` render and existing Home → Generation E2E coverage.
- Produces: a home page with no `演示课程` region and no featured-demo runtime imports.

- [ ] **Step 1: Write the failing home-page absence assertion**

Add this assertion after `home.goto()` in the core home E2E:

```ts
await expect(page.getByRole('region', { name: '演示课程' })).toHaveCount(0);
```

- [ ] **Step 2: Run the focused E2E and verify RED**

Run: `pnpm exec playwright test e2e/tests/home-to-generation.spec.ts --project=chromium --grep "home page loads"`

Expected: FAIL because the featured-demo region is currently rendered.

- [ ] **Step 3: Remove the home feature**

Delete from `app/page.tsx`:

- `FeaturedDemoCourseCard` and `lib/demo/featured-course` imports;
- the three featured-demo state values;
- `handleOpenFeaturedDemo`;
- the initial `findFeaturedDemoStage` effect;
- the conditional `<FeaturedDemoCourseCard>` render.

Delete the dedicated component, module, tests, E2E file, ZIP, cover, and preparation script. Remove this package script:

```json
"prepare:featured-demo": "node scripts/prepare-featured-demo-course.mjs",
```

- [ ] **Step 4: Verify GREEN and artifact absence**

Run:

```bash
pnpm exec playwright test e2e/tests/home-to-generation.spec.ts --project=chromium
test ! -e public/demo/firmicutes-obesity.maic.zip
test ! -e public/demo/firmicutes-obesity-cover.png
```

Expected: home E2E passes and both bundled assets are absent.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx e2e/tests package.json
git add -u components/demo lib/demo tests/demo public/demo scripts
git commit -m "revert: remove featured demo course"
```

### Task 2: Remove dedicated provenance while preserving normal import

**Files:**
- Modify: `lib/import/classroom-import.ts`
- Modify: `lib/utils/database.ts`
- Modify: `tests/import/classroom-import.test.ts`

**Interfaces:**
- Consumes: `importClassroomBlob(source, { onPhase })`.
- Produces: `ClassroomImportOptions` containing only optional `onPhase`, and ordinary `StageRecord` persistence without featured-demo fields.

- [ ] **Step 1: Update the importer contract test**

Rename the first importer test to `returns the new stage id and persists an ordinary classroom`, call the importer with only `onPhase`, and assert:

```ts
await expect(db.stages.get(stageId)).resolves.toMatchObject({
  id: stageId,
  name: 'Demo',
});
expect(await db.scenes.where('stageId').equals(stageId).count()).toBe(1);
expect(phases).toEqual(['parsing', 'validating', 'writingMedia', 'writingCourse', 'done']);
```

- [ ] **Step 2: Remove the dedicated options and fields**

Change the options interface to:

```ts
export interface ClassroomImportOptions {
  onPhase?: (phase: ImportPhase) => void;
}
```

Remove `...options.provenance` from the stage record and remove `featuredDemoId` and `featuredDemoRevision` from `StageRecord`.

- [ ] **Step 3: Verify the importer and source cleanup**

Run:

```bash
pnpm vitest run tests/import/classroom-import.test.ts
! rg -n "FeaturedDemo|featuredDemo|FEATURED_DEMO|firmicutes-obesity|prepare:featured-demo" app components lib tests e2e scripts package.json
```

Expected: all importer tests pass and the runtime/test source scan returns no matches.

- [ ] **Step 4: Commit**

```bash
git add lib/import/classroom-import.ts lib/utils/database.ts tests/import/classroom-import.test.ts
git commit -m "refactor: remove featured demo provenance"
```

### Task 3: Regression, build, and deployment verification

**Files:**
- Verify all files changed in Tasks 1–2.

**Interfaces:**
- Consumes: the feature-free home and generic classroom importer.
- Produces: a verified production deployment from `main`.

- [ ] **Step 1: Run focused verification**

Run:

```bash
pnpm vitest run tests/import/classroom-import.test.ts
pnpm exec playwright test e2e/tests/home-to-generation.spec.ts --project=chromium
pnpm check:i18n-keys
pnpm exec tsc --noEmit
```

Expected: all commands pass.

- [ ] **Step 2: Run the full suite and production build**

Run:

```bash
pnpm vitest run
pnpm build
```

Expected: zero test failures and a successful Next.js build.

- [ ] **Step 3: Inspect repository scope**

Run:

```bash
git diff origin/main...HEAD --check
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: only the removal spec, plan, feature deletion, and provenance cleanup commits are ahead of `origin/main`.

- [ ] **Step 4: Push and verify production**

Run `git push origin main`, wait for the Vercel deployment matching the new commit to become `READY`, then verify:

- `https://spiral-maic.vercel.app/` has no `演示课程` region;
- `/demo/firmicutes-obesity.maic.zip` and `/demo/firmicutes-obesity-cover.png` return 404;
- Vercel reports no new runtime errors.
