import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename as renamePath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelInfo } from '@/lib/types/provider';
import {
  CODEX_MODEL_CACHE_FILE_NAME,
  CODEX_MODEL_CACHE_MAX_BYTES,
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

  it('rejects a writable canonical file even when a pre-opened writer performs a same-size rewrite', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await store.save(ACCOUNT_ID, safeModels(), NOW);
    const canonical = await readFile(store.cachePath, 'utf8');
    const attackerPayload = canonical
      .replace('gpt-safe', 'gpt-evil')
      .replace('GPT Safe', 'GPT Evil');

    expect(Buffer.byteLength(attackerPayload)).toBe(Buffer.byteLength(canonical));
    await chmod(store.cachePath, 0o666);
    const writer = await open(store.cachePath, 'r+');
    try {
      const payload = Buffer.from(attackerPayload);
      await writer.write(payload, 0, payload.byteLength, 0);
      await writer.sync();

      await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
    } finally {
      await writer.close();
    }
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

  it('rejects files larger than exactly 1 MiB before parsing the opened handle', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await store.save(ACCOUNT_ID, safeModels(), NOW);
    const raw = (await readFile(store.cachePath, 'utf8')).trimEnd();

    expect(CODEX_MODEL_CACHE_MAX_BYTES).toBe(1024 * 1024);
    await writeFile(store.cachePath, raw.padEnd(CODEX_MODEL_CACHE_MAX_BYTES, ' '));
    await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.not.toBeNull();

    await writeFile(store.cachePath, raw.padEnd(CODEX_MODEL_CACHE_MAX_BYTES + 1, ' '));
    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('rejects a cache file that grows beyond 1 MiB after the opened-handle stat', async () => {
    const baseDir = await makeBaseDir();
    const original = new FileCodexModelCatalogStore({ baseDir });
    await original.save(ACCOUNT_ID, safeModels(), NOW);
    let grew = false;
    const racingStore = new FileCodexModelCatalogStore({
      baseDir,
      fs: {
        open: (async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (String(args[0]) !== original.cachePath) return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'stat') {
                return async () => {
                  const beforeGrowth = await target.stat();
                  if (!grew) {
                    grew = true;
                    await appendFile(
                      original.cachePath,
                      ' '.repeat(CODEX_MODEL_CACHE_MAX_BYTES + 1),
                    );
                  }
                  return beforeGrowth;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }) as typeof open,
      },
    });

    await expect(racingStore.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
  });

  it('requires the exact canonical nested disk schema without normalization', async () => {
    const store = new FileCodexModelCatalogStore({ baseDir: await makeBaseDir() });
    await store.save(ACCOUNT_ID, safeModels(), NOW);
    const valid = JSON.parse(await readFile(store.cachePath, 'utf8')) as Record<string, unknown>;
    const validModel = (valid.models as Array<Record<string, unknown>>)[0]!;
    const validCapabilities = validModel.capabilities as Record<string, unknown>;
    const validThinking = validCapabilities.thinking as Record<string, unknown>;

    const invalidModels: unknown[] = [
      (() => {
        const { id: _id, ...model } = validModel;
        return model;
      })(),
      (() => {
        const { name: _name, ...model } = validModel;
        return model;
      })(),
      (() => {
        const { capabilities: _capabilities, ...model } = validModel;
        return model;
      })(),
      { ...validModel, id: ' gpt-safe' },
      { ...validModel, contextWindow: 1.5 },
      { ...validModel, contextWindow: null },
      { ...validModel, source: 'public' },
      { ...validModel, source: undefined },
      { ...validModel, capabilities: { ...validCapabilities, streaming: false } },
      { ...validModel, capabilities: { ...validCapabilities, tools: 'true' } },
      { ...validModel, capabilities: { ...validCapabilities, vision: false } },
      {
        ...validModel,
        capabilities: { ...validCapabilities, serviceTiers: ['priority', 'bogus'] },
      },
      { ...validModel, capabilities: { ...validCapabilities, serviceTiers: [] } },
      {
        ...validModel,
        capabilities: { ...validCapabilities, serviceTiers: ['priority', 'priority'] },
      },
      {
        ...validModel,
        capabilities: { ...validCapabilities, serviceTiers: [{ tier: 'priority' }, 'priority'] },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: { ...validThinking, effortValues: ['low', 'bogus'] },
        },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: { ...validThinking, effortValues: [] },
        },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: { ...validThinking, effortValues: ['low', 'low'] },
        },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: { ...validThinking, effortValues: 'low' },
        },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: (() => {
            const { control: _control, ...thinking } = validThinking;
            return thinking;
          })(),
        },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: { ...validThinking, defaultEffort: 'high' },
        },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: { ...validThinking, toggleable: true },
        },
      },
      {
        ...validModel,
        capabilities: {
          ...validCapabilities,
          thinking: { ...validThinking, effortValues: Array(129).fill('low') },
        },
      },
    ];

    for (const model of invalidModels) {
      await writeFile(store.cachePath, JSON.stringify({ ...valid, models: [model] }));
      await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
    }

    const { models: _models, ...withoutModels } = valid;
    await writeFile(store.cachePath, JSON.stringify(withoutModels));
    await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();

    await writeFile(store.cachePath, JSON.stringify({ ...valid, validatedAt: NOW + 0.5 }));
    await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();

    await writeFile(
      store.cachePath,
      JSON.stringify({ ...valid, models: Array(129).fill(validModel) }),
    );
    await expect(store.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
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

  it('keeps the old complete target and cleans its temp when rename fails', async () => {
    const baseDir = await makeBaseDir();
    const originalStore = new FileCodexModelCatalogStore({ baseDir });
    await originalStore.save(ACCOUNT_ID, safeModels(), NOW);
    const oldRaw = await readFile(originalStore.cachePath, 'utf8');
    const failingStore = new FileCodexModelCatalogStore({
      baseDir,
      fs: {
        rename: async (source, target) => {
          expect(JSON.parse(await readFile(source, 'utf8'))).toMatchObject({
            models: [{ id: 'gpt-new' }],
          });
          expect(await readFile(target, 'utf8')).toBe(oldRaw);
          throw new Error('injected rename failure');
        },
      },
    });

    await expect(
      failingStore.save(
        ACCOUNT_ID,
        [{ ...safeModels()[0], id: 'gpt-new', name: 'GPT New' }],
        NOW + 1,
      ),
    ).rejects.toThrow('injected rename failure');
    expect(await readFile(originalStore.cachePath, 'utf8')).toBe(oldRaw);
    expect(await readdir(originalStore.cacheDir)).toEqual([CODEX_MODEL_CACHE_FILE_NAME]);
    await expect(originalStore.load(ACCOUNT_ID, NOW + 2)).resolves.toMatchObject({
      models: [{ id: 'gpt-safe' }],
    });

    await originalStore.save(
      ACCOUNT_ID,
      [{ ...safeModels()[0], id: 'gpt-new', name: 'GPT New' }],
      NOW + 1,
    );
    await expect(originalStore.load(ACCOUNT_ID, NOW + 2)).resolves.toMatchObject({
      models: [{ id: 'gpt-new' }],
    });
  });

  it('publishes only complete old or new JSON across a gated rename', async () => {
    const baseDir = await makeBaseDir();
    const reader = new FileCodexModelCatalogStore({ baseDir });
    await reader.save(ACCOUNT_ID, safeModels(), NOW);
    let announceRename!: () => void;
    const atRename = new Promise<void>((resolve) => {
      announceRename = resolve;
    });
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const writer = new FileCodexModelCatalogStore({
      baseDir,
      fs: {
        rename: async (source, target) => {
          expect(JSON.parse(await readFile(source, 'utf8'))).toMatchObject({
            models: [{ id: 'gpt-new' }],
          });
          expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({
            models: [{ id: 'gpt-safe' }],
          });
          announceRename();
          await renameGate;
          await renamePath(source, target);
        },
      },
    });

    const replacement = writer.save(
      ACCOUNT_ID,
      [{ ...safeModels()[0], id: 'gpt-new', name: 'GPT New' }],
      NOW + 1,
    );
    await atRename;
    await expect(reader.load(ACCOUNT_ID, NOW + 2)).resolves.toMatchObject({
      models: [{ id: 'gpt-safe' }],
    });
    releaseRename();
    await replacement;
    await expect(reader.load(ACCOUNT_ID, NOW + 2)).resolves.toMatchObject({
      models: [{ id: 'gpt-new' }],
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

  it('rejects a symlink in an existing ancestor of a missing configured base', async () => {
    const parentDir = await makeBaseDir();
    const externalDir = await makeBaseDir();
    const linkedAncestor = join(parentDir, 'linked-ancestor');
    await symlink(externalDir, linkedAncestor);
    const store = new FileCodexModelCatalogStore({ baseDir: join(linkedAncestor, 'data') });

    await expect(store.load(ACCOUNT_ID, NOW)).resolves.toBeNull();
    await expect(store.save(ACCOUNT_ID, safeModels(), NOW)).rejects.toThrow();
    expect(await readdir(externalDir)).toEqual([]);
  });

  it('rejects a trusted root alias whose expanded target chain has a writable intermediate', async () => {
    const parentDir = await makeBaseDir();
    const physicalRoot = join(parentDir, 'physical-root');
    const writableIntermediate = join(physicalRoot, 'writable-intermediate');
    const trustedTarget = join(writableIntermediate, 'trusted-target');
    const physicalBaseDir = join(trustedTarget, 'data');
    const physicalStore = new FileCodexModelCatalogStore({ baseDir: physicalBaseDir });
    await physicalStore.save(ACCOUNT_ID, safeModels(), NOW);

    const alias = join(parentDir, 'trusted-system-alias');
    await symlink(trustedTarget, alias);
    await chmod(writableIntermediate, 0o777);
    const isPhysicalTargetComponent = (path: string): boolean =>
      path === trustedTarget || trustedTarget.startsWith(`${path}${sep}`);
    const rootOwned = <T extends object>(value: T): T =>
      new Proxy(value, {
        get(target, property) {
          if (property === 'uid') return 0;
          return Reflect.get(target, property, target);
        },
      });
    const aliasStore = new FileCodexModelCatalogStore({
      baseDir: join(alias, 'data'),
      fs: {
        lstat: (async (path) => {
          const result = await lstat(path);
          const candidate = String(path);
          return candidate === alias || isPhysicalTargetComponent(candidate)
            ? rootOwned(result)
            : result;
        }) as typeof lstat,
        stat: (async (path) => {
          const result = await stat(path);
          return String(path) === alias ? rootOwned(result) : result;
        }) as typeof stat,
      },
    });

    await expect(aliasStore.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
    await chmod(writableIntermediate, 0o700);
    await expect(aliasStore.load(ACCOUNT_ID, NOW + 1)).resolves.toMatchObject({
      models: [{ id: 'gpt-safe' }],
    });
  });

  it('rejects cache directories not owned by the effective user', async () => {
    const baseDir = await makeBaseDir();
    const original = new FileCodexModelCatalogStore({ baseDir });
    await original.save(ACCOUNT_ID, safeModels(), NOW);
    const cacheDir = original.cacheDir;
    const unsafe = new FileCodexModelCatalogStore({
      baseDir,
      fs: {
        lstat: (async (path) => {
          const result = await lstat(path);
          if (String(path) !== cacheDir) return result;
          return new Proxy(result, {
            get(target, property) {
              if (property === 'uid') return target.uid + 1;
              return Reflect.get(target, property, target);
            },
          });
        }) as typeof lstat,
      },
    });

    await expect(unsafe.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
    await expect(unsafe.save(ACCOUNT_ID, safeModels(), NOW + 1)).rejects.toThrow();
  });

  it('rejects non-sticky group/world-writable configured ancestors', async () => {
    const baseDir = await makeBaseDir();
    const original = new FileCodexModelCatalogStore({ baseDir });
    await original.save(ACCOUNT_ID, safeModels(), NOW);
    await chmod(baseDir, 0o777);

    const unsafe = new FileCodexModelCatalogStore({ baseDir });
    await expect(unsafe.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
    await expect(unsafe.save(ACCOUNT_ID, safeModels(), NOW + 1)).rejects.toThrow();
  });

  it('detects a cache-directory dev+ino swap around path-based chmod', async () => {
    const baseDir = await makeBaseDir();
    const original = new FileCodexModelCatalogStore({ baseDir });
    await original.save(ACCOUNT_ID, safeModels(), NOW);
    const movedCacheDir = join(baseDir, 'moved-cache');
    let swapped = false;
    const unsafe = new FileCodexModelCatalogStore({
      baseDir,
      fs: {
        chmod: async (path, mode) => {
          await chmod(path, mode);
          if (String(path) === original.cacheDir && !swapped) {
            swapped = true;
            await renamePath(original.cacheDir, movedCacheDir);
            await mkdir(original.cacheDir, { mode: 0o700 });
          }
        },
      },
    });

    await expect(unsafe.load(ACCOUNT_ID, NOW + 1)).resolves.toBeNull();
    expect(await readFile(join(movedCacheDir, CODEX_MODEL_CACHE_FILE_NAME), 'utf8')).toContain(
      'gpt-safe',
    );
    expect(await readdir(original.cacheDir)).toEqual([]);
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
