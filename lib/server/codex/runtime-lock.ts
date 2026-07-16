import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const CODEX_RUNTIME_LOCK_FILE_NAME = '.openmaic-codex-runtime.lock';

type RuntimeLockErrorCode = 'CODEX_RUNTIME_LOCKED' | 'CODEX_RUNTIME_LOCK_UNAVAILABLE';

export class CodexRuntimeLockError extends Error {
  constructor(readonly code: RuntimeLockErrorCode) {
    super(
      code === 'CODEX_RUNTIME_LOCKED'
        ? 'Codex runtime is already active'
        : 'Codex runtime lock unavailable',
    );
    this.name = 'CodexRuntimeLockError';
  }
}

export interface CodexRuntimeLockLease {
  release(): void;
}

interface RuntimeLockOptions {
  /** Data directory. Defaults to `<cwd>/data`; the lock is stored under `auth/`. */
  baseDir?: string;
}

interface LockOwner {
  version: 1;
  pid: number;
  nonce: string;
}

interface LockSnapshot {
  owner: LockOwner;
  dev: number | bigint;
  ino: number | bigint;
}

interface RegistryEntry {
  lockPath: string;
  owner: LockOwner;
  dev: number | bigint;
  ino: number | bigint;
  scopedReferences: number;
  processLifetime: boolean;
}

interface RuntimeLockRegistry {
  entries: Map<string, RegistryEntry>;
}

const REGISTRY_KEY = Symbol.for('openmaic.codex.oauth.runtime-lock.v1');
const registryHost = globalThis as unknown as Record<PropertyKey, unknown>;

function isRegistry(value: unknown): value is RuntimeLockRegistry {
  return Boolean(
    value && typeof value === 'object' && (value as RuntimeLockRegistry).entries instanceof Map,
  );
}

const existingRegistry = registryHost[REGISTRY_KEY];
const registry: RuntimeLockRegistry = isRegistry(existingRegistry)
  ? existingRegistry
  : { entries: new Map() };

if (!isRegistry(existingRegistry)) {
  Object.defineProperty(registryHost, REGISTRY_KEY, {
    value: registry,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function unavailable(): never {
  throw new CodexRuntimeLockError('CODEX_RUNTIME_LOCK_UNAVAILABLE');
}

function locked(): never {
  throw new CodexRuntimeLockError('CODEX_RUNTIME_LOCKED');
}

function errnoCode(error: unknown): string | undefined {
  return error &&
    typeof error === 'object' &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function ensurePrivateAuthDirectory(baseDir: string): string {
  const authDir = join(baseDir, 'auth');
  try {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(authDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) unavailable();
    chmodSync(authDir, 0o700);
    return authDir;
  } catch (error) {
    if (error instanceof CodexRuntimeLockError) throw error;
    unavailable();
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(
    Object.keys(record).length === 3 &&
    record.version === 1 &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.nonce === 'string' &&
    /^[a-f0-9]{32}$/.test(record.nonce),
  );
}

function readLockSnapshot(path: string): LockSnapshot {
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.size < 1 ||
      pathStat.size > 512
    ) {
      locked();
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      locked();
    }
    const parsed: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!isLockOwner(parsed)) locked();
    return { owner: parsed, dev: openedStat.dev, ino: openedStat.ino };
  } catch (error) {
    if (error instanceof CodexRuntimeLockError) throw error;
    return locked();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor is best-effort cleanup after a fail-closed read.
      }
    }
  }
}

function writePreparedOwner(authDir: string, owner: LockOwner): string {
  const temporaryPath = join(authDir, `.codex-runtime-owner.${owner.pid}.${owner.nonce}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporaryPath;
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Ignore cleanup failure and report only the safe lock category.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort for a file that may never have been created.
    }
    unavailable();
  }
}

function tryCreateLock(authDir: string, lockPath: string): LockSnapshot | undefined {
  const owner: LockOwner = {
    version: 1,
    pid: process.pid,
    nonce: randomBytes(16).toString('hex'),
  };
  const preparedPath = writePreparedOwner(authDir, owner);
  try {
    // The fully-written private owner file is hard-linked into the fixed lock
    // name, making acquisition atomic without an empty/partial owner window.
    linkSync(preparedPath, lockPath);
    const snapshot = readLockSnapshot(lockPath);
    if (snapshot.owner.pid !== owner.pid || snapshot.owner.nonce !== owner.nonce) locked();
    return snapshot;
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') unavailable();
    return undefined;
  } finally {
    try {
      unlinkSync(preparedPath);
    } catch {
      // The fixed lock link, when created, remains authoritative.
    }
  }
}

function isPidLive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    return undefined;
  }
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.owner.pid === right.owner.pid &&
    left.owner.nonce === right.owner.nonce
  );
}

function restoreMovedLock(stalePath: string, lockPath: string): void {
  try {
    linkSync(stalePath, lockPath);
    unlinkSync(stalePath);
  } catch {
    // Another contender may already have restored/replaced the fixed lock.
    // Leave the moved file for local investigation and fail closed.
  }
}

function reclaimDeadOwner(lockPath: string, snapshot: LockSnapshot): boolean {
  const stalePath = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    locked();
  }

  let moved: LockSnapshot;
  try {
    moved = readLockSnapshot(stalePath);
  } catch {
    restoreMovedLock(stalePath, lockPath);
    locked();
  }
  if (!sameSnapshot(snapshot, moved)) {
    restoreMovedLock(stalePath, lockPath);
    locked();
  }
  try {
    unlinkSync(stalePath);
  } catch {
    locked();
  }
  return true;
}

function acquireEntry(baseDir: string, processLifetime: boolean): RegistryEntry {
  const authDir = ensurePrivateAuthDirectory(baseDir);
  const lockPath = resolve(authDir, CODEX_RUNTIME_LOCK_FILE_NAME);
  const existing = registry.entries.get(lockPath);
  if (existing) {
    const current = readLockSnapshot(lockPath);
    if (!sameSnapshot(existing, current)) locked();
    if (processLifetime) existing.processLifetime = true;
    else existing.scopedReferences += 1;
    return existing;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = tryCreateLock(authDir, lockPath);
    if (snapshot) {
      const entry: RegistryEntry = {
        lockPath,
        owner: snapshot.owner,
        dev: snapshot.dev,
        ino: snapshot.ino,
        scopedReferences: processLifetime ? 0 : 1,
        processLifetime,
      };
      registry.entries.set(lockPath, entry);
      return entry;
    }

    const incumbent = readLockSnapshot(lockPath);
    const live = isPidLive(incumbent.owner.pid);
    if (live !== false) locked();
    if (!reclaimDeadOwner(lockPath, incumbent)) continue;
  }
  locked();
}

/** Acquire a scoped lease, used by the stopped-app maintenance helper. */
export function acquireCodexRuntimeLock(options: RuntimeLockOptions = {}): CodexRuntimeLockLease {
  const entry = acquireEntry(options.baseDir ?? join(process.cwd(), 'data'), false);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      entry.scopedReferences = Math.max(0, entry.scopedReferences - 1);
    },
  };
}

/** Acquire and retain the normal server lease until this Node process exits. */
export function ensureCodexRuntimeLock(options: RuntimeLockOptions = {}): void {
  acquireEntry(options.baseDir ?? join(process.cwd(), 'data'), true);
}

export function isCodexRuntimeLockError(error: unknown): error is CodexRuntimeLockError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    ((error as { code?: unknown }).code === 'CODEX_RUNTIME_LOCKED' ||
      (error as { code?: unknown }).code === 'CODEX_RUNTIME_LOCK_UNAVAILABLE'),
  );
}
