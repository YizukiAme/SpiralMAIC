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

describe('Codex acceptance package contracts', () => {
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
        response.end(JSON.stringify({ success: true, providers: {} }));
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
});
