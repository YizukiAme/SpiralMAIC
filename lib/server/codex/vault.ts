import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

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
  load(): Promise<CodexOAuthCredentials | null>;
  save(credentials: CodexOAuthCredentials): Promise<void>;
  clear(): Promise<void>;
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

  constructor(options: FileCodexCredentialVaultOptions = {}) {
    const baseDir = options.baseDir ?? join(process.cwd(), 'data');
    this.authDir = join(baseDir, 'auth');
    this.credentialPath = join(this.authDir, CODEX_CREDENTIAL_FILE_NAME);
  }

  async load(): Promise<CodexOAuthCredentials | null> {
    try {
      await chmod(this.authDir, 0o700);
      await chmod(this.credentialPath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    let raw: string;
    try {
      raw = await readFile(this.credentialPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      return isCodexOAuthCredentials(parsed) ? parsed : null;
    } catch {
      // Corrupt and schema-invalid files behave like signed-out state. Never
      // log raw credential contents or parse errors.
      return null;
    }
  }

  async save(credentials: CodexOAuthCredentials): Promise<void> {
    if (!isCodexOAuthCredentials(credentials)) {
      throw new Error('Invalid Codex credential schema');
    }

    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
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
      await handle.sync();
      await handle.close();
      handle = undefined;

      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.credentialPath);
      renamed = true;
      await chmod(this.credentialPath, 0o600);
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
      await unlink(this.credentialPath);
      await fsyncDirectoryBestEffort(this.authDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
