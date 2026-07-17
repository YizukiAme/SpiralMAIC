import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function runPnpm(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('pnpm', args, { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('Codex acceptance package and documentation contracts', () => {
  it('exposes package scripts whose TypeScript entry points exist', async () => {
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['accept:codex']).toBe(
      'node --no-warnings --import tsx scripts/codex-acceptance.ts',
    );
    expect(pkg.scripts['refresh:codex']).toBe(
      'node --no-warnings --import tsx scripts/codex-force-refresh.ts',
    );
    await expect(access(resolve('scripts/codex-acceptance.ts'))).resolves.toBeUndefined();
    await expect(access(resolve('scripts/codex-force-refresh.ts'))).resolves.toBeUndefined();
  });

  it('keeps quiet package PASS/FAIL output machine-readable with an empty stderr', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/access-code/status') {
        response.end(JSON.stringify({ success: true, enabled: false, authenticated: false }));
      } else if (request.url === '/api/codex/auth') {
        response.end(
          JSON.stringify({
            available: true,
            reason: 'AVAILABLE',
            methods: ['device'],
            connected: false,
          }),
        );
      } else if (request.url === '/api/server-providers') {
        response.end(JSON.stringify({ success: true, providers: {}, image: {} }));
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server missing address');
      const pass = await runPnpm([
        '--silent',
        'accept:codex',
        '--',
        '--base-url',
        `http://127.0.0.1:${address.port}`,
        '--expect-signed-out',
      ]);
      expect(pass.code).toBe(0);
      expect(pass.stderr).toBe('');
      expect(pass.stdout.trim().split('\n')).toHaveLength(3);
      for (const line of pass.stdout.trim().split('\n')) {
        expect(line).toMatch(
          /^(PASS|FAIL|SKIP) stage=[a-z0-9-]+(?: [A-Za-z]+=[A-Za-z0-9._:/-]+)*$/,
        );
      }

      const fail = await runPnpm([
        '--silent',
        'accept:codex',
        '--',
        '--base-url',
        'http://127.0.0.1:1',
      ]);
      expect(fail).toEqual({
        code: 1,
        stdout: 'FAIL stage=access-session error=network\n',
        stderr: '',
      });

      const refreshFail = await runPnpm([
        '--silent',
        'refresh:codex',
        '--',
        '--base-url',
        'http://localhost:3000',
      ]);
      expect(refreshFail).toEqual({
        code: 1,
        stdout: 'FAIL stage=offline-force-refresh error=confirmation-required\n',
        stderr: '',
      });
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  });

  it('documents the bounded deployment topology and explicit exclusions', async () => {
    const deployment = await readFile(resolve('docs/codex-oauth-deployment.md'), 'utf8');

    expect(deployment).toMatch(/experimental/i);
    expect(deployment).toMatch(/single-user/i);
    expect(deployment).toMatch(/single\s+Node process/i);
    expect(deployment).toMatch(/replica=1/);
    expect(deployment).toMatch(/\/app\/data/);
    expect(deployment).toMatch(/no serverless/i);
    expect(deployment).toMatch(/no shared-volume horizontal scaling/i);
    expect(deployment).toMatch(/priority service tier/i);
    expect(deployment).toMatch(/entitlement-dependent/i);
    for (const exclusion of ['WebSocket', 'multi-account', 'multi-instance', 'thread-id']) {
      expect(deployment).toContain(exclusion);
    }
    expect(deployment).toContain('gpt-image-2');
    for (const size of ['1536x864', '1024x768', '1024x1024', '864x1536']) {
      expect(deployment).toContain(size);
    }
    expect(deployment).toMatch(/3–5x faster/i);
    expect(deployment).toMatch(/fails closed/i);
    for (const exclusion of [
      'reference-image',
      'multi-image',
      'transparent background',
      '2K/4K UI',
      'image-model discovery',
      'Responses API fallback',
      'CLIProxyAPI',
    ]) {
      expect(deployment).toContain(exclusion);
    }
  });

  it('documents safe actual image dimensions without promoting backend drift to a contract', async () => {
    const deployment = await readFile(resolve('docs/codex-oauth-deployment.md'), 'utf8');
    const runbook = await readFile(resolve('docs/codex-real-account-acceptance.md'), 'utf8');

    expect(deployment).toMatch(/requested size hints/i);
    expect(deployment).toMatch(/request\/response\/ratio\s+drift is soft/i);
    expect(deployment).toMatch(/PNG IHDR[\s\S]*actual (?:image )?dimensions/i);
    expect(deployment).toMatch(/20 MiB/);
    expect(deployment).toMatch(/8,192 pixels/);
    expect(deployment).toMatch(/16,777,216 pixels/);
    expect(deployment).toMatch(/exact aspect ratio[\s\S]*post-success[\s\S]*(?:crop|resize)/i);
    expect(deployment).toMatch(/rather than[\s\S]*502`?\s+rejection/i);

    const observation =
      runbook.match(
        /### Single non-contractual manual incident observation[\s\S]*?(?=\n## |\n### |$)/i,
      )?.[0] ?? '';
    expect(observation).toContain('observed_at: `2026-07-16`');
    expect(observation).toContain('request_size: `1024x1024`');
    expect(observation).toContain('HTTP: `200`');
    expect(observation).toContain('response_size: `1254x1254`');
    expect(observation).toContain('PNG IHDR: `1254x1254`');
    expect(observation).toContain('quality: `low`');
    expect(observation).toMatch(/raw response was not retained/i);
    expect(observation).not.toMatch(/\b(?:prompt|base64|account|request[_ -]?id)\s*:/i);
  });

  it('documents every manual real-account acceptance phase and says it is not CI', async () => {
    const runbook = await readFile(resolve('docs/codex-real-account-acceptance.md'), 'utf8');

    expect(runbook).toMatch(/not\s+(?:a\s+)?CI/i);
    expect(runbook).toMatch(/browser PKCE/i);
    expect(runbook).toMatch(/device.code/i);
    expect(runbook).toContain('pnpm --silent accept:codex -- --base-url http://localhost:3000');
    expect(runbook).toContain('--editor-mode disabled');
    expect(runbook).toContain(
      'pnpm --silent refresh:codex -- --base-url http://localhost:3000 --confirm-app-stopped',
    );
    expect(runbook).toContain('--expect-signed-out');
    expect(runbook).toContain('--confirm-app-stopped');
    expect(runbook).toContain(
      'pnpm --silent accept:codex -- --base-url http://localhost:3000 --include-image',
    );
    expect(runbook).toMatch(/exactly one[\s\S]*existing failed-image[\s\S]*Retry/i);
    expect(runbook).toMatch(/do not[\s\S]*--include-image[\s\S]*same cycle/i);
    expect(runbook).toMatch(/never[\s\S]*direct upstream probe/i);
    expect(runbook).toMatch(/one local `\/api\/generate\/image` request/i);
    expect(runbook).toMatch(/second upstream POST only after[\s\S]*401[\s\S]*refresh/i);
    expect(runbook).toMatch(
      /no[\s\S]*429[\s\S]*5xx[\s\S]*network[\s\S]*timeout[\s\S]*retr(?:y|ies)/i,
    );
    expect(runbook).toMatch(/model ID, MIME type, and dimensions/i);
    expect(runbook).toMatch(/never\s+prints the prompt, image\/base64 payload/i);
    expect(runbook).toMatch(/stop.*app/i);
    expect(runbook).toMatch(/two vault writers/i);
    expect(runbook).toMatch(/restart/i);
    expect(runbook).toMatch(/named volume/i);
    expect(runbook).toMatch(/logout/i);
    expect(runbook).toMatch(/cache deletion/i);
    expect(runbook).toMatch(/provider fallback/i);
    expect(runbook).toMatch(/relogin/i);
    expect(runbook).toMatch(/log[\s\S]*localStorage[\s\S]*git diff/i);
  });

  it('documents unique-claim ownership, PID reuse, and fail-closed scope recovery', async () => {
    const deployment = await readFile(resolve('docs/codex-oauth-deployment.md'), 'utf8');
    const runbook = await readFile(resolve('docs/codex-real-account-acceptance.md'), 'utf8');

    expect(deployment).toMatch(/private lock directory/i);
    expect(deployment).toMatch(/unique claim/i);
    expect(deployment).toMatch(/process start identity/i);
    expect(deployment).toMatch(/PID reuse/i);
    expect(deployment).toMatch(/unverifiable[\s\S]*fail(?:s)? closed/i);
    expect(deployment).toMatch(/scoped[\s\S]*unlink[\s\S]*own/i);
    expect(deployment).toContain('.openmaic-codex-runtime.lock');
    expect(deployment).toMatch(/legacy v1 lock file[\s\S]*stop[\s\S]*verify[\s\S]*remove/i);
    expect(runbook).toMatch(/docker compose restart/i);
    expect(runbook).toMatch(/next process[\s\S]*reclaims[\s\S]*unique claim/i);
  });

  it('uses one quiet fail-closed secret shape for log, storage, staged, and unstaged scans', async () => {
    const runbook = await readFile(resolve('docs/codex-real-account-acceptance.md'), 'utf8');
    const shellPattern = runbook.match(/CODEX_SECRET_PATTERN='([^'\n]+)'/)?.[1];
    const browserPattern = runbook.match(
      /const secretPattern = new RegExp\(String\.raw`([^`\n]+)`, 'i'\)/,
    )?.[1];

    expect(typeof shellPattern).toBe('string');
    expect(browserPattern).toBe(shellPattern);
    const pattern = new RegExp(shellPattern!, 'i');
    const representativeSentinels = [
      '{"access_token":"sentinelAccess123"}',
      '{"accessToken":"sentinelAccess456"}',
      '{"refresh_token":"sentinelRefresh123"}',
      '{"refreshToken":"sentinelRefresh456"}',
      '{"account_id":"sentinelAccount123"}',
      '{"accountId":"sentinelAccount456"}',
      '{"account_scope":"sentinelScope123"}',
      '{"accountScope":"sentinelScope456"}',
      '{"scope":"openid-profile"}',
      '{"device_auth_id":"sentinelDevice123"}',
      '{"deviceAuthId":"sentinelDevice456"}',
      '{"device_authorization_id":"sentinelDevice789"}',
      '{"deviceAuthorizationId":"sentinelDevice987"}',
      '{"code_verifier":"sentinelVerifier123"}',
      '{"codeVerifier":"sentinelVerifier456"}',
      '{"pkce_verifier":"sentinelPkce123"}',
      '{"pkceVerifier":"sentinelPkce456"}',
      'Cookie: session=sentinelCookie123',
      'openmaic_access=sentinelCookie456',
      'Authorization: Bearer sentinelBearer123456',
      'eyJhbGciOiJub25lIn0abcde.eyJzdWIiOiJzZW50aW5lbCJ9.signature',
    ];
    // Aggregate the assertion so a failure never prints the matched sentinel.
    expect(representativeSentinels.every((value) => pattern.test(value))).toBe(true);
    expect(runbook).toContain('rg -q -i -- "$CODEX_SECRET_PATTERN"');
    expect(runbook).toContain('>/dev/null 2>&1');
    expect(runbook).toMatch(/git diff --no-ext-diff HEAD/);
    expect(runbook).toMatch(/staged and unstaged/i);
  });
});
