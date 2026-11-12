// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  composerClipboardSerializer,
  docFromPlain,
  plainOfDoc,
} from '@/lib/workbench/composer-doc';

describe('composer clipboard HTML', () => {
  it('copies mentions and skills as readable, escaped text without editor chip markup', () => {
    const label = '@<img src=x onerror=alert(1)>';
    const doc = docFromPlain(`Use /explain with ${label}\nthen continue`, {
      skills: new Map([['explain', 'Explain']]),
      mentions: new Map([[label, { label, kind: 'course', id: 'course-1', name: 'Course' }]]),
      mentionIcon: () => 'course',
    });
    const html = document.createElement('div');
    html.append(composerClipboardSerializer.serializeFragment(doc.content, { document }));

    expect([...html.querySelectorAll('p')].map((p) => p.textContent).join('\n')).toBe(
      plainOfDoc(doc),
    );
    expect(html.querySelector('img')).toBeNull();
    expect(html.querySelector('[data-composer-chip]')).toBeNull();
    expect(html.querySelectorAll('p')).toHaveLength(2);
  });
});
