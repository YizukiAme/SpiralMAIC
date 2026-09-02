import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('prompt client boundary', () => {
  it('marks the Node prompt loader as server-only', () => {
    expect(source('lib/prompts/loader.ts')).toMatch(/import ['"]server-only['"]/);
  });

  it('keeps revisit artifact options free of prompt and server imports', () => {
    const artifactOptions = source('lib/revisit/artifact-options.ts');
    expect(artifactOptions).not.toMatch(/from ['"][^'"]*(?:prompts|artifacts)['"]/);
    expect(artifactOptions).not.toMatch(/from ['"](?:node:|fs|path)/);
  });
});
