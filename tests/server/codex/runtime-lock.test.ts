import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_RUNTIME_LOCK_FILE_NAME,
  acquireCodexRuntimeLock,
} from '@/lib/server/codex/runtime-lock';
import {
  CODEX_OAUTH_AVAILABILITY_REASONS,
  getCodexOAuthAvailability,
} from '@/lib/server/codex/availability';

const temporaryPaths: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const runtimeModuleUrl = pathToFileURL(resolve('lib/server/codex/runtime.ts')).href;

interface PersistedClaim {
  version: 2;
  nonce: string;
  identity: {
    platform: string;
    scope: string;
    pid: number;
    start: string;
  };
}

async function makeDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spiralmaic-codex-runtime-lock-'));
  temporaryPaths.push(root);
  return join(root, 'data');
}

function lockDirectory(dataDir: string): string {
  return join(dataDir, 'auth', CODEX_RUNTIME_LOCK_FILE_NAME);
}

async function claimPaths(dataDir: string): Promise<string[]> {
  const directory = lockDirectory(dataDir);
  return (await readdir(directory))
    .filter((name) => /^claim-[a-f0-9]{32}\.json$/.test(name))
    .map((name) => join(directory, name))
    .sort();
}

async function readOnlyClaim(dataDir: string): Promise<{ path: string; claim: PersistedClaim }> {
  const paths = await claimPaths(dataDir);
  expect(paths).toHaveLength(1);
  return {
    path: paths[0],
    claim: JSON.parse(await readFile(paths[0], 'utf8')) as PersistedClaim,
  };
}

function nextStart(start: string): string {
  return /^\d+$/.test(start) ? String(Number(start) + 1) : `${start}-replacement`;
}

function spawnLockProcess(dataDir: string, hold: boolean): ChildProcessWithoutNullStreams {
  const source = `
    process.chdir(process.env.TEST_CODEX_WORK_DIR);
    const importedRuntime = await import(${JSON.stringify(runtimeModuleUrl)});
    const runtime = importedRuntime.default ?? importedRuntime;
    try {
      runtime.getCodexAuthRuntime();
      process.stdout.write('READY\\n');
      if (${hold ? 'true' : 'false'}) {
        process.stdin.resume();
        process.stdin.once('data', () => process.exit(0));
      }
    } catch (error) {
      process.stdout.write(error?.code === 'CODEX_RUNTIME_LOCKED' ? 'LOCKED\\n' : 'FAILED\\n');
      process.exitCode = 2;
    }
  `;
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      env: { ...process.env, TEST_CODEX_WORK_DIR: resolve(dataDir, '..') },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk.toString();
    const newline = output.indexOf('\n');
    if (newline >= 0) return output.slice(0, newline);
  }
  return output;
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => once(child, 'exit').catch(() => undefined)));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Codex cross-process runtime lock', () => {
  it('uses the legacy coordination pathname and fails closed on a v1 lock file', async () => {
    const dataDir = await makeDataDir();
    const authDir = join(dataDir, 'auth');
    const legacyLockPath = join(authDir, '.openmaic-codex-runtime.lock');
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    await writeFile(
      legacyLockPath,
      `${JSON.stringify({ version: 1, pid: process.pid, nonce: '5'.repeat(32) })}\n`,
      { mode: 0o600 },
    );

    expect(CODEX_RUNTIME_LOCK_FILE_NAME).toBe('.openmaic-codex-runtime.lock');
    expect(() => acquireCodexRuntimeLock({ baseDir: dataDir })).toThrowError(
      expect.objectContaining({ code: 'CODEX_RUNTIME_LOCK_UNAVAILABLE' }),
    );
    await expect(stat(legacyLockPath)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('makes a v2 claim directory block a legacy v1 publisher at the same pathname', async () => {
    const dataDir = await makeDataDir();
    const lease = acquireCodexRuntimeLock({ baseDir: dataDir });
    const preparedLegacyOwner = join(dataDir, 'auth', '.legacy-owner.tmp');
    await writeFile(preparedLegacyOwner, 'legacy owner\n', { mode: 0o600 });

    await expect(link(preparedLegacyOwner, lockDirectory(dataDir))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect((await stat(lockDirectory(dataDir))).isDirectory()).toBe(true);
    lease.release();
  });

  it('publishes a private claim directory and refuses a helper while a live app owns it', async () => {
    const dataDir = await makeDataDir();
    const app = spawnLockProcess(dataDir, true);
    await expect(firstLine(app)).resolves.toBe('READY');

    const directoryStat = await stat(lockDirectory(dataDir));
    expect(directoryStat.isDirectory()).toBe(true);
    expect(directoryStat.mode & 0o077).toBe(0);
    const { path: claimPath, claim } = await readOnlyClaim(dataDir);
    expect(await readdir(lockDirectory(dataDir))).toEqual([
      claimPath.slice(claimPath.lastIndexOf('/') + 1),
    ]);
    expect(await readdir(lockDirectory(dataDir))).not.toContain('owner');
    expect(claim).toMatchObject({
      version: 2,
      nonce: expect.stringMatching(/^[a-f0-9]{32}$/),
      identity: {
        platform: expect.stringMatching(/^(linux|darwin)$/),
        scope: expect.stringMatching(/^[a-f0-9]{64}$/),
        pid: app.pid,
        start: expect.any(String),
      },
    });

    expect(() => acquireCodexRuntimeLock({ baseDir: dataDir })).toThrowError(
      expect.objectContaining({ code: 'CODEX_RUNTIME_LOCKED' }),
    );
  });

  it('reports provider availability as safely locked while another app process is live', async () => {
    const dataDir = await makeDataDir();
    const app = spawnLockProcess(dataDir, true);
    await expect(firstLine(app)).resolves.toBe('READY');

    await expect(
      getCodexOAuthAvailability({
        dataDir,
        env: {
          NODE_ENV: 'development',
        },
      }),
    ).resolves.toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.RUNTIME_LOCKED,
      methods: [],
    });
  });

  it('refuses app startup while a live helper lease holds the claim', async () => {
    const dataDir = await makeDataDir();
    const helperLease = acquireCodexRuntimeLock({ baseDir: dataDir });
    const app = spawnLockProcess(dataDir, false);
    let stderr = '';
    app.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    await expect(firstLine(app)).resolves.toBe('LOCKED');
    await once(app, 'exit');
    expect(app.exitCode).toBe(2);
    expect(stderr).toBe('');
    helperLease.release();
  });

  it('reclaims only a crashed process unique claim after its verified identity is dead', async () => {
    const dataDir = await makeDataDir();
    const crashed = spawnLockProcess(dataDir, true);
    await expect(firstLine(crashed)).resolves.toBe('READY');
    const departed = await readOnlyClaim(dataDir);
    crashed.kill('SIGKILL');
    await once(crashed, 'exit');

    const replacement = acquireCodexRuntimeLock({ baseDir: dataDir });
    const current = await readOnlyClaim(dataDir);
    expect(current.path).not.toBe(departed.path);
    await expect(access(departed.path)).rejects.toMatchObject({ code: 'ENOENT' });
    replacement.release();
  });

  it('is reentrant in one process and removes only its own claim on final scoped release', async () => {
    const dataDir = await makeDataDir();
    const first = acquireCodexRuntimeLock({ baseDir: dataDir });
    const second = acquireCodexRuntimeLock({ baseDir: dataDir });
    const owned = await readOnlyClaim(dataDir);

    first.release();
    await expect(access(owned.path)).resolves.toBeUndefined();
    second.release();
    await expect(access(owned.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(claimPaths(dataDir)).resolves.toEqual([]);

    const contender = spawnLockProcess(dataDir, false);
    await expect(firstLine(contender)).resolves.toBe('READY');
    await once(contender, 'exit');
    expect(contender.exitCode).toBe(0);
  });

  it('fails same-process reentry if its unique claim inode is replaced', async () => {
    const dataDir = await makeDataDir();
    acquireCodexRuntimeLock({ baseDir: dataDir });
    const owned = await readOnlyClaim(dataDir);
    const ownerPayload = await readFile(owned.path, 'utf8');
    const original = await stat(owned.path);

    await rename(owned.path, `${owned.path}.old`);
    await writeFile(owned.path, ownerPayload, { mode: 0o600 });
    const replacement = await stat(owned.path);
    expect(replacement.ino).not.toBe(original.ino);

    expect(() => acquireCodexRuntimeLock({ baseDir: dataDir })).toThrowError(
      expect.objectContaining({ code: 'CODEX_RUNTIME_LOCKED' }),
    );
  });

  it('fails same-process reentry if the fixed claim directory inode is replaced', async () => {
    const dataDir = await makeDataDir();
    acquireCodexRuntimeLock({ baseDir: dataDir });
    const directory = lockDirectory(dataDir);
    await rename(directory, `${directory}.old`);
    await mkdir(directory, { mode: 0o700 });

    expect(() => acquireCodexRuntimeLock({ baseDir: dataDir })).toThrowError(
      expect.objectContaining({ code: 'CODEX_RUNTIME_LOCKED' }),
    );
  });

  it('reclaims a same-PID claim only when the OS process start identity changed', async () => {
    const dataDir = await makeDataDir();
    const lease = acquireCodexRuntimeLock({ baseDir: dataDir });
    const owned = await readOnlyClaim(dataDir);
    lease.release();

    const stale: PersistedClaim = {
      ...owned.claim,
      nonce: '1'.repeat(32),
      identity: {
        ...owned.claim.identity,
        pid: process.pid,
        start: nextStart(owned.claim.identity.start),
      },
    };
    const stalePath = join(lockDirectory(dataDir), `claim-${stale.nonce}.json`);
    await writeFile(stalePath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    const replacement = acquireCodexRuntimeLock({ baseDir: dataDir });
    await expect(access(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readOnlyClaim(dataDir)).claim.identity.pid).toBe(process.pid);
    replacement.release();
  });

  it('fails closed for a valid claim from an unverifiable process scope', async () => {
    const dataDir = await makeDataDir();
    const lease = acquireCodexRuntimeLock({ baseDir: dataDir });
    const owned = await readOnlyClaim(dataDir);
    lease.release();

    const foreign: PersistedClaim = {
      ...owned.claim,
      nonce: '2'.repeat(32),
      identity: { ...owned.claim.identity, scope: '3'.repeat(64) },
    };
    const foreignPath = join(lockDirectory(dataDir), `claim-${foreign.nonce}.json`);
    await writeFile(foreignPath, `${JSON.stringify(foreign)}\n`, { mode: 0o600 });

    expect(() => acquireCodexRuntimeLock({ baseDir: dataDir })).toThrowError(
      expect.objectContaining({ code: 'CODEX_RUNTIME_LOCKED' }),
    );
    await expect(access(foreignPath)).resolves.toBeUndefined();
    await expect(claimPaths(dataDir)).resolves.toEqual([foreignPath]);
  });

  it('fails closed on malformed or unknown final directory entries', async () => {
    const dataDir = await makeDataDir();
    const lease = acquireCodexRuntimeLock({ baseDir: dataDir });
    lease.release();
    const malformed = join(lockDirectory(dataDir), 'unexpected-owner');
    await writeFile(malformed, 'private malformed body', { mode: 0o600 });

    expect(() => acquireCodexRuntimeLock({ baseDir: dataDir })).toThrowError(
      expect.objectContaining({ code: 'CODEX_RUNTIME_LOCKED' }),
    );
    await expect(access(malformed)).resolves.toBeUndefined();
  });

  it('never lets a stale unique claim cleanup move or delete a live successor claim', async () => {
    const dataDir = await makeDataDir();
    const incumbent = spawnLockProcess(dataDir, true);
    await expect(firstLine(incumbent)).resolves.toBe('READY');
    const live = await readOnlyClaim(dataDir);
    const liveStat = await stat(live.path);

    const dead: PersistedClaim = {
      ...live.claim,
      nonce: '4'.repeat(32),
      identity: { ...live.claim.identity, start: nextStart(live.claim.identity.start) },
    };
    const deadPath = join(lockDirectory(dataDir), `claim-${dead.nonce}.json`);
    await writeFile(deadPath, `${JSON.stringify(dead)}\n`, { mode: 0o600 });

    for (let contenderNumber = 0; contenderNumber < 2; contenderNumber += 1) {
      const contender = spawnLockProcess(dataDir, false);
      await expect(firstLine(contender)).resolves.toBe('LOCKED');
      await once(contender, 'exit');
      expect(contender.exitCode).toBe(2);
    }

    await expect(access(deadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(live.path)).resolves.toMatchObject({ ino: liveStat.ino });
    await expect(claimPaths(dataDir)).resolves.toEqual([live.path]);
  });

  it('retains a process-lifetime claim after orderly exit and safely reclaims it on restart', async () => {
    const dataDir = await makeDataDir();
    const app = spawnLockProcess(dataDir, false);
    await expect(firstLine(app)).resolves.toBe('READY');
    await once(app, 'exit');
    expect(app.exitCode).toBe(0);
    const departed = await readOnlyClaim(dataDir);

    const restarted = spawnLockProcess(dataDir, false);
    await expect(firstLine(restarted)).resolves.toBe('READY');
    await once(restarted, 'exit');
    expect(restarted.exitCode).toBe(0);
    const current = await readOnlyClaim(dataDir);
    expect(current.path).not.toBe(departed.path);
    await expect(access(departed.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
