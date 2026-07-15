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

describe('Codex fast mode preference', () => {
  beforeEach(() => storage.clear());

  it('defaults to off', async () => {
    const store = await freshStore();

    expect(store.getState().codexFastMode).toBe(false);
  });

  it('persists the user selection', async () => {
    const store = await freshStore();

    store.getState().setCodexFastMode(true);

    expect(store.getState().codexFastMode).toBe(true);
    expect(JSON.parse(storage.get('settings-storage')!).state.codexFastMode).toBe(true);
  });

  it('hydrates an older settings blob with the default off', async () => {
    const store = await freshStore({ ttsSpeed: 1.25 });

    expect(store.getState().codexFastMode).toBe(false);
  });
});
