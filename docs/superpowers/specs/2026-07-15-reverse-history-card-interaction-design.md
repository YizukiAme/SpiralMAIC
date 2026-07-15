# Reverse History Card Interaction Design

## Goal

Remove the conflicting pointer semantics from Reverse history cards inside the
Spiral panel. A single click selects a Reverse and updates the report on the
right; a double click opens that Reverse's existing destination.

The homepage classroom cards are out of scope. With Spiral enabled, their
single-click behavior remains opening the Spiral panel.

## Interaction

- Pointer single click calls only the card selection behavior.
- Pointer double click selects the card and, when enabled, runs its existing
  `prepare`, `enter`, or `replay` action.
- Focusing a card continues to select its report.
- Enter remains the keyboard equivalent of opening the selected Reverse.
- Space selects the card without opening it.
- Disabled actions must not run from double click or Enter, while selecting the
  card remains available so its report can still be inspected.

Native click and double-click events are used without a delay timer. During a
double click, the intervening click events may select the card before the
double-click action runs; this is the intended sequence.

## Ordering

Reverse history remains sorted by descending `sequence`. `sequence` is assigned
once when a Reverse is generated and is not changed by selection, entry,
completion, or replay. No click-time or `updatedAt` sorting is introduced.

## Implementation Boundary

- Update the interaction policy in `lib/revisit/history.ts` so click and
  double-click semantics are explicit.
- Update `ReverseHistoryCard` in `components/revisit/review-panel.tsx` to wire
  single click, double click, Enter, and Space to those semantics.
- Do not modify the homepage `ClassroomCard` in `app/page.tsx`.
- Preserve the existing `md:flex-row!` override and its explanatory comment in
  the review panel.

## Tests

- Policy tests verify that an actionable Reverse uses single click for
  selection and double click for its existing action.
- Surface tests verify the panel card wires `onDoubleClick` and keeps single
  click selection-only.
- Ordering tests verify descending `sequence` remains stable even when an older
  Reverse has a newer `updatedAt`.
- Focused Reverse tests and type checking must pass after the change.
