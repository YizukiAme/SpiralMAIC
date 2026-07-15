# Featured Demo Course Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every home-page visitor a featured “演示课程：厚壁菌门与肥胖” card that lazily imports an optimized classroom artifact once and opens the browser-local copy on later clicks.

**Architecture:** Extract the current file-input importer into one client-safe service shared by manual and featured imports. Tag the imported stage with stable, non-indexed demo provenance, resolve it before fetching, and render a dedicated card outside the recent-classroom list. Build the static demo ZIP ahead of deployment by transcoding narration to 64 kbps mono MP3 and rewriting the manifest consistently.

**Tech Stack:** Next.js App Router, React, TypeScript, Dexie/IndexedDB, JSZip, Vitest, Playwright, ffmpeg, Vercel static assets.

## Global Constraints

- Keep `components/ui/tabs.tsx` and `components/revisit/review-panel.tsx` untouched; in particular do not remove `md:flex-row!` or its explanation.
- Client code must not import any module that reaches `lib/prompts`.
- Do not change lesson completion, memory, Reverse Challenge, Study Studio, or demo-clock semantics.
- The home page must not fetch the classroom ZIP until the visitor selects the featured card.
- Use the exact visible copy `演示课程` and `厚壁菌门与肥胖`.
- Transcode WAV narration to mono MP3 at 64 kbps and preserve clip duration.
- Preserve all existing user classrooms and the existing manual ZIP importer behavior.
- Do not stage or overwrite the unrelated `lib/i18n/locales/zh-CN.json` and `tests/i18n/revisit-settings-locales.test.ts` changes in the primary checkout.

---

## File Structure

- Create `lib/import/classroom-import.ts`: event-independent ZIP validation, ID rewriting, IndexedDB writes, progress phases, and rollback.
- Modify `lib/import/use-import-classroom.ts`: file-input and toast adapter over `importClassroomBlob`.
- Modify `lib/utils/database.ts`: optional `featuredDemoId` and `featuredDemoRevision` fields on `StageRecord`.
- Create `lib/demo/featured-course.ts`: immutable descriptor and IndexedDB lookup/import orchestration.
- Create `components/demo/featured-demo-course-card.tsx`: featured-card presentation and loading/error states.
- Modify `app/page.tsx`: render the card, refresh local classrooms after import, and navigate to the returned stage.
- Create `scripts/prepare-featured-demo-course.mjs`: reproducible WAV-to-MP3 repackaging and manifest rewrite.
- Modify `package.json`: add the local artifact preparation command.
- Create `public/demo/firmicutes-obesity.maic.zip`: optimized deployment artifact.
- Create `public/demo/firmicutes-obesity-cover.png`: unchanged representative image extracted from the classroom package.
- Create `tests/import/classroom-import.test.ts`: import service validation, provenance, and rollback coverage.
- Create `tests/demo/featured-course.test.ts`: stable lookup and lazy-fetch behavior.
- Create `tests/demo/featured-course-artifact.test.ts`: committed ZIP consistency and size checks.
- Create `e2e/tests/featured-demo-course.spec.ts`: clean-profile first-click and repeat-click user flow.

---

### Task 1: Extract the Reusable Classroom Import Service

**Files:**
- Create: `lib/import/classroom-import.ts`
- Modify: `lib/import/use-import-classroom.ts`
- Test: `tests/import/classroom-import.test.ts`

**Interfaces:**
- Produces: `ImportPhase`, `ClassroomImportError`, `ClassroomImportOptions`, and `importClassroomBlob(source: Blob, options?: ClassroomImportOptions): Promise<string>`.
- `ClassroomImportOptions` contains `onPhase?: (phase: ImportPhase) => void` and `provenance?: { featuredDemoId: string; featuredDemoRevision: string }`.
- Later tasks consume the returned stage ID and provenance options.

- [ ] **Step 1: Write failing validation and provenance tests**

Create `tests/import/classroom-import.test.ts` using `fake-indexeddb/auto`, a minimal JSZip manifest, and real `db` tables. The test helper must create one slide scene and no media:

```ts
import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { importClassroomBlob, ClassroomImportError } from '@/lib/import/classroom-import';
import { clearAllData, db } from '@/lib/utils/database';

async function classroomBlob(overrides: Record<string, unknown> = {}) {
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: { name: 'Demo', createdAt: 1, updatedAt: 1 },
      agents: [],
      scenes: [{ type: 'slide', title: 'One', order: 1, content: { elements: [] } }],
      mediaIndex: {},
      ...overrides,
    }),
  );
  return zip.generateAsync({ type: 'blob' });
}

afterEach(async () => clearAllData());

describe('importClassroomBlob', () => {
  it('returns the new stage id and persists featured provenance', async () => {
    const stageId = await importClassroomBlob(await classroomBlob(), {
      provenance: { featuredDemoId: 'firmicutes-obesity', featuredDemoRevision: '1' },
    });
    await expect(db.stages.get(stageId)).resolves.toMatchObject({
      id: stageId,
      name: 'Demo',
      featuredDemoId: 'firmicutes-obesity',
      featuredDemoRevision: '1',
    });
    await expect(db.scenes.where('stageId').equals(stageId).count()).resolves.toBe(1);
  });

  it('rejects a zip without manifest.json with a typed error', async () => {
    const zip = new JSZip();
    const blob = await zip.generateAsync({ type: 'blob' });
    await expect(importClassroomBlob(blob)).rejects.toMatchObject<ClassroomImportError>({
      code: 'invalid-manifest',
    });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `pnpm vitest run tests/import/classroom-import.test.ts`

Expected: FAIL because `@/lib/import/classroom-import` does not exist.

- [ ] **Step 3: Implement the event-independent import service**

Move the parsing, validation, ID generation, media writes, agent writes, and scene rewriting from `use-import-classroom.ts` into `classroom-import.ts`. Define exact public types:

```ts
export type ImportPhase =
  | 'idle'
  | 'parsing'
  | 'validating'
  | 'writingMedia'
  | 'writingCourse'
  | 'done';

export type ClassroomImportErrorCode = 'invalid-manifest' | 'missing-data';

export class ClassroomImportError extends Error {
  constructor(public readonly code: ClassroomImportErrorCode) {
    super(code);
    this.name = 'ClassroomImportError';
  }
}

export interface ClassroomImportOptions {
  onPhase?: (phase: ImportPhase) => void;
  provenance?: {
    featuredDemoId: string;
    featuredDemoRevision: string;
  };
}

export async function importClassroomBlob(
  source: Blob,
  options: ClassroomImportOptions = {},
): Promise<string>;
```

Track every generated audio ID, media ID, agent ID, scene ID, and stage ID. On failure, call `bulkDelete` only for those IDs and rethrow the original error. Write `featuredDemoId` and `featuredDemoRevision` into the stage record only when `options.provenance` exists. Emit each phase immediately before its matching work and return `newStageId` after `done`.

- [ ] **Step 4: Adapt the existing hook without changing its UI contract**

Keep `triggerFileSelect`, `fileInputRef`, `handleFileChange`, `importing`, and `phase`. Map service phases to the existing translated loading toasts. Map `ClassroomImportError('invalid-manifest')` to `import.error.invalidManifest`, `missing-data` to `import.error.missingData`, `QuotaExceededError` to `import.error.storageFull`, and all other failures to `import.error.invalidZip`. Call `onSuccess` only after the service resolves.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```bash
pnpm vitest run tests/import/classroom-import.test.ts tests/export/classroom-zip.test.ts
pnpm exec prettier --check lib/import/classroom-import.ts lib/import/use-import-classroom.ts tests/import/classroom-import.test.ts
pnpm exec eslint lib/import/classroom-import.ts lib/import/use-import-classroom.ts tests/import/classroom-import.test.ts
```

Expected: all tests pass, Prettier reports all matched files formatted, and ESLint exits 0.

- [ ] **Step 6: Commit the import-service slice**

```bash
git add lib/import/classroom-import.ts lib/import/use-import-classroom.ts tests/import/classroom-import.test.ts
git commit -m "refactor: share classroom import service"
```

---

### Task 2: Add Stable Featured-Course Resolution

**Files:**
- Modify: `lib/utils/database.ts`
- Create: `lib/demo/featured-course.ts`
- Test: `tests/demo/featured-course.test.ts`

**Interfaces:**
- Consumes: `importClassroomBlob` from Task 1.
- Produces: `FEATURED_DEMO_COURSE`, `findFeaturedDemoStage()`, and `openFeaturedDemoCourse(options): Promise<string>`.
- `openFeaturedDemoCourse` consumes `fetcher?: typeof fetch` and `onPhase?: (phase: FeaturedDemoPhase) => void` for deterministic testing.

- [ ] **Step 1: Write failing lookup and lazy-fetch tests**

Create tests that insert a same-title normal stage and verify it is ignored, insert a provenance-matching stage and verify `fetcher` is not called, and exercise a missing stage with a mocked artifact response:

```ts
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllData, db } from '@/lib/utils/database';
import {
  FEATURED_DEMO_COURSE,
  findFeaturedDemoStage,
  openFeaturedDemoCourse,
} from '@/lib/demo/featured-course';

afterEach(async () => clearAllData());

describe('featured demo course', () => {
  it('does not identify a normal classroom by title', async () => {
    await db.stages.put({
      id: 'normal',
      name: '厚壁菌门与肥胖',
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(findFeaturedDemoStage()).resolves.toBeUndefined();
  });

  it('opens the tagged local copy without fetching', async () => {
    await db.stages.put({
      id: 'demo',
      name: '厚壁菌门与肥胖',
      createdAt: 1,
      updatedAt: 1,
      featuredDemoId: FEATURED_DEMO_COURSE.id,
      featuredDemoRevision: FEATURED_DEMO_COURSE.revision,
    });
    const fetcher = vi.fn<typeof fetch>();
    await expect(openFeaturedDemoCourse({ fetcher })).resolves.toBe('demo');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
```

Mock `importClassroomBlob` in the missing-stage test and assert that the fetch URL, provenance, and returned stage ID match the descriptor.

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `pnpm vitest run tests/demo/featured-course.test.ts`

Expected: FAIL because the featured-course module and StageRecord fields do not exist.

- [ ] **Step 3: Add optional non-indexed StageRecord fields**

Add without changing `_DATABASE_VERSION` or Dexie store indexes:

```ts
featuredDemoId?: string;
featuredDemoRevision?: string;
```

- [ ] **Step 4: Implement the immutable descriptor and resolver**

Use these exact descriptor values:

```ts
export const FEATURED_DEMO_COURSE = {
  id: 'firmicutes-obesity',
  revision: '1',
  badge: '演示课程',
  title: '厚壁菌门与肥胖',
  artifactUrl: '/demo/firmicutes-obesity.maic.zip',
  coverUrl: '/demo/firmicutes-obesity-cover.png',
} as const;
```

`findFeaturedDemoStage` filters `db.stages` by both provenance fields. `openFeaturedDemoCourse` first returns a matching stage ID. Otherwise it emits `downloading`, calls the supplied fetcher, throws `FeaturedDemoCourseError('download-failed')` for a non-OK response, converts the response to a Blob, emits import phases from `importClassroomBlob`, passes descriptor provenance, and returns the imported ID. Keep a module-level in-flight promise so double clicks share one operation; clear it in `finally`.

- [ ] **Step 5: Run focused tests and checks**

Run:

```bash
pnpm vitest run tests/demo/featured-course.test.ts tests/import/classroom-import.test.ts
pnpm exec prettier --check lib/demo/featured-course.ts lib/utils/database.ts tests/demo/featured-course.test.ts
pnpm exec eslint lib/demo/featured-course.ts lib/utils/database.ts tests/demo/featured-course.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit stable featured identity**

```bash
git add lib/utils/database.ts lib/demo/featured-course.ts tests/demo/featured-course.test.ts
git commit -m "feat: resolve featured demo course locally"
```

---

### Task 3: Build and Validate the Optimized Classroom Artifact

**Files:**
- Create: `scripts/prepare-featured-demo-course.mjs`
- Modify: `package.json`
- Create: `public/demo/firmicutes-obesity.maic.zip`
- Create: `public/demo/firmicutes-obesity-cover.png`
- Create: `tests/demo/featured-course-artifact.test.ts`

**Interfaces:**
- Consumes: `/Users/yizuki/Downloads/厚壁菌门与肥胖.maic.zip` as the one-time source artifact.
- Produces: the exact public URLs in `FEATURED_DEMO_COURSE`.

- [ ] **Step 1: Write a failing committed-artifact validation test**

The test loads `public/demo/firmicutes-obesity.maic.zip` with JSZip and asserts:

```ts
const artifact = resolve(process.cwd(), 'public/demo/firmicutes-obesity.maic.zip');
expect(statSync(artifact).size).toBeLessThan(20 * 1024 * 1024);
const zip = await JSZip.loadAsync(readFileSync(artifact));
const manifest = JSON.parse(await zip.file('manifest.json')!.async('text')) as ClassroomManifest;
expect(manifest.stage.name).toBe('厚壁菌门与肥胖');
expect(manifest.scenes).toHaveLength(12);
const audioEntries = Object.entries(manifest.mediaIndex).filter(([, item]) => item.type === 'audio');
expect(audioEntries).toHaveLength(66);
for (const [path, item] of Object.entries(manifest.mediaIndex)) {
  expect(zip.file(path), path).not.toBeNull();
  if (item.type === 'audio') {
    expect(path.endsWith('.mp3')).toBe(true);
    expect(item.format).toBe('mp3');
    expect(item.mimeType).toBe('audio/mpeg');
  }
}
```

Also recursively collect every `audioRef` in all scene actions and assert that each exists in `manifest.mediaIndex`.

- [ ] **Step 2: Run the test and confirm the missing-artifact failure**

Run: `pnpm vitest run tests/demo/featured-course-artifact.test.ts`

Expected: FAIL with `ENOENT` for the public ZIP.

- [ ] **Step 3: Implement the preparation script**

The script accepts input ZIP, output ZIP, and cover output paths. It must:

1. load JSZip and parse `manifest.json`;
2. create a temporary directory with `mkdtemp`;
3. for every non-missing audio entry, write the WAV, run
   `ffmpeg -y -i input.wav -ac 1 -b:a 64k output.mp3`, and add the MP3;
4. replace the media-index key and update `format`, `mimeType`, and `size`;
5. recursively replace exact old `audioRef` string values in scenes;
6. copy non-audio ZIP entries unchanged;
7. copy the first generated/image media entry unchanged to the cover output;
8. assert all manifest media keys exist, then generate the output ZIP;
9. remove the temporary directory in `finally`.

Add this package script:

```json
"prepare:featured-demo": "node scripts/prepare-featured-demo-course.mjs"
```

- [ ] **Step 4: Generate the artifact from the supplied course**

Run:

```bash
pnpm prepare:featured-demo -- \
  /Users/yizuki/Downloads/厚壁菌门与肥胖.maic.zip \
  public/demo/firmicutes-obesity.maic.zip \
  public/demo/firmicutes-obesity-cover.png
```

Expected: script reports 66 transcoded audio files, 12 scenes, and an output smaller than 20 MB.

- [ ] **Step 5: Validate artifact structure and formatting**

Run:

```bash
pnpm vitest run tests/demo/featured-course-artifact.test.ts
pnpm exec prettier --check scripts/prepare-featured-demo-course.mjs tests/demo/featured-course-artifact.test.ts package.json
zipinfo -t public/demo/firmicutes-obesity.maic.zip
du -h public/demo/firmicutes-obesity.maic.zip public/demo/firmicutes-obesity-cover.png
```

Expected: test passes, Prettier exits 0, ZIP reports no errors, and the ZIP is below 20 MB.

- [ ] **Step 6: Commit the deployment artifact**

```bash
git add package.json scripts/prepare-featured-demo-course.mjs tests/demo/featured-course-artifact.test.ts public/demo/firmicutes-obesity.maic.zip public/demo/firmicutes-obesity-cover.png
git commit -m "feat: bundle optimized featured classroom"
```

---

### Task 4: Render and Open the Featured Demo Card

**Files:**
- Create: `components/demo/featured-demo-course-card.tsx`
- Modify: `app/page.tsx`
- Test: `e2e/tests/featured-demo-course.spec.ts`

**Interfaces:**
- Consumes: `FEATURED_DEMO_COURSE` and `openFeaturedDemoCourse` from Task 2.
- Produces: `FeaturedDemoCourseCard({ course, phase, error, onOpen })`.

- [ ] **Step 1: Write the failing browser flow**

Add an E2E test that starts with clean IndexedDB, visits `/`, locates a region named `演示课程`, and clicks the `厚壁菌门与肥胖` card. Assert navigation matches `/classroom/<id>`. Return home, click again, and use `page.evaluate` to assert only one stage has `featuredDemoId === 'firmicutes-obesity'`.

Use accessible names rather than CSS selectors:

```ts
const demo = page.getByRole('region', { name: '演示课程' });
await expect(demo.getByRole('heading', { name: '厚壁菌门与肥胖' })).toBeVisible();
await demo.getByRole('button', { name: /打开演示课程：厚壁菌门与肥胖/ }).click();
await expect(page).toHaveURL(/\/classroom\/[^/]+$/);
```

- [ ] **Step 2: Run the E2E test and confirm the red state**

Run: `pnpm playwright test e2e/tests/featured-demo-course.spec.ts --workers=1`

Expected: FAIL because the region and card do not exist.

- [ ] **Step 3: Implement the focused card component**

The component renders a `<section aria-label="演示课程">`, an image using the static cover, the exact badge and title, and one full-card button whose accessible name is `打开演示课程：厚壁菌门与肥胖`. Disable the button while loading. Map phases to visible text:

- `downloading` → `正在下载演示课程…`
- `parsing` or `validating` → `正在准备演示课程…`
- `writingMedia` or `writingCourse` → `正在保存到浏览器…`
- error → `加载失败，点击重试`

Use the existing slate/white card visual language and dark-mode classes. Do not reuse `ClassroomCard`, because rename/delete/recent-memory actions do not apply to a not-yet-imported featured entry.

- [ ] **Step 4: Wire the home-page action**

Add local `featuredDemoPhase` and `featuredDemoError` state. Implement:

```ts
const handleOpenFeaturedDemo = useCallback(async () => {
  setFeaturedDemoError(null);
  try {
    const stageId = await openFeaturedDemoCourse({ onPhase: setFeaturedDemoPhase });
    await loadClassrooms();
    router.push(`/classroom/${stageId}`);
  } catch (error) {
    log.error('Failed to open featured demo course:', error);
    setFeaturedDemoError('加载失败，点击重试');
  } finally {
    setFeaturedDemoPhase('idle');
  }
}, [loadClassrooms, router]);
```

Render the card after the prompt composer and before the recent-classroom block so it remains visible with zero or many local classrooms. The action always opens normal classroom playback and does not depend on Spiral mode.

- [ ] **Step 5: Run focused checks and the E2E flow**

Run:

```bash
pnpm exec prettier --check components/demo/featured-demo-course-card.tsx app/page.tsx e2e/tests/featured-demo-course.spec.ts
pnpm exec eslint components/demo/featured-demo-course-card.tsx app/page.tsx e2e/tests/featured-demo-course.spec.ts
pnpm playwright test e2e/tests/featured-demo-course.spec.ts --workers=1
```

Expected: formatting and lint exit 0; E2E passes first import and repeat-open assertions.

- [ ] **Step 6: Commit the featured-card slice**

```bash
git add components/demo/featured-demo-course-card.tsx app/page.tsx e2e/tests/featured-demo-course.spec.ts
git commit -m "feat: show featured demo course on home"
```

---

### Task 5: Full Verification and Production Readiness

**Files:**
- Modify only if verification finds a defect in files already listed above.

**Interfaces:**
- Consumes all prior tasks.
- Produces a production-ready feature with recorded test and browser evidence.

- [ ] **Step 1: Run all focused unit tests together**

Run:

```bash
pnpm vitest run \
  tests/import/classroom-import.test.ts \
  tests/demo/featured-course.test.ts \
  tests/demo/featured-course-artifact.test.ts \
  tests/export/classroom-zip.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run repository quality gates**

Run:

```bash
pnpm check
pnpm lint
pnpm check:i18n-keys
pnpm exec tsc --noEmit
pnpm build
```

Expected: every command exits 0. If unrelated primary-checkout changes are absent in the isolated worktree, do not copy or recreate them.

- [ ] **Step 3: Verify the complete browser story**

Run the production server and then the focused browser test:

```bash
pnpm start
PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3000 pnpm playwright test e2e/tests/featured-demo-course.spec.ts --workers=1
```

Manually confirm in the same clean profile that the cover renders, the course has 12 scenes, the generated images render, and at least one MP3 narration clip plays. Return home and confirm a second card click does not show the download phase.

- [ ] **Step 4: Inspect final scope and artifact size**

Run:

```bash
git status --short
git diff --check HEAD~4..HEAD
git log -5 --oneline
du -h public/demo/firmicutes-obesity.maic.zip
```

Expected: only planned files are changed, no whitespace errors exist, commits are reviewer-sized, and the artifact is below 20 MB.

- [ ] **Step 5: Commit any verification-only correction**

If verification required a correction, stage only the planned files and commit:

```bash
git add \
  app/page.tsx \
  components/demo/featured-demo-course-card.tsx \
  lib/demo/featured-course.ts \
  lib/import/classroom-import.ts \
  lib/import/use-import-classroom.ts \
  lib/utils/database.ts \
  scripts/prepare-featured-demo-course.mjs \
  tests/demo/featured-course.test.ts \
  tests/demo/featured-course-artifact.test.ts \
  tests/import/classroom-import.test.ts \
  e2e/tests/featured-demo-course.spec.ts
git commit -m "fix: harden featured demo course"
```

If no correction was needed, do not create an empty commit.
