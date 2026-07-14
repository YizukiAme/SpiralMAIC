import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const CODEX_OAUTH_AVAILABILITY_REASONS = {
  AVAILABLE: 'AVAILABLE',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  SERVERLESS_UNSUPPORTED: 'SERVERLESS_UNSUPPORTED',
  ACCESS_CODE_REQUIRED: 'ACCESS_CODE_REQUIRED',
  DATA_DIR_UNWRITABLE: 'DATA_DIR_UNWRITABLE',
} as const;

export type CodexOAuthAvailabilityReason =
  (typeof CODEX_OAUTH_AVAILABILITY_REASONS)[keyof typeof CODEX_OAUTH_AVAILABILITY_REASONS];

export type CodexOAuthLoginMethod = 'browser' | 'device';

export interface CodexOAuthAvailability {
  available: boolean;
  reason: CodexOAuthAvailabilityReason;
  methods: CodexOAuthLoginMethod[];
}

interface CodexOAuthAvailabilityOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}

function unavailable(reason: CodexOAuthAvailabilityReason): CodexOAuthAvailability {
  return { available: false, reason, methods: [] };
}

function isServerlessEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.VERCEL === '1' ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.AWS_EXECUTION_ENV?.startsWith('AWS_Lambda_') ||
    env.NETLIFY === 'true' ||
    env.CF_PAGES === '1' ||
    env.FUNCTIONS_WORKER_RUNTIME ||
    env.K_SERVICE,
  );
}

async function canWriteAuthDirectory(dataDir: string): Promise<boolean> {
  const authDir = join(dataDir, 'auth');
  const probeId = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const temporaryPath = join(authDir, `.codex-oauth-probe.${probeId}.tmp`);
  const renamedPath = join(authDir, `.codex-oauth-probe.${probeId}.ready`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    const authStat = await lstat(authDir);
    if (authStat.isSymbolicLink() || !authStat.isDirectory()) return false;
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile('probe', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, renamedPath);
    await unlink(renamedPath);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    await unlink(renamedPath).catch(() => undefined);
  }
}

/**
 * Server-only capability gate for the native Codex OAuth integration.
 * Callers receive stable reason codes suitable for a public status DTO.
 */
export async function getCodexOAuthAvailability(
  options: CodexOAuthAvailabilityOptions = {},
): Promise<CodexOAuthAvailability> {
  const env = options.env ?? process.env;

  if (env.OPENMAIC_ENABLE_CODEX_OAUTH !== 'true') {
    return unavailable(CODEX_OAUTH_AVAILABILITY_REASONS.FEATURE_DISABLED);
  }

  if (isServerlessEnvironment(env)) {
    return unavailable(CODEX_OAUTH_AVAILABILITY_REASONS.SERVERLESS_UNSUPPORTED);
  }

  if (env.NODE_ENV === 'production' && !env.ACCESS_CODE) {
    return unavailable(CODEX_OAUTH_AVAILABILITY_REASONS.ACCESS_CODE_REQUIRED);
  }

  const dataDir = options.dataDir ?? join(process.cwd(), 'data');
  if (!(await canWriteAuthDirectory(dataDir))) {
    return unavailable(CODEX_OAUTH_AVAILABILITY_REASONS.DATA_DIR_UNWRITABLE);
  }

  const methods: CodexOAuthLoginMethod[] =
    env.OPENMAIC_CODEX_BROWSER_LOGIN === 'true' ? ['browser', 'device'] : ['device'];

  return {
    available: true,
    reason: CODEX_OAUTH_AVAILABILITY_REASONS.AVAILABLE,
    methods,
  };
}
