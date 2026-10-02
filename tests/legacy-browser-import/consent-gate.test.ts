import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLegacyImportConsentState,
  runApprovedLegacyBrowserImport,
} from '@/lib/legacy-browser-import';
import { approveLegacyImport } from '@/lib/legacy-browser-import/consent';
import { ensureLedger } from '@/lib/legacy-browser-import/ledger';

import { seedLatestBrowser } from './fixtures';
import {
  FakeServer,
  MemoryStorage,
  OWNER_A,
  OWNER_B,
  configureSeams,
  freshBrowser,
} from './harness';

let storage: MemoryStorage;
let server: FakeServer;
let teardown: () => Promise<void>;

beforeEach(async () => {
  await freshBrowser();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
  server = new FakeServer();
  teardown = await configureSeams(server);
});

afterEach(async () => {
  await teardown();
  vi.unstubAllGlobals();
});

describe('legacy browser import approval gate', () => {
  it('detects old data without contacting the import server', async () => {
    await seedLatestBrowser(storage);
    const connect = vi.fn(server.options(storage).connect);

    const state = await getLegacyImportConsentState({
      storage,
      ownerId: async () => OWNER_A,
    });
    const outcome = await runApprovedLegacyBrowserImport({
      ...server.options(storage),
      ownerId: async () => OWNER_A,
      connect,
    });

    expect(state.status).toBe('awaiting-consent');
    expect(outcome.status).toBe('awaiting-consent');
    expect(state.browserId).toMatch(/^[0-9a-f]{32}$/);
    expect(connect).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
  });

  it('starts after approval and resumes for the same owner and browser', async () => {
    await seedLatestBrowser(storage);
    const { browserId } = ensureLedger(storage);
    approveLegacyImport(storage, OWNER_A, browserId);

    const outcome = await runApprovedLegacyBrowserImport({
      ...server.options(storage),
      ownerId: async () => OWNER_A,
    });

    expect(outcome.status).toBe('complete');
    expect(server.calls.length).toBeGreaterThan(0);
    expect(
      await getLegacyImportConsentState({ storage, ownerId: async () => OWNER_A }),
    ).toMatchObject({ status: 'complete' });
  });

  it('does not reuse approval after the owner changes', async () => {
    await seedLatestBrowser(storage);
    approveLegacyImport(storage, OWNER_A, ensureLedger(storage).browserId);
    const connect = vi.fn(server.options(storage).connect);

    const outcome = await runApprovedLegacyBrowserImport({
      ...server.options(storage),
      ownerId: async () => OWNER_B,
      connect,
    });

    expect(outcome.status).toBe('awaiting-consent');
    expect(connect).not.toHaveBeenCalled();
  });
});
