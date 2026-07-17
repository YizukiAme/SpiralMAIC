import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const removedPaths = [
  'components/demo/featured-demo-course-card.tsx',
  'lib/demo/featured-course.ts',
  'public/demo/firmicutes-obesity.maic.zip',
  'public/demo/firmicutes-obesity-cover.png',
  'scripts/prepare-featured-demo-course.mjs',
];

describe('featured demo course removal', () => {
  it.each(removedPaths)('does not ship %s', (path) => {
    expect(existsSync(resolve(process.cwd(), path))).toBe(false);
  });

  it.each(['lib/import/classroom-import.ts', 'lib/utils/database.ts'])(
    'does not keep featured-demo metadata in %s',
    (path) => {
      expect(readFileSync(resolve(process.cwd(), path), 'utf8')).not.toMatch(/featuredDemo/);
    },
  );
});
