import { describe, expect, it } from 'vitest';

import {
  shouldPersistStageState,
  shouldReuseStageFromMemory,
  useStageStore,
} from '@/lib/store/stage';

describe('revisit stage-store isolation', () => {
  it('never persists or reuses a transient revisit deck as the original course', () => {
    expect(shouldPersistStageState('transient-revisit')).toBe(false);
    expect(
      shouldReuseStageFromMemory(
        {
          persistenceScope: 'transient-revisit',
          stageId: 'stage-1',
          sceneCount: 2,
        },
        'stage-1',
      ),
    ).toBe(false);
  });

  it('keeps the normal OpenMAIC in-memory fast path for course decks', () => {
    expect(shouldPersistStageState('course')).toBe(true);
    expect(
      shouldReuseStageFromMemory(
        { persistenceScope: 'course', stageId: 'stage-1', sceneCount: 2 },
        'stage-1',
      ),
    ).toBe(true);
  });

  it('refuses the actual storage write while the shared store hosts a revisit deck', async () => {
    useStageStore.setState({
      persistenceScope: 'transient-revisit',
      stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 1 },
      scenes: [],
      currentSceneId: null,
      chats: [],
    });

    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(false);
    useStageStore.getState().clearStore();
  });
});
