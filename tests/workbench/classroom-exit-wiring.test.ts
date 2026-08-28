import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('classroom exit wiring', () => {
  it.each([
    { path: 'components/header.tsx', ariaLabel: 'backLabel' },
    { path: 'components/edit/EditShell/CommandBar.tsx', ariaLabel: 'exitLabel' },
  ])('%s uses the shared exit helper and has no hardcoded home push', ({ path, ariaLabel }) => {
    const text = source(path);
    expect(text).toContain('exitClassroom(router, searchParams)');
    expect(text).toContain('classroomExitLabelKey(searchParams)');
    if (path === 'components/header.tsx') {
      expect(text).toContain("const backLabel = onBack ? t('generation.backToHome') : exitLabel");
    }
    expect(text).toContain(`aria-label={${ariaLabel}}`);
    expect(text).not.toContain("router.push('/')");
    expect(text).not.toContain("title={t('generation.backToHome')}");
  });
});
