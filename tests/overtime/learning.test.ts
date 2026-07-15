import { describe, expect, it } from 'vitest';
import {
  advanceInteractiveEngagement,
  createInteractiveEngagement,
  INTERACTIVE_LEARNING_MIN_MS,
} from '@/lib/overtime/learning';

describe('overtime natural learning completion', () => {
  it('requires both a real interaction and fifteen visible seconds', () => {
    let state = createInteractiveEngagement(0, true);
    state = advanceInteractiveEngagement(state, {
      now: INTERACTIVE_LEARNING_MIN_MS,
      visible: true,
    });
    expect(state.completed).toBe(false);

    state = advanceInteractiveEngagement(state, {
      now: INTERACTIVE_LEARNING_MIN_MS,
      visible: true,
      interacted: true,
    });
    expect(state.completed).toBe(true);
  });

  it('does not count time while the tab is hidden', () => {
    let state = createInteractiveEngagement(0, true);
    state = advanceInteractiveEngagement(state, { now: 5_000, visible: false, interacted: true });
    state = advanceInteractiveEngagement(state, { now: 60_000, visible: false });
    expect(state.visibleMs).toBe(5_000);
    expect(state.completed).toBe(false);

    state = advanceInteractiveEngagement(state, { now: 60_000, visible: true });
    state = advanceInteractiveEngagement(state, { now: 70_000, visible: true });
    expect(state.visibleMs).toBe(15_000);
    expect(state.completed).toBe(true);
  });
});
