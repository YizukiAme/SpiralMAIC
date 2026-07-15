export const OVERTIME_LEARNING_EVENT = 'spiralmaic:overtime-learning';
export const INTERACTIVE_LEARNING_MIN_MS = 15_000;

export type OvertimeLearningSignal = 'quiz_reviewed' | 'interactive_activity' | 'pbl_completed';

export interface OvertimeLearningEventDetail {
  sceneId: string;
  signal: OvertimeLearningSignal;
}

export function emitOvertimeLearningSignal(sceneId: string, signal: OvertimeLearningSignal): void {
  if (
    typeof window === 'undefined' ||
    typeof window.dispatchEvent !== 'function' ||
    typeof CustomEvent !== 'function'
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<OvertimeLearningEventDetail>(OVERTIME_LEARNING_EVENT, {
      detail: { sceneId, signal },
    }),
  );
}

export function subscribeOvertimeLearningSignals(
  listener: (detail: OvertimeLearningEventDetail) => void,
): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function' ||
    typeof window.removeEventListener !== 'function'
  ) {
    return () => undefined;
  }
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OvertimeLearningEventDetail>).detail;
    if (!detail?.sceneId || !detail.signal) return;
    listener(detail);
  };
  window.addEventListener(OVERTIME_LEARNING_EVENT, handler);
  return () => window.removeEventListener(OVERTIME_LEARNING_EVENT, handler);
}

export interface InteractiveEngagement {
  visibleMs: number;
  visibleSince: number | null;
  interacted: boolean;
  completed: boolean;
}

export function createInteractiveEngagement(now: number, visible: boolean): InteractiveEngagement {
  return {
    visibleMs: 0,
    visibleSince: visible ? now : null,
    interacted: false,
    completed: false,
  };
}

export function advanceInteractiveEngagement(
  state: InteractiveEngagement,
  args: { now: number; visible: boolean; interacted?: boolean },
): InteractiveEngagement {
  if (state.completed) return state;
  const elapsed = state.visibleSince === null ? 0 : Math.max(0, args.now - state.visibleSince);
  const visibleMs = state.visibleMs + elapsed;
  const interacted = state.interacted || args.interacted === true;
  return {
    visibleMs,
    visibleSince: args.visible ? args.now : null,
    interacted,
    completed: interacted && visibleMs >= INTERACTIVE_LEARNING_MIN_MS,
  };
}
