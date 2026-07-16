import { once } from 'node:events';
import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

async function makeDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spiralmaic-codex-runtime-lock-'));
  temporaryPaths.push(root);
  return join(root, 'data');
}

function lockPath(dataDir: string): string {
  return join(dataDir, 'auth', CODEX_RUNTIME_LOCK_FILE_NAME);
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
  it('refuses a helper lease while a live app process holds the lock', async () => {
    const dataDir = await makeDataDir();
    const app = spawnLockProcess(dataDir, true);
    await expect(firstLine(app)).resolves.toBe('READY');

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
          OPENMAIC_ENABLE_CODEX_OAUTH: 'true',
        },
      }),
    ).resolves.toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.RUNTIME_LOCKED,
      methods: [],
    });
  });

  it('refuses app startup while a live helper lease holds the lock', async () => {
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

  it('reclaims a crashed process lock only after the owner PID is no longer live', async () => {
    const dataDir = await makeDataDir();
    const crashed = spawnLockProcess(dataDir, true);
    await expect(firstLine(crashed)).resolves.toBe('READY');
    crashed.kill('SIGKILL');
    await once(crashed, 'exit');

    const replacement = acquireCodexRuntimeLock({ baseDir: dataDir });
    await expect(access(lockPath(dataDir))).resolves.toBeUndefined();
    replacement.release();
  });

  it('is reentrant in the same PID and retains filesystem ownership after logical release', async () => {
    const dataDir = await makeDataDir();
    const first = acquireCodexRuntimeLock({ baseDir: dataDir });
    const second = acquireCodexRuntimeLock({ baseDir: dataDir });

    first.release();
    await expect(access(lockPath(dataDir))).resolves.toBeUndefined();
    second.release();
    await expect(access(lockPath(dataDir))).resolves.toBeUndefined();

    const contender = spawnLockProcess(dataDir, false);
    await expect(firstLine(contender)).resolves.toBe('LOCKED');
    await once(contender, 'exit');
    expect(contender.exitCode).toBe(2);
  });

  it('fails same-PID reentry when the lock pathname has been replaced with a new inode', async () => {
    const dataDir = await makeDataDir();
    acquireCodexRuntimeLock({ baseDir: dataDir });
    const path = lockPath(dataDir);
    const ownerPayload = await readFile(path, 'utf8');
    const original = await stat(path);

    await rename(path, `${path}.old`);
    await writeFile(path, ownerPayload, { mode: 0o600 });
    const replacement = await stat(path);
    expect(replacement.ino).not.toBe(original.ino);

    expect(() => acquireCodexRuntimeLock({ baseDir: dataDir })).toThrowError(
      expect.objectContaining({ code: 'CODEX_RUNTIME_LOCKED' }),
    );
  });

  it('does not let an exiting old owner pathname-unlink a replacement inode', async () => {
    const dataDir = await makeDataDir();
    const app = spawnLockProcess(dataDir, true);
    await expect(firstLine(app)).resolves.toBe('READY');
    const path = lockPath(dataDir);
    const ownerPayload = await readFile(path, 'utf8');

    await rename(path, `${path}.old`);
    await writeFile(path, ownerPayload, { mode: 0o600 });
    const replacement = await stat(path);

    app.stdin.write('exit\n');
    await once(app, 'exit');
    expect(app.exitCode).toBe(0);
    await expect(stat(path)).resolves.toMatchObject({ ino: replacement.ino });
  });

  it('leaves an orderly-exit tombstone that the next process reclaims after PID death', async () => {
    const dataDir = await makeDataDir();
    const app = spawnLockProcess(dataDir, false);

    await expect(firstLine(app)).resolves.toBe('READY');
    await once(app, 'exit');
    expect(app.exitCode).toBe(0);
    const departed = await stat(lockPath(dataDir));

    const replacement = acquireCodexRuntimeLock({ baseDir: dataDir });
    const current = await stat(lockPath(dataDir));
    expect(current.ino).not.toBe(departed.ino);
    replacement.release();
    await expect(access(lockPath(dataDir))).resolves.toBeUndefined();
  });
});
