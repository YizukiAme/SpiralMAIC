import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ModelInfo } from '@/lib/types/provider';
import {
  CODEX_MODEL_CACHE_FILE_NAME,
  CODEX_MODEL_CACHE_TTL_MS,
  FileCodexModelCatalogStore,
} from '@/lib/server/codex/model-cache-store';

const NOW = 1_700_000_000_000;
const ACCOUNT_ID = 'raw-account-id-must-never-land-on-disk';
const temporaryPaths: string[] = [];

async function makeBaseDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'spiralmaic-codex-model-cache-'));
  temporaryPaths.push(path);
  return path;
}

function safeModels(): ModelInfo[] {
  return [
    {
      id: 'gpt-safe',
      name: 'GPT Safe',
      contextWindow: 372_000,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        thinking: {
          control: 'effort',
          requestAdapter: 'openai',
          defaultMode: 'enabled',
          effortValues: ['low', 'medium'],
          defaultEffort: 'medium',
          toggleable: false,
          budgetAdjustable: true,
          defaultEnabled: true,
        },
        serviceTiers: ['priority'],
      },
      source: 'probed',
    },
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('FileCodexModelCatalogStore', () => {
  it('writes only the v1 safe schema with a namespaced account hash and private permissions', async () => {
    const baseDir = await makeBaseDir();
    const store = new FileCodexModelCatalogStore({ baseDir });
    const tainted = safeModels() as Array<ModelInfo & Record<string, unknown>>;
    Object.assign(tainted[0], {
      accountId: ACCOUNT_ID,
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      etag: 'etag-secret',
      endpoint: 'https://secret.example',
      credentialGeneration: 'generation-secret',
      email: 'secret@example.com',
      plan: 'secret-plan',
      prompt: 'secret-prompt',
      description: 'secret-description',
      baseInstructions: 'secret-base-instructions',
      rawResponse: { secret: true },
    });

    await expect(store.save(ACCOUNT_ID, tainted, NOW)).resolves.toBe(true);

    const raw = await readFile(store.cachePath, 'utf8');
    const disk = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(disk).sort()).toEqual([
      'accountScope',
      'compatibilityVersion',
      'models',
      'validatedAt',
      'version',
    ]);
    expect(disk).toMatchObject({
      version: 1,
      compatibilityVersion: '0.144.4',
      validatedAt: NOW,
      accountScope: expect.stringMatching(/^openmaic-codex-models-v1:sha256:[a-f0-9]{64}$/),
    });
    expect(disk.models).toEqual([
      {
        id: 'gpt-safe',
        name: 'GPT Safe',
        contextWindow: 372_000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            control: 'effort',
            requestAdapter: 'openai',
            defaultMode: 'enabled',
            effortValues: ['low', 'medium'],
            defaultEffort: 'medium',
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
          serviceTiers: ['priority'],
        },
        source: 'probed',
      },
    ]);
    expect(raw).not.toMatch(
      /raw-account-id|access-secret|refresh-secret|etag-secret|secret\.example|generation-secret|secret@example|secret-plan|secret-prompt|secret-description|secret-base-instructions|rawResponse/,
    );
    expect((await stat(store.cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.cachePath)).mode & 0o777).toBe(0o600);
  });

  it('loads only the same account scope within the seven-day TTL', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await store.save(ACCOUNT_ID, safeModels(), NOW);

    await expect(store.load(ACCOUNT_ID, NOW + CODEX_MODEL_CACHE_TTL_MS - 1)).resolves.toEqual({
      models: safeModels(),
      validatedAt: NOW,
    });
    await expect(store.load('different-account', NOW + 1)).resolves.toBeNull();
    await expect(store.load(ACCOUNT_ID, NOW + CODEX_MODEL_CACHE_TTL_MS)).resolves.toBeNull();
    await expect(store.load(ACCOUNT_ID, NOW - 1)).resolves.toBeNull();
  });

  it('ignores corruption, unknown fields, schema changes, and compatibility changes', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await mkdir(store.cacheDir, { recursive: true, mode: 0o700 });

    await writeFile(store.cachePath, '{"version":');
    await expect(store.load(ACCOUNT_ID, NOW)).resolves.toBeNull();

    await store.save(ACCOUNT_ID, safeModels(), NOW);
    const valid = JSON.parse(await readFile(store.cachePath, 'utf8')) as Record<string, unknown>;
    for (const override of [
      { version: 2 },
      { compatibilityVersion: '0.144.5' },
      { token: 'must-be-rejected' },
      { models: [...safeModels(), safeModels()[0]] },
      { models: [{ id: 'x'.repeat(129), name: 'Too long' }] },
      { models: [{ id: 'ok', name: 'x'.repeat(257) }] },
      { models: [{ id: 'ok', name: 'Ok', contextWindow: 10_000_001 }] },
    ]) {
      await writeFile(store.cachePath, JSON.stringify({ ...valid, ...override }));
      await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
    }
  });

  it('atomically replaces the cache without leaving temporary files', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await store.save(ACCOUNT_ID, safeModels(), NOW);
    await store.save(ACCOUNT_ID, [{ ...safeModels()[0], id: 'gpt-new', name: 'GPT New' }], NOW + 1);

    expect(await readdir(store.cacheDir)).toEqual([CODEX_MODEL_CACHE_FILE_NAME]);
    await expect(store.load(ACCOUNT_ID, NOW + 2)).resolves.toMatchObject({
      models: [{ id: 'gpt-new' }],
      validatedAt: NOW + 1,
    });
  });

  it('repairs broad permissions before loading', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await store.save(ACCOUNT_ID, safeModels(), NOW);
    await chmod(store.cacheDir, 0o755);
    await chmod(store.cachePath, 0o644);

    await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.not.toBeNull();
    expect((await stat(store.cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.cachePath)).mode & 0o777).toBe(0o600);
  });

  it('does not read or write through symlinked cache paths', async () => {
    const baseDir = await makeBaseDir();
    const externalDir = await makeBaseDir();
    const sentinelPath = join(externalDir, 'sentinel.json');
    await writeFile(sentinelPath, 'unchanged', { mode: 0o644 });

    const directoryStore = new FileCodexModelCatalogStore({ baseDir });
    await symlink(externalDir, directoryStore.cacheDir);
    await expect(directoryStore.load(ACCOUNT_ID, NOW)).resolves.toBeNull();
    await expect(directoryStore.save(ACCOUNT_ID, safeModels(), NOW)).rejects.toThrow();
    expect(await readFile(sentinelPath, 'utf8')).toBe('unchanged');

    const fileStore = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await mkdir(fileStore.cacheDir, { recursive: true, mode: 0o700 });
    await symlink(sentinelPath, fileStore.cachePath);
    await expect(fileStore.load(ACCOUNT_ID, NOW)).resolves.toBeNull();
    await expect(fileStore.save(ACCOUNT_ID, safeModels(), NOW)).rejects.toThrow();
    expect(await readFile(sentinelPath, 'utf8')).toBe('unchanged');
  });

  it('rejects a symlinked base data directory before creating an external cache', async () => {
    const parentDir = await makeBaseDir();
    const externalDir = await makeBaseDir();
    const linkedBaseDir = join(parentDir, 'linked-data');
    await symlink(externalDir, linkedBaseDir);
    const store = new FileCodexModelCatalogStore({ baseDir: linkedBaseDir });

    await expect(store.load(ACCOUNT_ID, NOW)).resolves.toBeNull();
    await expect(store.save(ACCOUNT_ID, safeModels(), NOW)).rejects.toThrow();
    expect(await readdir(externalDir)).toEqual([]);
  });

  it('rejects non-regular cache targets and cleans failed temporary writes', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await mkdir(store.cacheDir, { recursive: true, mode: 0o700 });
    await mkdir(store.cachePath);
    await writeFile(join(store.cachePath, 'sentinel'), 'unchanged');

    await expect(store.load(ACCOUNT_ID, NOW)).resolves.toBeNull();
    await expect(store.save(ACCOUNT_ID, safeModels(), NOW)).rejects.toThrow();
    expect(await readdir(store.cacheDir)).toEqual([CODEX_MODEL_CACHE_FILE_NAME]);
    expect(await readFile(join(store.cachePath, 'sentinel'), 'utf8')).toBe('unchanged');
  });

  it('clears the cache idempotently', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await store.save(ACCOUNT_ID, safeModels(), NOW);

    await store.clear();
    await store.clear();

    await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
  });
});
