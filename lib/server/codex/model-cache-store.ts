import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

import {
  CODEX_COMPATIBILITY_VERSION,
  CODEX_MODEL_CATALOG_LIMITS,
  isCodexThinkingEffort,
  rebuildCodexModelCatalog,
} from '@/lib/ai/codex-catalog';
import type { ModelInfo } from '@/lib/types/provider';

export const CODEX_MODEL_CACHE_FILE_NAME = 'openai-codex-models.v1.json';
export const CODEX_MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CODEX_MODEL_CACHE_MAX_BYTES = 1024 * 1024;
const CODEX_MODEL_CACHE_SCHEMA_VERSION = 1;
const ACCOUNT_SCOPE_NAMESPACE = 'openmaic-codex-models-v1';
const MAX_THINKING_EFFORTS = 7;

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

export interface CodexModelCacheFileSystem {
  chmod: typeof chmod;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open: typeof open;
  readlink: typeof readlink;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
}

export interface FileCodexModelCatalogStoreOptions {
  /** Data directory. Defaults to `<cwd>/data`; the store adds `cache/`. */
  baseDir?: string;
  /** Injectable filesystem adapter for alternate runtimes and failure testing. */
  fs?: Partial<CodexModelCacheFileSystem>;
}

interface MutationQueue {
  tail: Promise<void>;
}

interface DirectoryComponentIdentity {
  path: string;
  kind: 'directory' | 'trusted-system-symlink';
  dev: number;
  ino: number;
  uid: number;
  followedDev?: number;
  followedIno?: number;
  followedUid?: number;
  resolvedTarget?: string;
  physicalChain?: DirectoryComponentIdentity[];
}

interface DirectoryChainSnapshot {
  components: DirectoryComponentIdentity[];
}

const DEFAULT_CACHE_FS: CodexModelCacheFileSystem = Object.freeze({
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  stat,
  unlink,
});

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

function hasExactKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): boolean {
  const keys = Object.keys(value);
  return (
    [...required].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.has(key) || optional.has(key))
  );
}

const TOP_LEVEL_KEYS = new Set([
  'version',
  'compatibilityVersion',
  'validatedAt',
  'accountScope',
  'models',
]);
const MODEL_REQUIRED_KEYS = new Set(['id', 'name', 'capabilities', 'source']);
const MODEL_OPTIONAL_KEYS = new Set(['contextWindow']);
const CAPABILITY_REQUIRED_KEYS = new Set(['streaming', 'tools']);
const CAPABILITY_OPTIONAL_KEYS = new Set(['vision', 'thinking', 'serviceTiers']);
const THINKING_REQUIRED_KEYS = new Set([
  'control',
  'requestAdapter',
  'defaultMode',
  'effortValues',
  'toggleable',
  'budgetAdjustable',
  'defaultEnabled',
]);
const THINKING_OPTIONAL_KEYS = new Set(['defaultEffort']);

function isCanonicalString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
  );
}

function isCanonicalThinking(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, THINKING_REQUIRED_KEYS, THINKING_OPTIONAL_KEYS) ||
    value.control !== 'effort' ||
    value.requestAdapter !== 'openai' ||
    !Array.isArray(value.effortValues) ||
    value.effortValues.length < 1 ||
    value.effortValues.length > MAX_THINKING_EFFORTS ||
    !value.effortValues.every(isCodexThinkingEffort) ||
    new Set(value.effortValues).size !== value.effortValues.length ||
    value.budgetAdjustable !== true
  ) {
    return false;
  }

  const toggleable = value.effortValues.includes('none');
  if (
    value.toggleable !== toggleable ||
    value.defaultMode !== (toggleable ? 'disabled' : 'enabled') ||
    value.defaultEnabled !== !toggleable
  ) {
    return false;
  }
  return (
    value.defaultEffort === undefined ||
    (isCodexThinkingEffort(value.defaultEffort) && value.effortValues.includes(value.defaultEffort))
  );
}

function isCanonicalCapabilities(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CAPABILITY_REQUIRED_KEYS, CAPABILITY_OPTIONAL_KEYS) ||
    value.streaming !== true ||
    value.tools !== true ||
    (value.vision !== undefined && value.vision !== true) ||
    (value.thinking !== undefined && !isCanonicalThinking(value.thinking))
  ) {
    return false;
  }
  return (
    value.serviceTiers === undefined ||
    (Array.isArray(value.serviceTiers) &&
      value.serviceTiers.length === 1 &&
      value.serviceTiers[0] === 'priority')
  );
}

function isCanonicalModel(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, MODEL_REQUIRED_KEYS, MODEL_OPTIONAL_KEYS) ||
    !isCanonicalString(value.id, CODEX_MODEL_CATALOG_LIMITS.maxIdLength) ||
    !isCanonicalString(value.name, CODEX_MODEL_CATALOG_LIMITS.maxNameLength) ||
    value.source !== 'probed' ||
    !isCanonicalCapabilities(value.capabilities)
  ) {
    return false;
  }
  return (
    value.contextWindow === undefined ||
    (Number.isSafeInteger(value.contextWindow) &&
      (value.contextWindow as number) >= 1 &&
      (value.contextWindow as number) <= CODEX_MODEL_CATALOG_LIMITS.maxContextWindow)
  );
}

function isCanonicalModelArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CODEX_MODEL_CATALOG_LIMITS.maxModels ||
    !value.every(isCanonicalModel)
  ) {
    return false;
  }
  return new Set(value.map((model) => (model as Record<string, unknown>).id)).size === value.length;
}

function accountScope(accountId: string): string {
  const digest = createHash('sha256')
    .update(`${ACCOUNT_SCOPE_NAMESPACE}\0`, 'utf8')
    .update(accountId, 'utf8')
    .digest('hex');
  return `${ACCOUNT_SCOPE_NAMESPACE}:sha256:${digest}`;
}

function pathComponents(path: string): string[] {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const parts = relative(root, absolutePath).split(sep).filter(Boolean);
  let current = root;
  return [
    root,
    ...parts.map((part) => {
      current = join(current, part);
      return current;
    }),
  ];
}

function sameIdentity(
  left: DirectoryComponentIdentity,
  right: DirectoryComponentIdentity,
): boolean {
  const leftPhysicalChain = left.physicalChain ?? [];
  const rightPhysicalChain = right.physicalChain ?? [];
  return (
    left.path === right.path &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.followedDev === right.followedDev &&
    left.followedIno === right.followedIno &&
    left.followedUid === right.followedUid &&
    left.resolvedTarget === right.resolvedTarget &&
    leftPhysicalChain.length === rightPhysicalChain.length &&
    leftPhysicalChain.every((component, index) =>
      sameIdentity(component, rightPhysicalChain[index]!),
    )
  );
}

function sameFile(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isGroupOrWorldWritable(value: Pick<Stats, 'mode'>): boolean {
  return (value.mode & 0o022) !== 0;
}

function hasUnsafeDirectoryPermissions(value: Pick<Stats, 'mode'>): boolean {
  return isGroupOrWorldWritable(value) && (value.mode & 0o1000) === 0;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function fsyncDirectoryBestEffort(
  directory: string,
  expected: DirectoryComponentIdentity,
  fs: CodexModelCacheFileSystem,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory() || !sameFile(openedStat, expected)) return;
    await handle.sync();
  } catch {
    // The cache file itself is fsynced before rename. Some filesystems do not
    // support directory fsync, so durability of the directory entry is best effort.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readOpenedFileCapped(handle: FileHandle): Promise<Buffer | null> {
  // Read at most one sentinel byte beyond the policy limit. This remains
  // bounded even if another process appends after the initial fstat.
  const buffer = Buffer.allocUnsafe(CODEX_MODEL_CACHE_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset > CODEX_MODEL_CACHE_MAX_BYTES ? null : buffer.subarray(0, offset);
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
  private readonly fs: CodexModelCacheFileSystem;
  private readonly effectiveUid = process.getuid?.();

  constructor(options: FileCodexModelCatalogStoreOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? join(process.cwd(), 'data'));
    this.cacheDir = join(this.baseDir, 'cache');
    this.cachePath = join(this.cacheDir, CODEX_MODEL_CACHE_FILE_NAME);
    this.coordinationKey = `file:${resolve(this.cachePath)}`;
    this.fs = { ...DEFAULT_CACHE_FS, ...options.fs };
  }

  private async inspectDirectoryComponent(
    path: string,
    rootOwnedOnly = false,
    activeAliases: ReadonlySet<string> = new Set(),
  ): Promise<DirectoryComponentIdentity> {
    const pathStat = await this.fs.lstat(path);
    if (pathStat.isSymbolicLink()) {
      const canonicalAlias = resolve(path);
      if (activeAliases.has(canonicalAlias)) {
        throw new Error('Unsafe Codex model cache ancestor cycle');
      }
      const nextAliases = new Set(activeAliases);
      nextAliases.add(canonicalAlias);
      const linkTarget = await this.fs.readlink(path);
      const resolvedTarget = resolve(dirname(path), linkTarget);
      const physicalSnapshot = await this.captureDirectoryChain(resolvedTarget, true, nextAliases);
      const followed = await this.fs.stat(path);
      // macOS exposes stable root-owned aliases such as /var -> /private/var.
      // The alias and every component of its expanded target must remain
      // root-owned and free of unsafe write permissions. User-owned aliases,
      // including aliases that merely end at a root-owned directory, fail closed.
      const physicalTarget = physicalSnapshot.components.at(-1);
      const physicalTargetDev =
        physicalTarget?.kind === 'trusted-system-symlink'
          ? physicalTarget.followedDev
          : physicalTarget?.dev;
      const physicalTargetIno =
        physicalTarget?.kind === 'trusted-system-symlink'
          ? physicalTarget.followedIno
          : physicalTarget?.ino;
      const physicalTargetUid =
        physicalTarget?.kind === 'trusted-system-symlink'
          ? physicalTarget.followedUid
          : physicalTarget?.uid;
      if (
        this.effectiveUid === undefined ||
        pathStat.uid !== 0 ||
        !followed.isDirectory() ||
        followed.uid !== 0 ||
        hasUnsafeDirectoryPermissions(followed) ||
        physicalTargetDev !== followed.dev ||
        physicalTargetIno !== followed.ino ||
        physicalTargetUid !== followed.uid
      ) {
        throw new Error('Unsafe Codex model cache ancestor');
      }
      return {
        path,
        kind: 'trusted-system-symlink',
        dev: pathStat.dev,
        ino: pathStat.ino,
        uid: pathStat.uid,
        followedDev: followed.dev,
        followedIno: followed.ino,
        followedUid: followed.uid,
        resolvedTarget,
        physicalChain: physicalSnapshot.components,
      };
    }
    if (!pathStat.isDirectory()) throw new Error('Unsafe Codex model cache ancestor');
    if (
      (rootOwnedOnly && pathStat.uid !== 0) ||
      (!rootOwnedOnly &&
        this.effectiveUid !== undefined &&
        pathStat.uid !== 0 &&
        pathStat.uid !== this.effectiveUid)
    ) {
      throw new Error('Unsafe Codex model cache ancestor owner');
    }
    if (hasUnsafeDirectoryPermissions(pathStat)) {
      throw new Error('Unsafe Codex model cache ancestor permissions');
    }
    return {
      path,
      kind: 'directory',
      dev: pathStat.dev,
      ino: pathStat.ino,
      uid: pathStat.uid,
    };
  }

  private requireCurrentUserDirectory(identity: DirectoryComponentIdentity): void {
    if (
      identity.kind !== 'directory' ||
      (this.effectiveUid !== undefined && identity.uid !== this.effectiveUid)
    ) {
      throw new Error('Unsafe Codex model cache directory owner');
    }
  }

  private async captureDirectoryChain(
    target: string,
    rootOwnedOnly = false,
    activeAliases: ReadonlySet<string> = new Set(),
  ): Promise<DirectoryChainSnapshot> {
    const components: DirectoryComponentIdentity[] = [];
    for (const component of pathComponents(target)) {
      components.push(
        await this.inspectDirectoryComponent(component, rootOwnedOnly, activeAliases),
      );
    }
    return { components };
  }

  private async assertStableDirectoryChain(snapshot: DirectoryChainSnapshot): Promise<void> {
    const current = await this.captureDirectoryChain(this.cacheDir);
    if (
      current.components.length !== snapshot.components.length ||
      !current.components.every((component, index) =>
        sameIdentity(component, snapshot.components[index]!),
      )
    ) {
      throw new Error('Codex model cache directory changed during operation');
    }
  }

  private getCacheDirectoryIdentity(snapshot: DirectoryChainSnapshot): DirectoryComponentIdentity {
    const identity = snapshot.components.find((component) => component.path === this.cacheDir);
    if (!identity) throw new Error('Missing Codex model cache directory identity');
    return identity;
  }

  private async captureSafeDirectories(): Promise<DirectoryChainSnapshot> {
    const snapshot = await this.captureDirectoryChain(this.cacheDir);
    const baseIdentity = snapshot.components.find((component) => component.path === this.baseDir);
    const cacheIdentity = snapshot.components.find((component) => component.path === this.cacheDir);
    if (!baseIdentity || !cacheIdentity) throw new Error('Missing Codex model cache directories');
    this.requireCurrentUserDirectory(baseIdentity);
    this.requireCurrentUserDirectory(cacheIdentity);
    return snapshot;
  }

  private async ensureSafeDirectories(): Promise<DirectoryChainSnapshot> {
    for (const component of pathComponents(this.cacheDir)) {
      try {
        const existing = await this.inspectDirectoryComponent(component);
        if (component === this.baseDir || component === this.cacheDir) {
          this.requireCurrentUserDirectory(existing);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parentSnapshot = await this.captureDirectoryChain(dirname(component));
        try {
          await this.fs.mkdir(component, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        const created = await this.inspectDirectoryComponent(component);
        this.requireCurrentUserDirectory(created);
        const currentParent = await this.captureDirectoryChain(dirname(component));
        if (
          currentParent.components.length !== parentSnapshot.components.length ||
          !currentParent.components.every((entry, index) =>
            sameIdentity(entry, parentSnapshot.components[index]!),
          )
        ) {
          throw new Error('Codex model cache parent changed during creation');
        }
      }
    }
    return this.captureSafeDirectories();
  }

  private async lstatSafeFile(
    path: string,
    snapshot: DirectoryChainSnapshot,
    allowMissing: boolean,
  ): Promise<Stats | null> {
    await this.assertStableDirectoryChain(snapshot);
    let pathStat: Stats;
    try {
      pathStat = await this.fs.lstat(path);
    } catch (error) {
      await this.assertStableDirectoryChain(snapshot);
      if (allowMissing && isMissing(error)) return null;
      throw error;
    }
    await this.assertStableDirectoryChain(snapshot);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      (this.effectiveUid !== undefined && pathStat.uid !== this.effectiveUid) ||
      isGroupOrWorldWritable(pathStat)
    ) {
      throw new Error('Unsafe Codex model cache file');
    }
    return pathStat;
  }

  async load(accountId: string, now = Date.now()): Promise<CodexModelCatalogCacheEntry | null> {
    if (typeof accountId !== 'string' || accountId.length === 0 || !Number.isFinite(now)) {
      return null;
    }

    let handle: FileHandle | undefined;
    try {
      const snapshot = await this.captureSafeDirectories();
      await this.assertStableDirectoryChain(snapshot);
      await this.fs.chmod(this.cacheDir, 0o700);
      await this.assertStableDirectoryChain(snapshot);

      const pathStat = await this.lstatSafeFile(this.cachePath, snapshot, false);
      if (!pathStat) return null;
      await this.assertStableDirectoryChain(snapshot);
      handle = await this.fs.open(this.cachePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      await this.assertStableDirectoryChain(snapshot);
      const openedStat = await handle.stat();
      const postOpenPathStat = await this.lstatSafeFile(this.cachePath, snapshot, false);
      if (
        !postOpenPathStat ||
        !openedStat.isFile() ||
        !sameFile(openedStat, pathStat) ||
        !sameFile(openedStat, postOpenPathStat) ||
        (this.effectiveUid !== undefined && openedStat.uid !== this.effectiveUid) ||
        isGroupOrWorldWritable(openedStat) ||
        openedStat.size > CODEX_MODEL_CACHE_MAX_BYTES
      ) {
        return null;
      }
      await handle.chmod(0o600);
      const raw = await readOpenedFileCapped(handle);
      if (!raw) return null;
      const postReadOpenedStat = await handle.stat();
      if (
        postReadOpenedStat.size !== openedStat.size ||
        postReadOpenedStat.size !== raw.byteLength ||
        postReadOpenedStat.size > CODEX_MODEL_CACHE_MAX_BYTES
      ) {
        return null;
      }
      await this.assertStableDirectoryChain(snapshot);
      const postReadPathStat = await this.lstatSafeFile(this.cachePath, snapshot, false);
      if (!postReadPathStat || !sameFile(openedStat, postReadPathStat)) return null;
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!isRecord(parsed) || !hasExactKeys(parsed, TOP_LEVEL_KEYS)) return null;
      if (
        parsed.version !== CODEX_MODEL_CACHE_SCHEMA_VERSION ||
        parsed.compatibilityVersion !== CODEX_COMPATIBILITY_VERSION ||
        parsed.accountScope !== accountScope(accountId) ||
        !Number.isSafeInteger(parsed.validatedAt) ||
        (parsed.validatedAt as number) < 0 ||
        !isCanonicalModelArray(parsed.models)
      ) {
        return null;
      }
      const validatedAt = parsed.validatedAt as number;
      const age = now - validatedAt;
      if (age < 0 || age >= CODEX_MODEL_CACHE_TTL_MS) return null;
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
        !Number.isSafeInteger(validatedAt) ||
        validatedAt < 0
      ) {
        throw new Error('Invalid Codex model cache metadata');
      }
      const safeModels = rebuildCodexModelCatalog(models);
      if (!safeModels || !isCanonicalModelArray(safeModels)) {
        throw new Error('Invalid Codex model cache schema');
      }
      if (options.shouldCommit && !(await options.shouldCommit())) return false;

      const snapshot = await this.ensureSafeDirectories();
      await this.assertStableDirectoryChain(snapshot);
      await this.fs.chmod(this.cacheDir, 0o700);
      await this.assertStableDirectoryChain(snapshot);
      await this.lstatSafeFile(this.cachePath, snapshot, true);

      const disk = {
        version: CODEX_MODEL_CACHE_SCHEMA_VERSION,
        compatibilityVersion: CODEX_COMPATIBILITY_VERSION,
        validatedAt,
        accountScope: accountScope(accountId),
        models: safeModels,
      };
      const serialized = `${JSON.stringify(disk)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > CODEX_MODEL_CACHE_MAX_BYTES) {
        throw new Error('Codex model cache exceeds maximum size');
      }
      const temporaryPath = join(
        this.cacheDir,
        `.${CODEX_MODEL_CACHE_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
      );
      let handle: FileHandle | undefined;
      let temporaryStat: Stats | undefined;
      let renamed = false;
      try {
        await this.assertStableDirectoryChain(snapshot);
        handle = await this.fs.open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await this.assertStableDirectoryChain(snapshot);
        temporaryStat = await handle.stat();
        if (
          !temporaryStat.isFile() ||
          (this.effectiveUid !== undefined && temporaryStat.uid !== this.effectiveUid)
        ) {
          throw new Error('Unsafe Codex model cache temporary file');
        }
        await handle.writeFile(serialized, 'utf8');
        await handle.chmod(0o600);
        await handle.sync();
        await handle.close();
        handle = undefined;

        if (options.shouldCommit && !(await options.shouldCommit())) return false;
        await this.assertStableDirectoryChain(snapshot);
        const closedTemporaryStat = await this.lstatSafeFile(temporaryPath, snapshot, false);
        if (!closedTemporaryStat || !sameFile(closedTemporaryStat, temporaryStat)) {
          throw new Error('Codex model cache temporary file changed before commit');
        }
        await this.fs.rename(temporaryPath, this.cachePath);
        renamed = true;
        await this.assertStableDirectoryChain(snapshot);
        const committedStat = await this.lstatSafeFile(this.cachePath, snapshot, false);
        if (!committedStat || !sameFile(committedStat, temporaryStat)) {
          throw new Error('Codex model cache target changed during commit');
        }
        const cacheIdentity = this.getCacheDirectoryIdentity(snapshot);
        await fsyncDirectoryBestEffort(this.cacheDir, cacheIdentity, this.fs);
        await this.assertStableDirectoryChain(snapshot);
        return true;
      } finally {
        await handle?.close().catch(() => undefined);
        if (!renamed && temporaryStat) {
          try {
            const currentTemporaryStat = await this.lstatSafeFile(temporaryPath, snapshot, true);
            if (currentTemporaryStat && sameFile(currentTemporaryStat, temporaryStat)) {
              await this.assertStableDirectoryChain(snapshot);
              await this.fs.unlink(temporaryPath);
              await this.assertStableDirectoryChain(snapshot);
            }
          } catch {
            // Never chase cleanup through a directory whose identity changed.
          }
        }
      }
    });
  }

  clear(): Promise<void> {
    return runMutation(this.coordinationKey, async () => {
      try {
        const snapshot = await this.captureSafeDirectories();
        const target = await this.lstatSafeFile(this.cachePath, snapshot, true);
        if (!target) return;
        await this.assertStableDirectoryChain(snapshot);
        await this.fs.unlink(this.cachePath);
        await this.assertStableDirectoryChain(snapshot);
        const cacheIdentity = this.getCacheDirectoryIdentity(snapshot);
        await fsyncDirectoryBestEffort(this.cacheDir, cacheIdentity, this.fs);
        await this.assertStableDirectoryChain(snapshot);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    });
  }
}

// Node does not expose openat/renameat/unlinkat primitives relative to a held
// directory descriptor. The recorded dev+ino chain and immediate pre/post
// checks fail closed on detected swaps, but a same-user swap in the final
// check-to-syscall window remains a portable TOCTOU residual.
