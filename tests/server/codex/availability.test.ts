import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_OAUTH_AVAILABILITY_REASONS,
  getCodexOAuthAvailability,
} from '@/lib/server/codex/availability';

const temporaryPaths: string[] = [];

async function makeTemporaryPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'spiralmaic-codex-availability-'));
  temporaryPaths.push(path);
  return path;
}

function createEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    OPENMAIC_ENABLE_CODEX_OAUTH: 'true',
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('getCodexOAuthAvailability', () => {
  it('defaults off and returns no login methods', async () => {
    const dataDir = await makeTemporaryPath();

    const result = await getCodexOAuthAvailability({
      env: createEnv({ OPENMAIC_ENABLE_CODEX_OAUTH: undefined }),
      dataDir,
    });

    expect(result).toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.FEATURE_DISABLED,
      methods: [],
    });
  });

  it('offers device login in development without an access code', async () => {
    const dataDir = await makeTemporaryPath();

    await expect(getCodexOAuthAvailability({ env: createEnv(), dataDir })).resolves.toEqual({
      available: true,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.AVAILABLE,
      methods: ['device'],
    });
  });

  it('offers browser login only when its local-only flag is enabled', async () => {
    const dataDir = await makeTemporaryPath();

    const result = await getCodexOAuthAvailability({
      env: createEnv({ OPENMAIC_CODEX_BROWSER_LOGIN: 'true' }),
      dataDir,
    });

    expect(result.methods).toEqual(['browser', 'device']);
  });

  it('requires ACCESS_CODE in production', async () => {
    const dataDir = await makeTemporaryPath();

    const withoutAccessCode = await getCodexOAuthAvailability({
      env: createEnv({ NODE_ENV: 'production', ACCESS_CODE: undefined }),
      dataDir,
    });
    const withAccessCode = await getCodexOAuthAvailability({
      env: createEnv({ NODE_ENV: 'production', ACCESS_CODE: 'configured' }),
      dataDir,
    });

    expect(withoutAccessCode).toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.ACCESS_CODE_REQUIRED,
      methods: [],
    });
    expect(withAccessCode.available).toBe(true);
  });

  it.each([
    ['Vercel', { VERCEL: '1' }],
    ['AWS Lambda', { AWS_LAMBDA_FUNCTION_NAME: 'spiralmaic' }],
    ['Netlify', { NETLIFY: 'true' }],
  ])('is unavailable on %s', async (_name, serverlessEnv) => {
    const dataDir = await makeTemporaryPath();

    const result = await getCodexOAuthAvailability({
      env: createEnv(serverlessEnv),
      dataDir,
    });

    expect(result).toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.SERVERLESS_UNSUPPORTED,
      methods: [],
    });
  });

  it('is unavailable when the data directory cannot be created', async () => {
    const baseDir = await makeTemporaryPath();
    const dataDir = join(baseDir, 'not-a-directory');
    await writeFile(dataDir, 'occupied');

    const result = await getCodexOAuthAvailability({ env: createEnv(), dataDir });

    expect(result).toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.DATA_DIR_UNWRITABLE,
      methods: [],
    });
  });

  it('is unavailable when auth is a writable file rather than a directory', async () => {
    const dataDir = await makeTemporaryPath();
    const occupiedPath = join(dataDir, 'occupied');
    await writeFile(occupiedPath, 'not a directory');
    await symlink(occupiedPath, join(dataDir, 'auth'));

    const result = await getCodexOAuthAvailability({ env: createEnv(), dataDir });

    expect(result).toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.DATA_DIR_UNWRITABLE,
      methods: [],
    });
  });

  it('rejects a symlinked auth directory without touching its external target', async () => {
    const dataDir = await makeTemporaryPath();
    const externalDir = await makeTemporaryPath();
    const sentinelPath = join(externalDir, 'sentinel.txt');
    await writeFile(sentinelPath, 'unchanged');
    await symlink(externalDir, join(dataDir, 'auth'));

    const result = await getCodexOAuthAvailability({ env: createEnv(), dataDir });

    expect(result).toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.DATA_DIR_UNWRITABLE,
      methods: [],
    });
    expect(await readFile(sentinelPath, 'utf8')).toBe('unchanged');
    expect(await readdir(externalDir)).toEqual(['sentinel.txt']);
  });

  it('requires enough directory permissions to create a private probe file', async () => {
    const dataDir = await makeTemporaryPath();
    const authDir = join(dataDir, 'auth');
    await mkdir(authDir);
    await chmod(authDir, 0o200);

    const result = await getCodexOAuthAvailability({ env: createEnv(), dataDir });
    await chmod(authDir, 0o700);

    expect(result).toEqual({
      available: false,
      reason: CODEX_OAUTH_AVAILABILITY_REASONS.DATA_DIR_UNWRITABLE,
      methods: [],
    });
  });
});
