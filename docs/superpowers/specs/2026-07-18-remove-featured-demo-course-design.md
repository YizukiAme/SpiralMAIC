# Remove Featured Demo Course Design

## Goal

Remove the bundled “厚壁菌门与肥胖” demo-course feature and its repository weight while preserving normal MAIC classroom import behavior and all changes from the latest OpenMAIC upstream merge.

## Removal Scope

- Remove the featured-demo card, loading/error state, persisted-presence lookup, and import handler from the home page.
- Delete the featured-demo React component and client module.
- Delete the bundled `.maic.zip` artifact, cover image, artifact-preparation script, and `prepare:featured-demo` package script.
- Delete featured-demo unit, artifact-integrity, and Playwright tests.
- Remove `featuredDemoId` and `featuredDemoRevision` from `StageRecord`.
- Remove the featured-demo provenance option from the shared classroom-import service and its dedicated assertions.

## Preserved Behavior

- Keep `lib/import/classroom-import.ts` as the shared implementation used by manual classroom import.
- Keep `lib/import/use-import-classroom.ts` wired to that shared service.
- Preserve normal import validation, media writes, stage writes, progress reporting, and rollback behavior.
- Preserve all current upstream code and unrelated Spiral/revisit behavior.
- Keep the historical design and implementation documents under `docs/superpowers/`; they describe past decisions but do not ship runtime behavior.

## Existing Browser Data

Do not add a destructive migration. A demo course already imported into a user's IndexedDB remains available as an ordinary recent course. The removed optional fields may remain on existing records but are ignored by the current application.

## Verification

- Add a home-page E2E assertion that no featured-demo region is rendered.
- Update the shared importer test to cover ordinary import without featured provenance.
- Run focused import and home tests, the full Vitest suite, TypeScript, i18n-key validation, and a production build.
- Confirm the packaged build no longer contains the demo ZIP or cover.
- Verify the production home page after deployment.
