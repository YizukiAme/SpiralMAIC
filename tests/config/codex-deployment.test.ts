import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');

describe('Codex OAuth deployment contract', () => {
  it('documents both flags, deployment modes, and production ACCESS_CODE requirement', () => {
    const env = read('.env.example');

    expect(env).toContain('OPENMAIC_ENABLE_CODEX_OAUTH=');
    expect(env).toContain('OPENMAIC_CODEX_BROWSER_LOGIN=');
    expect(env).toMatch(/local bare-metal/i);
    expect(env).toMatch(/Docker\/VPS.*device/i);
    expect(env).toMatch(/production.*ACCESS_CODE/i);
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
