# Featured Demo Card Ratio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the desktop featured-demo media ratio so the 16:9 cover is not visibly cropped.

**Architecture:** Keep the existing card component and responsive layout. Measure the existing image wrapper in Playwright and raise only the desktop minimum height from 176px to 192px.

**Tech Stack:** React, Next.js Image, Tailwind CSS, Playwright, TypeScript, pnpm.

## Global Constraints

- Preserve the mobile `aspect-[16/9]` behavior.
- Preserve all copy, loading/error states, accessibility labels, import behavior, and one-time dismissal behavior.
- Keep `object-cover` and the left-image/right-copy desktop layout.
- Keep the full card inside the initial 720px E2E viewport.

---

### Task 1: Correct the desktop cover ratio

**Files:**
- Modify: `components/demo/featured-demo-course-card.tsx`
- Modify: `e2e/tests/featured-demo-course.spec.ts`

**Interfaces:**
- Consumes: the existing `FeaturedDemoCourseCard` props and cover image.
- Produces: a desktop media-container minimum height of 192px.

- [ ] **Step 1: Write the failing rendered-ratio assertion**

Add this before importing the course in the existing success E2E case:

```ts
const coverBounds = await demo.locator('img').first().locator('..').boundingBox();
expect(coverBounds).not.toBeNull();
expect(coverBounds!.width / coverBounds!.height).toBeGreaterThan(1.72);
expect(coverBounds!.width / coverBounds!.height).toBeLessThan(1.82);
```

- [ ] **Step 2: Run the focused E2E and verify RED**

Run: `pnpm exec playwright test e2e/tests/featured-demo-course.spec.ts --project=chromium`

Expected: FAIL because the current desktop media ratio is approximately 1.96.

- [ ] **Step 3: Apply the minimal styling correction**

Change the media wrapper from:

```tsx
<span className="relative block aspect-[16/9] min-h-44 overflow-hidden bg-emerald-50 sm:aspect-auto">
```

to:

```tsx
<span className="relative block aspect-[16/9] min-h-44 overflow-hidden bg-emerald-50 sm:aspect-auto sm:min-h-48">
```

- [ ] **Step 4: Verify GREEN and visual layout**

Run: `pnpm exec playwright test e2e/tests/featured-demo-course.spec.ts --project=chromium`

Expected: both success and download-failure cases PASS, with the card bottom still inside the viewport.

Capture desktop and mobile screenshots and confirm the title and side labels in the source cover remain visible.

- [ ] **Step 5: Run static and production checks**

Run: `pnpm exec eslint components/demo/featured-demo-course-card.tsx && pnpm exec tsc --noEmit && pnpm build`

Expected: zero lint errors, zero TypeScript errors, and a successful production build.

- [ ] **Step 6: Commit and push**

```bash
git add components/demo/featured-demo-course-card.tsx e2e/tests/featured-demo-course.spec.ts
git commit -m "fix: preserve featured demo cover ratio"
git push origin main
```
