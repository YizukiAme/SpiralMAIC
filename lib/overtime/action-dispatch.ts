import type { RequestLearningExtensionParams } from '@/lib/overtime/types';

interface LearningExtensionActionDispatcherOptions {
  handler?: (request: RequestLearningExtensionParams, userPrompt: string) => void | Promise<void>;
  userPrompt: string;
  onError?: (error: unknown) => void;
}

/** Create a per-agent-loop dispatcher that accepts only the first valid action. */
export function createLearningExtensionActionDispatcher({
  handler,
  userPrompt,
  onError,
}: LearningExtensionActionDispatcherOptions): (request: RequestLearningExtensionParams) => boolean {
  let dispatched = false;

  return (request) => {
    if (dispatched) return false;
    dispatched = true;

    try {
      void Promise.resolve(handler?.(request, userPrompt)).catch((error) => onError?.(error));
    } catch (error) {
      onError?.(error);
    }

    return true;
  };
}
