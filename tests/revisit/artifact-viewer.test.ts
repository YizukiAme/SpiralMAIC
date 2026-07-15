import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RichBlockDocument } from '@/components/revisit/artifact-viewer/rich-blocks';
import { getStudyArtifactViewerLayout } from '@/lib/revisit/artifact-view';
import type { StudyArtifactRichBlock } from '@/lib/revisit/types';

describe('study artifact viewer layouts', () => {
  it('maps all artifact kinds to their intended visual shell', () => {
    expect(getStudyArtifactViewerLayout('briefing')).toBe('paper');
    expect(getStudyArtifactViewerLayout('mindMap')).toBe('canvas');
    expect(getStudyArtifactViewerLayout('studyGuide')).toBe('document');
    expect(getStudyArtifactViewerLayout('faq')).toBe('document');
    expect(getStudyArtifactViewerLayout('flashcards')).toBe('practice');
    expect(getStudyArtifactViewerLayout('quiz')).toBe('practice');
  });
});

describe('semantic study artifact HTML', () => {
  it('renders controlled blocks as semantic HTML rather than Markdown source', () => {
    const blocks: StudyArtifactRichBlock[] = [
      { type: 'heading', text: 'Core idea', level: 2 },
      { type: 'paragraph', text: 'A subject identifies who or what.' },
      { type: 'definition', term: 'Subject', definition: 'Who or what the sentence is about.' },
      {
        type: 'table',
        title: 'Compare',
        columns: ['Form', 'Role'],
        rows: [{ cells: ['Noun', 'Names a thing'] }],
      },
    ];

    const html = renderToStaticMarkup(createElement(RichBlockDocument, { blocks }));

    expect(html).toContain('<h2');
    expect(html).toContain('id="core-idea"');
    expect(html).toContain('<dl');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).not.toContain('## Core idea');
  });

  it('uses a real CSS grid and full-width structural blocks for visual briefings', () => {
    const blocks: StudyArtifactRichBlock[] = [
      { type: 'heading', text: 'Core idea', level: 2 },
      { type: 'definition', term: 'Subject', definition: 'Who or what.' },
      {
        type: 'comparison',
        title: 'Compare',
        leftLabel: 'Subject',
        leftText: 'Names the topic.',
        rightLabel: 'Predicate',
        rightText: 'Explains the topic.',
      },
    ];

    const html = renderToStaticMarkup(
      createElement(RichBlockDocument, { blocks, variant: 'briefing' }),
    );

    expect(html).toContain('grid grid-cols-2');
    expect(html).toContain('col-span-full');
  });
});
