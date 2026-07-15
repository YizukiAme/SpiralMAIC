import { describe, expect, it, vi } from 'vitest';

import { createLearningExtensionActionDispatcher } from '@/lib/overtime/action-dispatch';

const request = {
  disposition: 'append_page' as const,
  topic: '双宾语',
  teachingMove: 'extend' as const,
};

describe('createLearningExtensionActionDispatcher', () => {
  it('dispatches the first valid action immediately and ignores duplicates', () => {
    const handler = vi.fn();
    const dispatch = createLearningExtensionActionDispatcher({
      handler,
      userPrompt: '请做一页双宾语课件',
    });

    expect(dispatch(request)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(request, '请做一页双宾语课件');

    expect(dispatch({ ...request, topic: '重复的双宾语' })).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
