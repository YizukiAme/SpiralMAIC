# Featured Demo Course Design

**Date:** 2026-07-15
**Status:** Approved for planning

## Goal

Every visitor to the SpiralMAIC home page can see a featured card labeled
“演示课程：厚壁菌门与肥胖”. Selecting the card loads the bundled classroom on
first use and opens it. Later selections open the browser-local copy directly.
The visitor never needs to understand or use the classroom ZIP importer.

## Current Constraints

- The supplied `厚壁菌门与肥胖.maic.zip` is a valid format-version-1 classroom
  export with 12 scenes, 4 generated images, and 66 WAV audio files.
- The ZIP is about 75 MB because its WAV files are effectively uncompressed.
- SpiralMAIC stores classrooms and media in each visitor's IndexedDB. A Vercel
  deployment therefore cannot populate one shared course row for all visitors.
- The existing importer is coupled to a file-input change event and generates a
  fresh stage ID on every import.
- Existing user classrooms, playback progress, and revisit data must remain
  untouched.

## User Experience

The home page has a dedicated featured-demo section that is visible whether or
not the visitor already has local classrooms. It contains one card:

- Badge: `演示课程`
- Title: `厚壁菌门与肥胖`
- Action: clicking anywhere on the card opens the course
- First use: the card enters a loading state while the artifact is downloaded,
  validated, and written locally
- Later use: the card opens the existing local stage without downloading or
  importing again
- Failure: the card returns to its normal state and offers a retry; an error
  message explains whether loading, validation, or browser storage failed

The featured card is not counted as a recent classroom before it is imported.
After import, its underlying stage may participate in normal course features,
but the featured card remains the stable entry point. The normal ZIP upload
entry and all user-created classroom cards keep their current behavior.

## Architecture

### 1. Demo course descriptor

A client-safe descriptor defines the stable demo identity, display strings,
revision, cover asset, and artifact URL. The identity is independent of the
generated IndexedDB stage ID.

The descriptor is intentionally static and contains no server-only imports.
The initial revision is immutable; publishing changed course content requires a
new explicit revision.

### 2. Optimized static artifact

Prepare a deployment artifact from the supplied classroom ZIP before it is
committed:

- Preserve `manifest.json`, scene content, images, agents, and teaching order.
- Transcode WAV narration to mono MP3 at 64 kbps while preserving each clip's
  duration. MP3 is used for broad browser support and speech-focused size.
- Rewrite manifest media paths, formats, sizes, and all matching scene audio
  references consistently.
- Validate the rebuilt ZIP through the same importer used by the application.
- Store the finished artifact and a lightweight cover image under `public/demo/`.

Vercel serves the artifact as a static asset. It is downloaded only after the
visitor selects the featured card, avoiding a large transfer during ordinary
home-page loading. The final artifact size must be recorded during verification
and kept comfortably below Vercel's deployment limits.

### 3. Reusable classroom import service

Extract the event-independent work from `useImportClassroom` into a client-safe
import service. The service accepts a `Blob` or `File`, optional import metadata,
and a phase callback, then returns the new stage ID.

Both entry points use this service:

- The existing file picker adapts its selected `File` to the service and keeps
  its current translated toasts.
- The demo loader fetches the static artifact, passes it to the same service,
  and uses the returned stage ID for navigation.

This prevents the featured path from becoming a second, subtly different ZIP
parser. The service retains the current media-reference rewriting and import
validation rules.

### 4. Stable identity and duplicate prevention

Stage records gain two optional, non-indexed provenance fields named
`featuredDemoId` and `featuredDemoRevision`. No IndexedDB schema migration is
required for optional non-indexed properties.

Before downloading, the demo loader searches for a stage whose provenance
matches the descriptor identity and revision:

- Match found: open that stage immediately.
- No match: download and import the artifact once, tagging the new stage with
  the descriptor identity and revision.
- Stale provenance pointing to a deleted stage: import normally.
- A failed or interrupted import must not leave a tagged stage that appears
  usable. The stage is tagged only as part of the successful course write.
- If a write fails after creating media records, the import service performs
  best-effort cleanup of only the IDs created by that import before surfacing
  the error.

The design does not identify the demo by title because users can rename normal
classrooms and can independently import another copy of the same ZIP.

### 5. Home-page integration

A focused demo-card component owns presentation and loading/error interaction.
The home page owns navigation and refreshes its local classroom list after a
successful import. The demo card is rendered separately from the existing
recent-classroom grid so search, counts, rename, and delete semantics do not
need special cases.

The card displays a static cover before import. This avoids downloading or
opening IndexedDB media merely to render the home page.

## Data Flow

1. Home page renders the descriptor and static cover without fetching the ZIP.
2. Visitor selects the demo card.
3. Loader checks IndexedDB for matching demo provenance.
4. If found, navigate to `/classroom/{stageId}`.
5. Otherwise fetch the static ZIP, reporting download/import state on the card.
6. Shared import service validates and writes media, agents, stage, and scenes.
7. Home page refreshes its classroom list and navigates to the returned stage.
8. Future selections resolve the tagged local stage and skip the network.

## Error Handling and Storage

- Network, invalid-artifact, and `QuotaExceededError` outcomes remain distinct
  so the UI can give useful recovery guidance.
- The loading action is guarded against double-clicks.
- A failed import is retryable and must not remove or modify unrelated stages.
- Browser storage remains the source of truth for the imported copy. Clearing
  site data removes it; selecting the featured card imports it again.
- The page does not automatically download the artifact, preserving bandwidth
  and reducing the risk of storage eviction on a casual visit.

## Testing and Verification

- Unit-test demo-stage resolution: first import, existing match, deleted stage,
  and independently imported same-title classroom.
- Unit-test the extracted import service and verify the existing file-picker
  path still reports phases and invokes its success callback.
- Validate the optimized artifact's manifest references and ensure every listed
  media file exists in the ZIP.
- Run focused TypeScript, lint, and import-related tests.
- Run a production build with the artifact present.
- In a clean browser profile against the production-like build, verify the card
  is visible, first click loads and opens the classroom, narration and images
  work, returning home keeps the card visible, and the second click opens
  without importing a duplicate.
- Repeat with existing local classrooms to confirm recent-course behavior is
  unchanged.

## Non-goals

- No shared server-side classroom database.
- No automatic 75 MB download on page load.
- No redesign of the recent-classroom grid.
- No changes to lesson completion, memory, Reverse Challenge, or Study Studio
  semantics.
- No generalized remote course catalog; this design supports one intentional
  featured demo artifact.
