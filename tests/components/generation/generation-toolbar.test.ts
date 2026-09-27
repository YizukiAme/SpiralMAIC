import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { GenerationToolbar } from '@/components/generation/generation-toolbar';

describe('generation toolbar accessibility', () => {
  it('gives the empty material upload button an accessible name', () => {
    const html = renderToStaticMarkup(
      createElement(GenerationToolbar, {
        courseMaterials: [],
        onCourseMaterialsAdd: () => {},
        onCourseMaterialRemove: () => {},
        onPdfError: () => {},
      }),
    );

    expect(html).toMatch(/<button[^>]*aria-label="toolbar.courseMaterialUpload"/);
  });
});
