import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { CODEX_COMPATIBILITY_VERSION, rebuildCodexModelCatalog } from '@/lib/ai/codex-catalog';
import type { ModelInfo } from '@/lib/types/provider';

export const CODEX_MODEL_CACHE_FILE_NAME = 'openai-codex-models.v1.json';
export const CODEX_MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_MODEL_CACHE_SCHEMA_VERSION = 1;
const ACCOUNT_SCOPE_NAMESPACE = 'openmaic-codex-models-v1';

export interface CodexModelCatalogCacheEntry {
  models: ModelInfo[];
  validatedAt: number;
}

export interface CodexModelCatalogSaveOptions {
  shouldCommit?(): boolean | Promise<boolean>;
}

export interface CodexModelCatalogStore {
  load(accountId: string, now?: number): Promise<CodexModelCatalogCacheEntry | null>;
  save(
    accountId: string,
    models: ModelInfo[],
    validatedAt: number,
    options?: CodexModelCatalogSaveOptions,
  ): Promise<boolean>;
  clear(): Promise<void>;
}

interface FileCodexModelCatalogStoreOptions {
  /** Data directory. Defaults to `<cwd>/data`; the store adds `cache/`. */
  baseDir?: string;
}

interface MutationQueue {
  tail: Promise<void>;
}

const MUTATION_QUEUES_KEY = Symbol.for('openmaic.codex.model-cache.mutations.v1');
const mutationQueueHost = globalThis as unknown as Record<PropertyKey, unknown>;
const existingQueues = mutationQueueHost[MUTATION_QUEUES_KEY];
const mutationQueues: Map<string, MutationQueue> =
  existingQueues instanceof Map ? existingQueues : new Map<string, MutationQueue>();

if (!(existingQueues instanceof Map)) {
  Object.defineProperty(mutationQueueHost, MUTATION_QUEUES_KEY, {
    value: mutationQueues,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const TOP_LEVEL_KEYS = new Set([
  'version',
  'compatibilityVersion',
  'validatedAt',
  'accountScope',
  'models',
]);
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'capabilities', 'source']);
const CAPABILITY_KEYS = new Set(['streaming', 'tools', 'vision', 'thinking', 'serviceTiers']);
const THINKING_KEYS = new Set([
  'control',
  'requestAdapter',
  'defaultMode',
  'effortValues',
  'defaultEffort',
  'toggleable',
  'budgetAdjustable',
  'defaultEnabled',
]);

function hasStrictModelKeys(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, MODEL_KEYS)) return false;
  if (value.capabilities !== undefined) {
    if (!isRecord(value.capabilities) || !hasOnlyKeys(value.capabilities, CAPABILITY_KEYS)) {
      return false;
    }
    if (
      value.capabilities.thinking !== undefined &&
      (!isRecord(value.capabilities.thinking) ||
        !hasOnlyKeys(value.capabilities.thinking, THINKING_KEYS))
    ) {
      return false;
    }
  }
  return true;
}

function accountScope(accountId: string): string {
  const digest = createHash('sha256')
    .update(`${ACCOUNT_SCOPE_NAMESPACE}\0`, 'utf8')
    .update(accountId, 'utf8')
    .digest('hex');
  return `${ACCOUNT_SCOPE_NAMESPACE}:sha256:${digest}`;
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // The cache file itself is fsynced before rename. Some filesystems do not
    // support directory fsync, so durability of the directory entry is best effort.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function runMutation<T>(coordinationKey: string, operation: () => Promise<T>): Promise<T> {
  let queue = mutationQueues.get(coordinationKey);
  if (!queue) {
    queue = { tail: Promise.resolve() };
    mutationQueues.set(coordinationKey, queue);
  }
  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export class FileCodexModelCatalogStore implements CodexModelCatalogStore {
  readonly baseDir: string;
  readonly cacheDir: string;
  readonly cachePath: string;
  readonly coordinationKey: string;

  constructor(options: FileCodexModelCatalogStoreOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? join(process.cwd(), 'data'));
    this.cacheDir = join(this.baseDir, 'cache');
    this.cachePath = join(this.cacheDir, CODEX_MODEL_CACHE_FILE_NAME);
    this.coordinationKey = `file:${resolve(this.cachePath)}`;
  }

  async load(accountId: string, now = Date.now()): Promise<CodexModelCatalogCacheEntry | null> {
    if (typeof accountId !== 'string' || accountId.length === 0 || !Number.isFinite(now)) {
      return null;
    }

    try {
      const baseStat = await lstat(this.baseDir);
      if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) return null;
    } catch {
      return null;
    }

    let directoryStat: Awaited<ReturnType<typeof lstat>>;
    try {
      directoryStat = await lstat(this.cacheDir);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
      await chmod(this.cacheDir, 0o700);
    } catch {
      return null;
    }

    let pathStat: Awaited<ReturnType<typeof lstat>>;
    try {
      pathStat = await lstat(this.cachePath);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) return null;
    } catch {
      return null;
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.cachePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== pathStat.dev ||
        openedStat.ino !== pathStat.ino
      ) {
        return null;
      }
      await handle.chmod(0o600);
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!isRecord(parsed) || !hasOnlyKeys(parsed, TOP_LEVEL_KEYS)) return null;
      if (
        parsed.version !== CODEX_MODEL_CACHE_SCHEMA_VERSION ||
        parsed.compatibilityVersion !== CODEX_COMPATIBILITY_VERSION ||
        parsed.accountScope !== accountScope(accountId) ||
        !Number.isFinite(parsed.validatedAt)
      ) {
        return null;
      }
      const validatedAt = parsed.validatedAt as number;
      const age = now - validatedAt;
      if (validatedAt < 0 || age < 0 || age >= CODEX_MODEL_CACHE_TTL_MS) return null;
      if (!Array.isArray(parsed.models) || !parsed.models.every(hasStrictModelKeys)) return null;
      const models = rebuildCodexModelCatalog(parsed.models);
      return models ? { models, validatedAt } : null;
    } catch {
      // Missing, corrupt, schema-invalid and unsafe entries are all cache misses.
      // Never log parser errors or contents from this account-scoped file.
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  save(
    accountId: string,
    models: ModelInfo[],
    validatedAt: number,
    options: CodexModelCatalogSaveOptions = {},
  ): Promise<boolean> {
    return runMutation(this.coordinationKey, async () => {
      if (
        typeof accountId !== 'string' ||
        accountId.length === 0 ||
        !Number.isFinite(validatedAt) ||
        validatedAt < 0
      ) {
        throw new Error('Invalid Codex model cache metadata');
      }
      const safeModels = rebuildCodexModelCatalog(models);
      if (!safeModels) throw new Error('Invalid Codex model cache schema');
      if (options.shouldCommit && !(await options.shouldCommit())) return false;

      try {
        const baseStat = await lstat(this.baseDir);
        if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
          throw new Error('Unsafe Codex model cache base directory');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
        const baseStat = await lstat(this.baseDir);
        if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
          throw new Error('Unsafe Codex model cache base directory');
        }
      }
      try {
        await mkdir(this.cacheDir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const directoryStat = await lstat(this.cacheDir);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error('Unsafe Codex model cache directory');
      }
      await chmod(this.cacheDir, 0o700);

      try {
        const targetStat = await lstat(this.cachePath);
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
          throw new Error('Unsafe Codex model cache file');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const disk = {
        version: CODEX_MODEL_CACHE_SCHEMA_VERSION,
        compatibilityVersion: CODEX_COMPATIBILITY_VERSION,
        validatedAt,
        accountScope: accountScope(accountId),
        models: safeModels,
      };
      const temporaryPath = join(
        this.cacheDir,
        `.${CODEX_MODEL_CACHE_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let renamed = false;
      try {
        handle = await open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(disk)}\n`, 'utf8');
        await handle.chmod(0o600);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, this.cachePath);
        renamed = true;
        await fsyncDirectoryBestEffort(this.cacheDir);
        return true;
      } finally {
        await handle?.close().catch(() => undefined);
        if (!renamed) await unlink(temporaryPath).catch(() => undefined);
      }
    });
  }

  clear(): Promise<void> {
    return runMutation(this.coordinationKey, async () => {
      try {
        const baseStat = await lstat(this.baseDir);
        if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) return;
        const directoryStat = await lstat(this.cacheDir);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return;
        const targetStat = await lstat(this.cachePath);
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) return;
        await unlink(this.cachePath);
        await fsyncDirectoryBestEffort(this.cacheDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }
}
