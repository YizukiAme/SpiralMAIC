// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserId = '0123456789abcdef0123456789abcdef';
const ownerId = 'anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mocks = vi.hoisted(() => ({
  models: vi.fn<() => Promise<void>>(),
  agents: vi.fn<() => Promise<void>>(),
  state: {
    status: 'awaiting-consent',
    ownerId: 'anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    browserId: '0123456789abcdef0123456789abcdef',
  } as { status: string; ownerId?: string; browserId?: string; ledger?: unknown },
}));

// This component coordinates imports; actual uploader consent is covered by
// automatic-import-consent.test.ts. Keep network work behind these boundaries.
vi.mock('@/components/model-settings-init', () => ({ importLegacyModelSettings: mocks.models }));
vi.mock('@/lib/orchestration/registry/store', () => ({ importLegacyAgents: mocks.agents }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/legacy-browser-import', () => ({
  getLegacyImportConsentState: async () => mocks.state,
  runApprovedLegacyBrowserImport: async () => {
    mocks.state = { status: 'complete', browserId };
    return { status: 'complete' };
  },
}));

import { LegacyBrowserImportNotice } from '@/components/legacy-import/notice';
import { LEGACY_IMPORT_CONSENT_KEY } from '@/lib/legacy-browser-import/consent';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  key: (index) => [...values.keys()][index] ?? null,
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => {
    values.set(key, value);
  },
  removeItem: (key) => {
    values.delete(key);
  },
  clear: () => {
    values.clear();
  },
};

beforeEach(() => {
  vi.stubGlobal('localStorage', storage);
  const requireConfirmation = async () => {
    expect(JSON.parse(localStorage.getItem(LEGACY_IMPORT_CONSENT_KEY)!)).toEqual({
      ownerId,
      browserId,
    });
  };
  mocks.models.mockReset().mockImplementation(requireConfirmation);
  mocks.agents.mockReset().mockImplementation(requireConfirmation);
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(LegacyBrowserImportNotice));
  });
  await flush();
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  values.clear();
  vi.unstubAllGlobals();
  mocks.state = { status: 'awaiting-consent', ownerId, browserId };
});

describe('legacy browser import notice', () => {
  it('waits for Start import before recording consent', async () => {
    await mount();
    expect(document.body.textContent).toContain('legacyImport.transferDescription');
    expect(localStorage.getItem(LEGACY_IMPORT_CONSENT_KEY)).toBeNull();
    expect(mocks.models).not.toHaveBeenCalled();
    expect(mocks.agents).not.toHaveBeenCalled();

    const later = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('legacyImport.later'),
    )!;
    await act(async () => {
      later.click();
    });
    expect(localStorage.getItem(LEGACY_IMPORT_CONSENT_KEY)).toBeNull();
    expect(mocks.models).not.toHaveBeenCalled();
    expect(mocks.agents).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('openmaic:legacy-import-open'));
    });
    await flush();
    const start = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('legacyImport.start'),
    )!;
    await act(async () => {
      start.click();
      await vi.waitFor(() => {
        expect(mocks.models).toHaveBeenCalledOnce();
        expect(mocks.agents).toHaveBeenCalledOnce();
      });
    });
    await flush();

    expect(JSON.parse(localStorage.getItem(LEGACY_IMPORT_CONSENT_KEY)!)).toEqual({
      ownerId,
      browserId,
    });
    expect(document.body.textContent).toContain('legacyImport.complete');
    expect(mocks.models).toHaveBeenCalledOnce();
    expect(mocks.agents).toHaveBeenCalledOnce();
  });

  it('shows failed media from a completed import when reopened from Settings', async () => {
    mocks.state = {
      status: 'complete',
      browserId,
      ledger: {
        courses: {
          course: {
            status: 'done',
            media: { clip: { status: 'failed', reason: 'Clip could not be copied' } },
          },
        },
        folders: {},
      },
    };
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event('openmaic:legacy-import-open'));
    });
    await flush();

    expect(document.body.textContent).toContain('Clip could not be copied');
  });

  it('shows an unavailable import status without requiring a Settings visit', async () => {
    mocks.state = { status: 'unavailable' };
    await mount();

    expect(document.body.textContent).toContain('legacyImport.unavailable');
  });
});
