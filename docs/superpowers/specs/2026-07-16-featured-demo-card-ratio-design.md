# Featured Demo Card Ratio Design

## Goal

Show the bundled 16:9 course cover without visibly clipping its title or edge labels while preserving the existing left-image/right-copy card layout.

## Design

- Keep the mobile image at its existing `aspect-[16/9]` ratio.
- Increase the desktop card and image minimum height from 176px to 192px (`sm:min-h-48`). At the card's current desktop width, this makes the left media column approximately 16:9.
- Keep `object-cover`; the corrected container ratio retains the full-bleed presentation without the letterboxing introduced by `object-contain`.
- Preserve all copy, loading/error states, accessibility labels, click behavior, one-time dismissal behavior, and recent-learning import flow.
- Keep the card within the initial 900px desktop viewport used by the existing visual check.

## Verification

- Update the featured-card component styling only.
- Render the home page at desktop and mobile viewport sizes.
- Confirm the source image title and side labels remain visible on desktop.
- Run the featured-demo E2E test, TypeScript check, and production build.
