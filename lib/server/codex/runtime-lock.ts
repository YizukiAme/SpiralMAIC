import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

// Keep the v1 coordination pathname. A v1 owner publishes a file here and v2
// publishes a directory, so either version treats the other's live shape as
// occupied and fails closed during an overlapping upgrade.
export const CODEX_RUNTIME_LOCK_DIRECTORY_NAME = '.openmaic-codex-runtime.lock';
/** @deprecated Internal compatibility alias; the path is now a directory. */
export const CODEX_RUNTIME_LOCK_FILE_NAME = CODEX_RUNTIME_LOCK_DIRECTORY_NAME;

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
  /** Data directory. Defaults to `<cwd>/data`; the lock directory is under `auth/`. */
  baseDir?: string;
}

interface ProcessIdentity {
  platform: 'linux' | 'darwin';
  scope: string;
  pid: number;
  start: string;
}

interface RuntimeClaim {
  version: 2;
  nonce: string;
  identity: ProcessIdentity;
}

interface DirectorySnapshot {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
}

interface ClaimSnapshot {
  path: string;
  claim: RuntimeClaim;
  dev: number | bigint;
  ino: number | bigint;
}

interface RegistryEntry {
  directory: DirectorySnapshot;
  claim: ClaimSnapshot;
  scopedReferences: number;
  processLifetime: boolean;
}

interface RuntimeLockRegistry {
  entries: Map<string, RegistryEntry>;
}

type ProcessStartResult =
  | { status: 'live'; start: string }
  | { status: 'dead' }
  | { status: 'unknown' };

const CLAIM_FILE_PATTERN = /^claim-([a-f0-9]{32})\.json$/;
const CLAIM_MAX_BYTES = 2048;
const MAX_ACQUIRE_ATTEMPTS = 8;
const REGISTRY_KEY = Symbol.for('openmaic.codex.oauth.runtime-lock.v2');
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

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch {
    unavailable();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The lock is already fail-closed if descriptor cleanup fails.
      }
    }
  }
}

function validatePrivateDirectory(path: string, expected?: DirectorySnapshot): DirectorySnapshot {
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      return expected ? locked() : unavailable();
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isDirectory() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      return expected ? locked() : unavailable();
    }
    if (expected && (openedStat.dev !== expected.dev || openedStat.ino !== expected.ino)) locked();
    fchmodSync(descriptor, 0o700);
    const privateStat = fstatSync(descriptor);
    if ((privateStat.mode & 0o777) !== 0o700) {
      return expected ? locked() : unavailable();
    }
    return { path, dev: privateStat.dev, ino: privateStat.ino };
  } catch (error) {
    if (error instanceof CodexRuntimeLockError) throw error;
    return expected ? locked() : unavailable();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Validation already established a fail-closed ownership decision.
      }
    }
  }
}

function ensurePrivateAuthDirectory(baseDir: string): string {
  const authDir = join(baseDir, 'auth');
  try {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(authDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) unavailable();
    chmodSync(authDir, 0o700);
    if ((lstatSync(authDir).mode & 0o777) !== 0o700) unavailable();
    return authDir;
  } catch (error) {
    if (error instanceof CodexRuntimeLockError) throw error;
    unavailable();
  }
}

function ensureLockDirectory(authDir: string): DirectorySnapshot {
  const path = resolve(authDir, CODEX_RUNTIME_LOCK_DIRECTORY_NAME);
  try {
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(authDir);
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') unavailable();
  }
  return validatePrivateDirectory(path);
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Boolean(
    Object.keys(identity).length === 4 &&
    (identity.platform === 'linux' || identity.platform === 'darwin') &&
    typeof identity.scope === 'string' &&
    /^[a-f0-9]{64}$/.test(identity.scope) &&
    Number.isSafeInteger(identity.pid) &&
    (identity.pid as number) > 0 &&
    typeof identity.start === 'string' &&
    identity.start.length > 0 &&
    identity.start.length <= 256,
  );
}

function isRuntimeClaim(value: unknown): value is RuntimeClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return Boolean(
    Object.keys(claim).length === 3 &&
    claim.version === 2 &&
    typeof claim.nonce === 'string' &&
    /^[a-f0-9]{32}$/.test(claim.nonce) &&
    isProcessIdentity(claim.identity),
  );
}

function readClaimSnapshot(path: string): ClaimSnapshot {
  let descriptor: number | undefined;
  try {
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    const nonce = CLAIM_FILE_PATTERN.exec(fileName)?.[1];
    if (!nonce) locked();
    const pathStat = lstatSync(path);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.size < 1 ||
      pathStat.size > CLAIM_MAX_BYTES ||
      (pathStat.mode & 0o777) !== 0o600
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
    if (!isRuntimeClaim(parsed) || parsed.nonce !== nonce) locked();
    return { path, claim: parsed, dev: openedStat.dev, ino: openedStat.ino };
  } catch (error) {
    if (error instanceof CodexRuntimeLockError) throw error;
    return locked();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close cannot make an untrusted claim authoritative.
      }
    }
  }
}

function sameClaimSnapshot(left: ClaimSnapshot, right: ClaimSnapshot): boolean {
  return (
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.claim.nonce === right.claim.nonce &&
    left.claim.identity.platform === right.claim.identity.platform &&
    left.claim.identity.scope === right.claim.identity.scope &&
    left.claim.identity.pid === right.claim.identity.pid &&
    left.claim.identity.start === right.claim.identity.start
  );
}

function hashScope(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function boundedCommandOutput(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4096,
    timeout: 1000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  const output = result.stdout.trim();
  return output && output.length <= 1024 ? output : undefined;
}

function readLinuxProcessStart(pid: number): ProcessStartResult {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return { status: 'unknown' };
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/);
    const start = fields[19];
    return start && /^\d+$/.test(start) ? { status: 'live', start } : { status: 'unknown' };
  } catch (error) {
    const code = errnoCode(error);
    return code === 'ENOENT' || code === 'ESRCH' ? { status: 'dead' } : { status: 'unknown' };
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

function readDarwinProcessStart(pid: number): ProcessStartResult {
  const output = boundedCommandOutput('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (output) return { status: 'live', start: output };
  const live = isPidLive(pid);
  return live === false ? { status: 'dead' } : { status: 'unknown' };
}

function currentLinuxIdentity(): ProcessIdentity {
  let bootId: string;
  let cgroup: string;
  let rootMount: string;
  try {
    bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim();
    const mountInfo = readFileSync('/proc/self/mountinfo', 'utf8');
    const rootLine = mountInfo.split('\n').find((line) => line.split(' ')[4] === '/');
    const separator = rootLine?.indexOf(' - ') ?? -1;
    rootMount = separator >= 0 ? rootLine!.slice(separator + 3).trim() : '';
  } catch {
    unavailable();
  }
  if (!bootId || bootId.length > 128 || cgroup.length > 8192 || rootMount.length > 32 * 1024) {
    unavailable();
  }
  const containerized =
    existsSync('/.dockerenv') ||
    existsSync('/run/.containerenv') ||
    /(?:docker|containerd|kubepods|podman|lxc)/i.test(cgroup);
  if (containerized && !rootMount) unavailable();
  const scope = hashScope([
    'linux',
    bootId,
    containerized ? 'container' : 'host',
    hostname(),
    ...(containerized ? [cgroup, rootMount] : []),
  ]);
  const start = readLinuxProcessStart(process.pid);
  if (start.status !== 'live') unavailable();
  return { platform: 'linux', scope, pid: process.pid, start: start.start };
}

function currentDarwinIdentity(): ProcessIdentity {
  const boot = boundedCommandOutput('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  const start = readDarwinProcessStart(process.pid);
  if (!boot || start.status !== 'live') unavailable();
  return {
    platform: 'darwin',
    scope: hashScope(['darwin', boot, hostname()]),
    pid: process.pid,
    start: start.start,
  };
}

function currentProcessIdentity(): ProcessIdentity {
  if (process.platform === 'linux') return currentLinuxIdentity();
  if (process.platform === 'darwin') return currentDarwinIdentity();
  unavailable();
}

function claimLiveness(claim: RuntimeClaim, current: ProcessIdentity): 'live' | 'dead' | 'unknown' {
  if (claim.identity.platform !== current.platform || claim.identity.scope !== current.scope) {
    return 'unknown';
  }
  const target =
    current.platform === 'linux'
      ? readLinuxProcessStart(claim.identity.pid)
      : readDarwinProcessStart(claim.identity.pid);
  if (target.status !== 'live') return target.status;
  return target.start === claim.identity.start ? 'live' : 'dead';
}

function writePreparedClaim(authDir: string, claim: RuntimeClaim): string | undefined {
  const temporaryPath = join(authDir, `.codex-runtime-claim.${claim.nonce}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(claim)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporaryPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Ignore cleanup failure and preserve the safe error category.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The prepared path may never have been created.
    }
    if (errnoCode(error) === 'EEXIST') return undefined;
    unavailable();
  }
}

function publishClaim(
  authDir: string,
  directory: DirectorySnapshot,
  identity: ProcessIdentity,
): ClaimSnapshot {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    validatePrivateDirectory(directory.path, directory);
    const nonce = randomBytes(16).toString('hex');
    const claim: RuntimeClaim = { version: 2, nonce, identity };
    const preparedPath = writePreparedClaim(authDir, claim);
    if (!preparedPath) continue;
    const claimPath = join(directory.path, `claim-${nonce}.json`);
    try {
      linkSync(preparedPath, claimPath);
      fsyncDirectory(directory.path);
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') continue;
      unavailable();
    } finally {
      try {
        unlinkSync(preparedPath);
      } catch {
        // The immutable claim link, once published, remains authoritative.
      }
    }
    const snapshot = readClaimSnapshot(claimPath);
    if (
      snapshot.claim.nonce !== claim.nonce ||
      snapshot.claim.identity.pid !== identity.pid ||
      snapshot.claim.identity.start !== identity.start ||
      snapshot.claim.identity.scope !== identity.scope
    ) {
      locked();
    }
    return snapshot;
  }
  unavailable();
}

function unlinkExactClaim(
  directory: DirectorySnapshot,
  snapshot: ClaimSnapshot,
): 'removed' | 'missing' {
  validatePrivateDirectory(directory.path, directory);
  try {
    lstatSync(snapshot.path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'missing';
    locked();
  }
  const current = readClaimSnapshot(snapshot.path);
  if (!sameClaimSnapshot(snapshot, current)) locked();
  try {
    unlinkSync(snapshot.path);
    fsyncDirectory(directory.path);
    return 'removed';
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'missing';
    locked();
  }
}

function removeOwnClaim(directory: DirectorySnapshot, own: ClaimSnapshot): void {
  try {
    unlinkExactClaim(directory, own);
  } catch {
    // The caller still fails closed. Never attempt pathname-wide cleanup.
  }
}

function electPublishedClaim(
  directory: DirectorySnapshot,
  own: ClaimSnapshot,
  identity: ProcessIdentity,
): void {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    validatePrivateDirectory(directory.path, directory);
    let entries: string[];
    try {
      entries = readdirSync(directory.path, { encoding: 'utf8' });
    } catch {
      removeOwnClaim(directory, own);
      locked();
    }

    let ownSeen = false;
    let blocker = false;
    let removedDeadClaim = false;
    for (const fileName of entries) {
      const match = CLAIM_FILE_PATTERN.exec(fileName);
      if (!match) {
        blocker = true;
        continue;
      }
      const claimPath = join(directory.path, fileName);
      let candidate: ClaimSnapshot;
      try {
        candidate = readClaimSnapshot(claimPath);
      } catch {
        blocker = true;
        continue;
      }
      if (candidate.path === own.path) {
        ownSeen = sameClaimSnapshot(candidate, own);
        if (!ownSeen) blocker = true;
        continue;
      }

      const live = claimLiveness(candidate.claim, identity);
      if (live !== 'dead') {
        blocker = true;
        continue;
      }
      try {
        removedDeadClaim = unlinkExactClaim(directory, candidate) === 'removed' || removedDeadClaim;
      } catch {
        blocker = true;
      }
    }

    if (!ownSeen || blocker) {
      removeOwnClaim(directory, own);
      locked();
    }
    if (removedDeadClaim) continue;
    return;
  }
  removeOwnClaim(directory, own);
  locked();
}

function acquireEntry(baseDir: string, processLifetime: boolean): RegistryEntry {
  const authDir = ensurePrivateAuthDirectory(baseDir);
  const directory = ensureLockDirectory(authDir);
  const registryKey = directory.path;
  const existing = registry.entries.get(registryKey);
  if (existing) {
    validatePrivateDirectory(existing.directory.path, existing.directory);
    const current = readClaimSnapshot(existing.claim.path);
    if (!sameClaimSnapshot(existing.claim, current)) locked();
    if (processLifetime) existing.processLifetime = true;
    else existing.scopedReferences += 1;
    return existing;
  }

  const identity = currentProcessIdentity();
  const claim = publishClaim(authDir, directory, identity);
  try {
    electPublishedClaim(directory, claim, identity);
  } catch (error) {
    removeOwnClaim(directory, claim);
    throw error;
  }
  const entry: RegistryEntry = {
    directory,
    claim,
    scopedReferences: processLifetime ? 0 : 1,
    processLifetime,
  };
  registry.entries.set(registryKey, entry);
  return entry;
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
      if (entry.processLifetime || entry.scopedReferences > 0) return;
      try {
        unlinkExactClaim(entry.directory, entry.claim);
        registry.entries.delete(entry.directory.path);
      } catch {
        // Keep the registry entry fail-closed if the directory or claim changed.
      }
    },
  };
}

/** Acquire and retain the normal server claim until this Node process exits. */
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
