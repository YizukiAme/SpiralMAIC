import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

async function freshStore(persistedState?: Record<string, unknown>) {
  vi.resetModules();
  storage.clear();
  if (persistedState) {
    storage.set('settings-storage', JSON.stringify({ state: persistedState, version: 4 }));
  }
  const { useSettingsStore } = await import('@/lib/store/settings');
  return useSettingsStore;
}

describe('SpiralMAIC revisit settings', () => {
  beforeEach(() => storage.clear());

  it('defaults Spiral mode off with the real clock active', async () => {
    const store = await freshStore();
    expect(store.getState()).toMatchObject({
      reverseChallengeEnabled: false,
      stableSuccessesRequired: 2,
      activeRevisitDemoSessionByStage: {},
      revisitVirtualClockOffsetHoursByStage: {},
      demoGateSkipEnabled: false,
    });
  });

  it('clamps and persists independent per-course revisit setting changes', async () => {
    const store = await freshStore();
    const state = store.getState();

    state.setReverseChallengeEnabled(false);
    state.setStableSuccessesRequired(0);
    state.setActiveRevisitDemoSession('stage-1', 'demo-1');
    state.setRevisitVirtualClockOffsetHours('stage-1', 200);
    state.setActiveRevisitDemoSession('stage-2', 'demo-2');
    state.setRevisitVirtualClockOffsetHours('stage-2', 6);
    state.setDemoGateSkipEnabled(true);

    expect(store.getState()).toMatchObject({
      reverseChallengeEnabled: false,
      stableSuccessesRequired: 1,
      activeRevisitDemoSessionByStage: {
        'stage-1': 'demo-1',
        'stage-2': 'demo-2',
      },
      revisitVirtualClockOffsetHoursByStage: {
        'stage-1': 168,
        'stage-2': 6,
      },
      demoGateSkipEnabled: true,
    });

    const persisted = JSON.parse(storage.get('settings-storage')!);
    expect(persisted.state).toMatchObject({
      reverseChallengeEnabled: false,
      stableSuccessesRequired: 1,
      activeRevisitDemoSessionByStage: {
        'stage-1': 'demo-1',
        'stage-2': 'demo-2',
      },
      revisitVirtualClockOffsetHoursByStage: {
        'stage-1': 168,
        'stage-2': 6,
      },
      demoGateSkipEnabled: true,
    });
  });

  it('drops retired global clock and forgetting controls during settings migration', async () => {
    const store = await freshStore({
      forgettingSpeedMultiplier: 60,
      demoAcceleratedClockEnabled: true,
      activeRevisitDemoSessionId: 'legacy-demo',
      revisitVirtualClockOffsetHours: 72,
    });

    expect(store.getState()).not.toHaveProperty('forgettingSpeedMultiplier');
    expect(store.getState()).not.toHaveProperty('demoAcceleratedClockEnabled');
    expect(store.getState()).not.toHaveProperty('activeRevisitDemoSessionId');
    expect(store.getState()).not.toHaveProperty('revisitVirtualClockOffsetHours');
    expect(store.getState()).toMatchObject({
      activeRevisitDemoSessionByStage: {},
      revisitVirtualClockOffsetHoursByStage: {},
    });
  });

  it('hydrates missing fields from defaults for older settings blobs', async () => {
    const store = await freshStore({ ttsSpeed: 1.25 });
    expect(store.getState().ttsSpeed).toBe(1.25);
    expect(store.getState().reverseChallengeEnabled).toBe(false);
    expect(store.getState().stableSuccessesRequired).toBe(2);
  });
});
