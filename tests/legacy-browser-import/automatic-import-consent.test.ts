// @vitest-environment jsdom
/** Automatic import keeps browser data local until this owner confirms it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importLegacyModelSettings } from '@/components/model-settings-init';
import {
  AGENTS_IMPORT_ENDPOINT,
  LEGACY_AGENT_REGISTRY_KEY,
} from '@/lib/legacy-browser-import/agents-import';
import { approveLegacyImport } from '@/lib/legacy-browser-import/consent';
import { ensureLedger, LEDGER_KEY } from '@/lib/legacy-browser-import/ledger';
import {
  MODEL_SETTINGS_IMPORT_ENDPOINT,
  MODEL_SETTINGS_IMPORT_KEY,
} from '@/lib/legacy-browser-import/model-settings';
import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from '@/lib/legacy-browser-import/protocol';
import { createModelSettingsClient, MODEL_SETTINGS_ENDPOINT } from '@/lib/model-settings/client';
import { BUILT_IN_AGENTS } from '@/lib/orchestration/registry/built-in';
import {
  importLegacyAgents,
  resetAgentRegistryLoadForTests,
  useAgentRegistry,
  whenAgentRegistryLoaded,
} from '@/lib/orchestration/registry/store';
import { modelSettingsViewFor } from '../helpers/model-settings-view';

const identity = vi.hoisted(() => ({ ownerId: 'owner-a' }));
// The identity endpoint is external; consent, ledger and importers stay real.
vi.mock('@/lib/persistence/bootstrap', () => ({
  getPersistenceLearnerKey: async () => identity.ownerId,
}));
vi.mock('@/lib/audio/agent-voice', () => ({ warmUpAgentVoices: vi.fn() }));

const legacyAgent = {
  id: 'browser-tutor',
  name: 'Browser tutor',
  role: 'assistant',
  persona: 'Patient.',
  avatar: '/avatars/assist.png',
  color: '#10b981',
  allowedActions: [],
  priority: 7,
};
const proposal = {
  providers: { openai: { preset: 'openai', apiKey: 'fixture-browser-key' } },
};
const serverAgent = {
  ...legacyAgent,
  id: 'server-tutor',
  name: 'Server tutor',
  isDefault: false,
  readOnly: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

let requests: { url: string; method: string; body?: unknown; headers: Headers }[];

beforeEach(() => {
  localStorage.clear();
  identity.ownerId = 'owner-a';
  resetAgentRegistryLoadForTests();
  useAgentRegistry.setState({
    agents: Object.assign(Object.create(null), BUILT_IN_AGENTS),
    customAgentsLoaded: false,
    legacyAgentsPending: [],
  });
  localStorage.setItem(
    LEGACY_AGENT_REGISTRY_KEY,
    JSON.stringify({ state: { agents: { [legacyAgent.id]: legacyAgent } }, version: 11 }),
  );
  localStorage.setItem(MODEL_SETTINGS_IMPORT_KEY, JSON.stringify(proposal));
  requests = [];
  const settingsView = modelSettingsViewFor({});
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
      headers: new Headers(init?.headers),
    });
    if (url === '/api/agents') return Response.json({ agents: [serverAgent] });
    if (url === MODEL_SETTINGS_ENDPOINT) return Response.json(settingsView);
    if (url === BINDING_ENDPOINT) return Response.json({ bound: true });
    if (url === AGENTS_IMPORT_ENDPOINT) {
      return Response.json({ imported: ['browser-tutor'], skipped: [] });
    }
    if (url === MODEL_SETTINGS_IMPORT_ENDPOINT) {
      return Response.json({
        imported: [{ kind: 'provider', id: 'openai' }],
        skipped: [],
        view: settingsView,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  resetAgentRegistryLoadForTests();
});

const writes = () => requests.filter((request) => request.method !== 'GET');

describe('automatic import consent', () => {
  it.each(['not confirmed', 'owner changed', 'browser changed'] as const)(
    'does not bind or upload when %s, while normal server reads still work',
    async (state) => {
      if (state !== 'not confirmed') {
        approveLegacyImport(localStorage, 'owner-a', ensureLedger(localStorage).browserId);
        if (state === 'owner changed') identity.ownerId = 'owner-b';
        else {
          // A different browser cannot reuse a copied confirmation record.
          localStorage.removeItem(LEDGER_KEY);
          ensureLedger(localStorage);
        }
      }
      const client = createModelSettingsClient((url, init) => fetch(url, init));

      await expect(whenAgentRegistryLoaded()).resolves.toBe(true);
      await importLegacyAgents(); // Settle the background import started by the read.
      await importLegacyModelSettings(client);
      await client.load();

      expect(writes()).toEqual([]);
      expect(useAgentRegistry.getState().getAgent('server-tutor')?.name).toBe('Server tutor');
      expect(useAgentRegistry.getState().getAgent('browser-tutor')).toBeUndefined();
      expect(client.getState().phase).toBe('ready');
      expect(requests.map((request) => request.url)).toEqual([
        '/api/agents',
        MODEL_SETTINGS_ENDPOINT,
      ]);
      expect(JSON.parse(localStorage.getItem(MODEL_SETTINGS_IMPORT_KEY)!)).toEqual(proposal);
      expect(JSON.parse(localStorage.getItem(LEGACY_AGENT_REGISTRY_KEY)!).state.agents).toEqual({
        'browser-tutor': legacyAgent,
      });
    },
  );

  it('uploads both proposals only after confirmation for the current owner and browser', async () => {
    const browserId = ensureLedger(localStorage).browserId;
    const client = createModelSettingsClient((url, init) => fetch(url, init));
    await importLegacyAgents();
    await importLegacyModelSettings(client);
    expect(writes()).toEqual([]);

    approveLegacyImport(localStorage, identity.ownerId, browserId);
    await importLegacyAgents();
    await importLegacyModelSettings(client);

    expect(writes().map((request) => request.url)).toEqual([
      BINDING_ENDPOINT,
      AGENTS_IMPORT_ENDPOINT,
      BINDING_ENDPOINT,
      MODEL_SETTINGS_IMPORT_ENDPOINT,
    ]);
    const agentUpload = requests.find((request) => request.url === AGENTS_IMPORT_ENDPOINT)!;
    expect(agentUpload.body).toEqual({ agents: [legacyAgent] });
    expect(agentUpload.headers.get(LEGACY_IMPORT_HEADER)).toBe(browserId);
    const modelUpload = requests.find((request) => request.url === MODEL_SETTINGS_IMPORT_ENDPOINT)!;
    expect(modelUpload.body).toEqual(proposal);
    expect(modelUpload.headers.get(LEGACY_IMPORT_HEADER)).toBe(browserId);
    expect(localStorage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    expect(client.getState().phase).toBe('ready');
  });
});
