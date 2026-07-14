import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_CREDENTIAL_FILE_NAME,
  FileCodexCredentialVault,
  type CodexOAuthCredentials,
} from '@/lib/server/codex/vault';

const temporaryPaths: string[] = [];

async function makeBaseDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'spiralmaic-codex-vault-'));
  temporaryPaths.push(path);
  return path;
}

function credentials(overrides: Partial<CodexOAuthCredentials> = {}): CodexOAuthCredentials {
  return {
    version: 1,
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 1_800_000_000_000,
    accountId: 'account-123',
    email: 'user@example.com',
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('FileCodexCredentialVault', () => {
  it('stores credentials under data/auth with private real filesystem permissions', async () => {
    const baseDir = await makeBaseDir();
    const vault = new FileCodexCredentialVault({ baseDir });
    const expected = credentials();

    await vault.save(expected);

    const authDir = join(baseDir, 'auth');
    const credentialPath = join(authDir, CODEX_CREDENTIAL_FILE_NAME);
    expect(await vault.load()).toEqual(expected);
    expect((await stat(authDir)).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it('treats corrupt or schema-invalid files as missing without logging their contents', async () => {
    const baseDir = await makeBaseDir();
    const authDir = join(baseDir, 'auth');
    await mkdir(authDir, { recursive: true });
    const credentialPath = join(authDir, CODEX_CREDENTIAL_FILE_NAME);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const vault = new FileCodexCredentialVault({ baseDir });

    await writeFile(credentialPath, '{"accessToken":"must-not-be-logged"');
    await expect(vault.load()).resolves.toBeNull();

    await writeFile(
      credentialPath,
      JSON.stringify({ ...credentials(), version: 2, idToken: 'must-not-be-kept' }),
    );
    await expect(vault.load()).resolves.toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('atomically replaces the credential file without leaving temporary files', async () => {
    const baseDir = await makeBaseDir();
    const vault = new FileCodexCredentialVault({ baseDir });

    await vault.save(credentials());
    await vault.save(credentials({ accessToken: 'rotated-access' }));

    const authDir = join(baseDir, 'auth');
    expect(await readdir(authDir)).toEqual([CODEX_CREDENTIAL_FILE_NAME]);
    expect(
      JSON.parse(await readFile(join(authDir, CODEX_CREDENTIAL_FILE_NAME), 'utf8')),
    ).toMatchObject({
      accessToken: 'rotated-access',
    });
  });

  it('repairs overly broad existing permissions before returning credentials', async () => {
    const baseDir = await makeBaseDir();
    const vault = new FileCodexCredentialVault({ baseDir });
    await vault.save(credentials());
    await chmod(vault.authDir, 0o755);
    await chmod(vault.credentialPath, 0o644);

    await expect(vault.load()).resolves.toEqual(credentials());

    expect((await stat(vault.authDir)).mode & 0o777).toBe(0o700);
    expect((await stat(vault.credentialPath)).mode & 0o777).toBe(0o600);
  });

  it('surfaces filesystem read failures instead of treating them as signed-out state', async () => {
    const baseDir = await makeBaseDir();
    const vault = new FileCodexCredentialVault({ baseDir });
    await vault.save(credentials());
    await rm(vault.credentialPath);
    await mkdir(vault.credentialPath);

    try {
      await expect(vault.load()).rejects.toMatchObject({ code: 'EISDIR' });
    } finally {
      await chmod(vault.credentialPath, 0o700);
    }
  });

  it('clears credentials idempotently', async () => {
    const baseDir = await makeBaseDir();
    const vault = new FileCodexCredentialVault({ baseDir });
    await vault.save(credentials());

    await vault.clear();
    await vault.clear();

    await expect(vault.load()).resolves.toBeNull();
  });

  it('never falls back to the Codex CLI credential file', async () => {
    const baseDir = await makeBaseDir();
    const fakeHome = await makeBaseDir();
    await mkdir(join(fakeHome, '.codex'), { recursive: true });
    await writeFile(join(fakeHome, '.codex', 'auth.json'), JSON.stringify(credentials()));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    const vault = new FileCodexCredentialVault({ baseDir });

    await expect(vault.load()).resolves.toBeNull();
  });
});
