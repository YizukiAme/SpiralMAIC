import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');

describe('Codex OAuth deployment contract', () => {
  it('documents always-on browser and device login without feature flags', () => {
    const env = read('.env.example');
    const deploymentGuide = read('docs/codex-oauth-deployment.md');
    const acceptanceGuide = read('docs/codex-real-account-acceptance.md');

    for (const content of [env, deploymentGuide, acceptanceGuide]) {
      expect(content).not.toContain('OPENMAIC_ENABLE_CODEX_OAUTH');
      expect(content).not.toContain('OPENMAIC_CODEX_BROWSER_LOGIN');
    }
    for (const content of [env, deploymentGuide, acceptanceGuide]) {
      expect(content).not.toMatch(/device[^\n]{0,80}fallback/i);
      expect(content).not.toMatch(/fallback[^\n]{0,80}device/i);
    }
    expect(env).toMatch(/available after installation/i);
    expect(env).toMatch(/browser.*device/i);
    expect(env).toMatch(/Docker\/VPS.*device/i);
    expect(env).toMatch(/production.*ACCESS_CODE/i);
    expect(deploymentGuide).toMatch(/available after installation/i);
    expect(deploymentGuide.indexOf('Sign in with ChatGPT')).toBeGreaterThan(-1);
    expect(deploymentGuide.indexOf('Use device code')).toBeGreaterThan(
      deploymentGuide.indexOf('Sign in with ChatGPT'),
    );
  });

  it('removes the unreachable feature-disabled reason from runtime contracts', () => {
    const removedReason = ['FEATURE', 'DISABLED'].join('_');

    expect(read('lib/types/codex-auth.ts')).not.toContain(removedReason);
    expect(read('lib/client/codex-oauth.ts')).not.toContain(removedReason);
  });

  it('creates and owns /app/data before switching to UID 1001', () => {
    const dockerfile = read('Dockerfile');
    const mkdirIndex = dockerfile.indexOf('mkdir -p /app/data');
    const chownIndex = dockerfile.indexOf('chown nextjs:nodejs /app/data');
    const userIndex = dockerfile.indexOf('USER nextjs');

    expect(mkdirIndex).toBeGreaterThan(-1);
    expect(chownIndex).toBeGreaterThan(mkdirIndex);
    expect(userIndex).toBeGreaterThan(chownIndex);
  });

  it('retains the persistent compose data volume', () => {
    expect(read('docker-compose.yml')).toContain('openmaic-data:/app/data');
  });
});
