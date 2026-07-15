import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const CODEX_CREDENTIAL_FILE_NAME = 'openai-codex.json';

export interface CodexOAuthCredentials {
  version: 1;
  accessToken: string;
  refreshToken: string;
  /** Absolute Unix time in milliseconds. */
  expiresAt: number;
  accountId: string;
  email?: string;
  /** Absolute Unix time in milliseconds. */
  updatedAt: number;
}

export interface CodexCredentialVault {
  readonly coordinationKey?: string;
  load(): Promise<CodexOAuthCredentials | null>;
  save(credentials: CodexOAuthCredentials): Promise<void>;
  clear(): Promise<void>;
}

export function codexCredentialsEqual(
  left: CodexOAuthCredentials | null,
  right: CodexOAuthCredentials | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.version === right.version &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt &&
    left.accountId === right.accountId &&
    left.email === right.email &&
    left.updatedAt === right.updatedAt
  );
}

interface CodexVaultMutationQueue {
  tail: Promise<void>;
}

interface CodexVaultMutationRegistry {
  byCoordinationKey: Map<string, CodexVaultMutationQueue>;
  byVault: WeakMap<CodexCredentialVault, CodexVaultMutationQueue>;
}

const MUTATION_REGISTRY_KEY = Symbol.for('openmaic.codex.oauth.vault-mutations.v1');
const mutationRegistryHost = globalThis as unknown as Record<PropertyKey, unknown>;

function isMutationRegistry(value: unknown): value is CodexVaultMutationRegistry {
  if (!value || typeof value !== 'object') return false;
  const registry = value as Partial<CodexVaultMutationRegistry>;
  return registry.byCoordinationKey instanceof Map && registry.byVault instanceof WeakMap;
}

const existingMutationRegistry = mutationRegistryHost[MUTATION_REGISTRY_KEY];
const mutationRegistry: CodexVaultMutationRegistry = isMutationRegistry(existingMutationRegistry)
  ? existingMutationRegistry
  : {
      byCoordinationKey: new Map<string, CodexVaultMutationQueue>(),
      byVault: new WeakMap<CodexCredentialVault, CodexVaultMutationQueue>(),
    };

if (!isMutationRegistry(existingMutationRegistry)) {
  Object.defineProperty(mutationRegistryHost, MUTATION_REGISTRY_KEY, {
    value: mutationRegistry,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function getMutationQueue(vault: CodexCredentialVault): CodexVaultMutationQueue {
  const coordinationKey = vault.coordinationKey;
  if (typeof coordinationKey === 'string' && coordinationKey.length > 0) {
    const existing = mutationRegistry.byCoordinationKey.get(coordinationKey);
    if (existing) return existing;
    const queue = { tail: Promise.resolve() };
    mutationRegistry.byCoordinationKey.set(coordinationKey, queue);
    return queue;
  }

  const existing = mutationRegistry.byVault.get(vault);
  if (existing) return existing;
  const queue = { tail: Promise.resolve() };
  mutationRegistry.byVault.set(vault, queue);
  return queue;
}

/**
 * Serialize a complete credential read/modify/write transaction by logical
 * vault identity. The registry survives dev HMR and also coordinates separate
 * FileVault instances that point at the same credential path.
 *
 * Transactions must not call this helper recursively for the same vault.
 */
export async function withCodexCredentialVaultMutation<T>(
  vault: CodexCredentialVault,
  operation: () => Promise<T>,
): Promise<T> {
  const queue = getMutationQueue(vault);
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

interface FileCodexCredentialVaultOptions {
  /** Data directory. Defaults to `<cwd>/data`; the vault adds `auth/`. */
  baseDir?: string;
}

const REQUIRED_STRING_FIELDS = [
  'accessToken',
  'refreshToken',
  'accountId',
] as const satisfies ReadonlyArray<keyof CodexOAuthCredentials>;

const ALLOWED_FIELDS = new Set<keyof CodexOAuthCredentials>([
  'version',
  'accessToken',
  'refreshToken',
  'expiresAt',
  'accountId',
  'email',
  'updatedAt',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isCodexOAuthCredentials(value: unknown): value is CodexOAuthCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED_FIELDS.has(key as keyof CodexOAuthCredentials))) {
    return false;
  }
  if (record.version !== 1) return false;
  if (REQUIRED_STRING_FIELDS.some((field) => !isNonEmptyString(record[field]))) return false;
  if (!Number.isFinite(record.expiresAt) || (record.expiresAt as number) <= 0) return false;
  if (!Number.isFinite(record.updatedAt) || (record.updatedAt as number) < 0) return false;
  if (record.email !== undefined && !isNonEmptyString(record.email)) return false;

  return true;
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some filesystems. The file itself was
    // already fsynced before rename, so this remains a best-effort hardening.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class FileCodexCredentialVault implements CodexCredentialVault {
  readonly authDir: string;
  readonly credentialPath: string;
  readonly coordinationKey: string;

  constructor(options: FileCodexCredentialVaultOptions = {}) {
    const baseDir = options.baseDir ?? join(process.cwd(), 'data');
    this.authDir = join(baseDir, 'auth');
    this.credentialPath = join(this.authDir, CODEX_CREDENTIAL_FILE_NAME);
    this.coordinationKey = `file:${resolve(this.credentialPath)}`;
  }

  async load(): Promise<CodexOAuthCredentials | null> {
    let authStat: Awaited<ReturnType<typeof lstat>>;
    try {
      authStat = await lstat(this.authDir);
      if (authStat.isSymbolicLink() || !authStat.isDirectory()) return null;
      await chmod(this.authDir, 0o700);
    } catch {
      return null;
    }

    let credentialStat: Awaited<ReturnType<typeof lstat>>;
    try {
      credentialStat = await lstat(this.credentialPath);
      if (credentialStat.isSymbolicLink() || !credentialStat.isFile()) return null;
    } catch {
      return null;
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== credentialStat.dev ||
        openedStat.ino !== credentialStat.ino
      ) {
        return null;
      }
      await handle.chmod(0o600);
      const raw = await handle.readFile('utf8');
      const parsed: unknown = JSON.parse(raw);
      return isCodexOAuthCredentials(parsed) ? parsed : null;
    } catch {
      // Missing, unreadable, corrupt, schema-invalid, and non-regular entries
      // all behave like signed-out state. Never log credential data or errors.
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async save(credentials: CodexOAuthCredentials): Promise<void> {
    if (!isCodexOAuthCredentials(credentials)) {
      throw new Error('Invalid Codex credential schema');
    }

    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    const authStat = await lstat(this.authDir);
    if (authStat.isSymbolicLink() || !authStat.isDirectory()) {
      throw new Error('Unsafe Codex credential directory');
    }
    await chmod(this.authDir, 0o700);

    const temporaryPath = join(
      this.authDir,
      `.${CODEX_CREDENTIAL_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;

    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(credentials)}\n`, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await rename(temporaryPath, this.credentialPath);
      renamed = true;
      await fsyncDirectoryBestEffort(this.authDir);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  async clear(): Promise<void> {
    try {
      const authStat = await lstat(this.authDir);
      if (authStat.isSymbolicLink() || !authStat.isDirectory()) return;
      await unlink(this.credentialPath);
      await fsyncDirectoryBestEffort(this.authDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
