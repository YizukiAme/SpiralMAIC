import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function scriptsIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? scriptsIn(path)
        : Promise.resolve(path.endsWith('.js') ? [path] : []);
    }),
  );
  return files.flat();
}

describe('deployment-hosted Monaco assets', () => {
  it('ships the patched sanitizer instead of Monaco’s vulnerable vendored copy', async () => {
    const files = await scriptsIn(join(process.cwd(), 'public/code-editor/vs'));
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const versions = sources.flatMap((source) =>
      [...source.matchAll(/DOMPurify (\d+\.\d+\.\d+)/g)].map((match) => match[1]),
    );
    expect(new Set(versions)).toEqual(new Set(['3.4.17']));
  });
});
