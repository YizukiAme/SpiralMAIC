# Featured Demo Home-State Design

## Goal

Make the bundled “厚壁菌门与肥胖” course behave like a one-time import entry rather than a permanent promotional card. After a successful import, the home page remains visible, the demo card disappears, and the imported course appears in “最近学习”.

The bundled course also replaces the earlier empty-home instruction to generate a course, so that instruction and its supporting state are removed.

## Home-State Rules

- While the classroom list and featured-course presence are still loading, do not render the featured card.
- If no stage carries the current featured demo ID and revision, render the featured card.
- If the current featured stage already exists, do not render the featured card, including after a page reload.
- On a successful featured import:
  1. refresh the classroom list and thumbnails;
  2. mark the featured course as present so the card disappears;
  3. expand “最近学习”;
  4. remain on the home page.
- On download, parse, validation, quota, or write failure, retain the card and expose its existing retry message.
- Opening the imported course happens only when the user clicks its normal card in “最近学习”.

## Implementation Boundary

The featured-course module remains the source of truth for identifying the bundled course through `featuredDemoId` and `featuredDemoRevision`. The home page calls that existing lookup during initial loading and after import rather than expanding the general `StageListItem` shape.

Remove the empty-home generation guidance introduced by commit `c04e9c5e`:

- the “请先生成一节课程 / 去生成课程” UI;
- its home-surface state branch;
- its locale keys in every locale;
- the tests and E2E assertions dedicated to that guidance.

Do not revert unrelated changes from that commit or later work. In particular, preserve classroom loading behavior where it remains useful to avoid transient empty states.

## Verification

- Unit-test the featured-course presence behavior and home-surface cleanup.
- E2E-test that a fresh browser shows the featured card, clicking it keeps the browser on `/`, removes the card, expands “最近学习”, and shows “厚壁菌门与肥胖”.
- Reload and verify the featured card remains absent.
- Verify a failed import keeps the card available for retry.
- Run focused tests, type checking, i18n-key validation, production build, and browser verification.
