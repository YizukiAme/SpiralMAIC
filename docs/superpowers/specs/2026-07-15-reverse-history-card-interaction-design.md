# Reverse History Card Interaction Design

## Goal

Give Reverse history cards inside the Spiral panel one clear pointer action.
Hovering selects a Reverse and updates the report on the right; a single click
opens that Reverse's existing destination.

The homepage classroom cards are out of scope. With Spiral enabled, their
single-click behavior remains opening the Spiral panel.

## Interaction

- Pointer hover selects the card and updates the report.
- Pointer single click selects the card and, when enabled, runs its existing
  `prepare`, `enter`, or `replay` action.
- Pointer double click has no distinct behavior.
- Focusing a card selects its report.
- Enter and Space are keyboard equivalents of the single-click action.
- Disabled actions must not run from click, Enter, or Space, while hover and
  focus selection remain available so the report can still be inspected.

## Ordering

Reverse history remains sorted by descending `sequence`. `sequence` is assigned
once when a Reverse is generated and is not changed by selection, entry,
completion, or replay. No click-time or `updatedAt` sorting is introduced.

## Implementation Boundary

- Update the interaction policy in `lib/revisit/history.ts` so hover selection
  and click action semantics are explicit.
- Update `ReverseHistoryCard` in `components/revisit/review-panel.tsx` to wire
  hover, focus, single click, Enter, and Space to those semantics.
- Do not modify the homepage `ClassroomCard` in `app/page.tsx`.
- Preserve the existing `md:flex-row!` override and its explanatory comment in
  the review panel.

## Tests

- Policy tests verify that hover selects a Reverse and single click keeps its
  existing action.
- Surface tests verify the panel card selects on `onMouseEnter`, acts on
  `onClick`, and has no `onDoubleClick` handler.
- Ordering tests verify descending `sequence` remains stable even when an older
  Reverse has a newer `updatedAt`.
- Focused Reverse tests and type checking must pass after the change.
