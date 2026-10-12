import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise Docker's own ignore matcher, without loading any real private files,
// pulling an image, or starting a container. The fixture image is FROM scratch.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const context = mkdtempSync(join(tmpdir(), 'spiral-context-check-'));
const resource = basename(context).toLowerCase();
const image = `${resource}:test`;
const privatePaths = [
  '.worktrees/local/source.txt',
  '.superpowers/progress.json',
  '.agents/local/instructions.txt',
  '.codex/session.log',
  '.claude/session.log',
  'community/diagram.png',
  'AGENTS.md',
  'CLAUDE.md',
  '.env.local',
];
let imageCreated = false;
let containerCreated = false;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });

try {
  copyFileSync(join(root, '.dockerignore'), join(context, '.dockerignore'));
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /context\n');
  for (const path of [...privatePaths, 'public/keep.txt', '.env.example']) {
    const target = join(context, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'Synthetic context fixture\n');
  }
  docker('build', '--network=none', '--tag', image, context);
  imageCreated = true;
  docker('create', '--name', resource, image, '/not-started');
  containerCreated = true;
  const archive = execFileSync('docker', ['export', resource]);
  const paths = new Set(
    execFileSync('tar', ['-tf', '-'], { input: archive, encoding: 'utf8' }).trim().split('\n'),
  );
  assert(paths.has('context/public/keep.txt'), 'Public runtime files must stay in the context');
  assert(paths.has('context/.env.example'), 'Placeholder configuration must stay in the context');
  for (const path of privatePaths) {
    assert(!paths.has(`context/${path}`), `Private/local path entered the Docker context: ${path}`);
  }
  console.log('Docker context privacy contract passed.');
} finally {
  if (containerCreated) docker('rm', resource);
  if (imageCreated) docker('image', 'rm', image);
  rmSync(context, { recursive: true, force: true });
}
