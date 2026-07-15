import { describe, expect, it } from 'vitest';

import {
  buildStudyGuideSections,
  collectStudyArtifactReferences,
  filterStudyArtifactFaqItems,
  resolveStudyArtifactSourceScenes,
} from '@/lib/revisit/artifact-view';
import type { StudyArtifactFaqItem, StudyArtifactRichBlock } from '@/lib/revisit/types';

describe('study artifact view helpers', () => {
  it('turns level-two headings into collapsible guide sections without losing nested headings', () => {
    const blocks: StudyArtifactRichBlock[] = [
      { type: 'paragraph', text: 'Opening summary.' },
      { type: 'heading', text: 'Core model', level: 2 },
      { type: 'paragraph', text: 'Core explanation.' },
      { type: 'heading', text: 'Worked example', level: 3 },
      { type: 'example', title: 'Try it', explanation: 'Worked solution.' },
      { type: 'heading', text: 'Common traps', level: 2 },
      { type: 'callout', title: 'Watch out', body: 'A common error.', tone: 'pitfall' },
    ];

    const sections = buildStudyGuideSections(blocks, 'Overview');

    expect(sections.map((section) => [section.id, section.title])).toEqual([
      ['overview', 'Overview'],
      ['core-model', 'Core model'],
      ['common-traps', 'Common traps'],
    ]);
    expect(sections[1]?.blocks).toContainEqual({
      type: 'heading',
      text: 'Worked example',
      level: 3,
    });
  });

  it('collects concept and source references from top-level and nested block items', () => {
    const blocks: StudyArtifactRichBlock[] = [
      {
        type: 'list',
        style: 'bulleted',
        conceptIds: ['concept-a'],
        items: [
          {
            text: 'Nested evidence',
            conceptIds: ['concept-b'],
            sourceSceneIds: ['scene-2'],
          },
        ],
      },
      {
        type: 'timeline',
        sourceSceneIds: ['scene-1'],
        entries: [{ label: 'Step 1', text: 'Begin', conceptIds: ['concept-a'] }],
      },
    ];

    expect(collectStudyArtifactReferences(blocks)).toEqual({
      conceptIds: ['concept-a', 'concept-b'],
      sourceSceneIds: ['scene-1', 'scene-2'],
    });
  });

  it('filters FAQ items by text and concept topic together', () => {
    const items: StudyArtifactFaqItem[] = [
      {
        id: 'faq-1',
        question: 'What is a subject?',
        answer: 'The sentence topic.',
        conceptIds: ['subject'],
      },
      {
        id: 'faq-2',
        question: 'What is a predicate?',
        answer: 'What the subject does or is.',
        conceptIds: ['predicate'],
      },
    ];

    expect(filterStudyArtifactFaqItems(items, 'does', 'predicate')).toEqual([items[1]]);
    expect(filterStudyArtifactFaqItems(items, 'subject', null)).toEqual(items);
  });

  it('resolves source ids to one-based display order and current scene titles', () => {
    const scenes = [
      { id: 'scene-b', title: 'Predicate', order: 20 },
      { id: 'scene-a', title: 'Subject', order: 10 },
    ];

    expect(
      resolveStudyArtifactSourceScenes(['scene-a', 'scene-b', 'removed-scene'], scenes),
    ).toEqual([
      { id: 'scene-a', pageNumber: 1, title: 'Subject', missing: false },
      { id: 'scene-b', pageNumber: 2, title: 'Predicate', missing: false },
      { id: 'removed-scene', pageNumber: null, title: null, missing: true },
    ]);
  });
});
