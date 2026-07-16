import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Codex acceptance package and documentation contracts', () => {
  it('exposes package scripts whose TypeScript entry points exist', async () => {
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['accept:codex']).toBe('tsx scripts/codex-acceptance.ts');
    expect(pkg.scripts['refresh:codex']).toBe('tsx scripts/codex-force-refresh.ts');
    await expect(access(resolve('scripts/codex-acceptance.ts'))).resolves.toBeUndefined();
    await expect(access(resolve('scripts/codex-force-refresh.ts'))).resolves.toBeUndefined();
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
    for (const exclusion of ['Images', 'WebSocket', 'multi-account', 'thread-id']) {
      expect(deployment).toContain(exclusion);
    }
  });

  it('documents every manual real-account acceptance phase and says it is not CI', async () => {
    const runbook = await readFile(resolve('docs/codex-real-account-acceptance.md'), 'utf8');

    expect(runbook).toMatch(/not\s+(?:a\s+)?CI/i);
    expect(runbook).toMatch(/browser PKCE/i);
    expect(runbook).toMatch(/device.code/i);
    expect(runbook).toContain('pnpm accept:codex -- --base-url http://localhost:3000');
    expect(runbook).toContain('--expect-signed-out');
    expect(runbook).toContain('--confirm-app-stopped');
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
});
