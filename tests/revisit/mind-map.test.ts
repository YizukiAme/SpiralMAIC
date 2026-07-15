import { describe, expect, it } from 'vitest';

import {
  buildMindMapGraph,
  collectMindMapDescendantNodeIds,
  resolveMindMapNodeMemory,
} from '@/lib/revisit/mind-map';
import type { StudyArtifactMindMapNode, UserConceptState } from '@/lib/revisit/types';

const root: StudyArtifactMindMapNode = {
  id: 'root',
  label: 'Grammar',
  children: [
    {
      id: 'subject',
      label: 'Subject',
      note: 'Who or what the sentence is about',
      children: [
        { id: 'noun', label: 'Noun', children: [] },
        { id: 'pronoun', label: 'Pronoun', children: [] },
      ],
    },
    { id: 'predicate', label: 'Predicate', children: [] },
  ],
};

describe('mind map graph projection', () => {
  it('collapses descendants while keeping the collapsed node visible', () => {
    const graph = buildMindMapGraph(root, { collapsedNodeIds: new Set(['subject']) });

    expect(graph.nodes.map((node) => node.id)).toEqual(['root', 'subject', 'predicate']);
    expect(graph.edges.map((edge) => edge.target)).toEqual(['subject', 'predicate']);
  });

  it('marks search matches and produces stable non-overlapping positions', () => {
    const first = buildMindMapGraph(root, { query: 'noun' });
    const second = buildMindMapGraph(root, { query: 'noun' });

    expect(first.nodes.find((node) => node.id === 'noun')?.matched).toBe(true);
    expect(first.nodes.find((node) => node.id === 'pronoun')?.matched).toBe(true);
    expect(first.nodes.map((node) => node.position)).toEqual(
      second.nodes.map((node) => node.position),
    );
    expect(new Set(first.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(
      first.nodes.length,
    );
  });

  it('collects every descendant of a branch without including the branch itself', () => {
    expect(collectMindMapDescendantNodeIds(root, 'subject')).toEqual(['noun', 'pronoun']);
    expect(collectMindMapDescendantNodeIds(root, 'predicate')).toEqual([]);
    expect(collectMindMapDescendantNodeIds(root, 'missing')).toEqual([]);
  });

  it('distinguishes missing course evidence from an unlinked node', () => {
    expect(resolveMindMapNodeMemory(['subject'], [], 100)).toEqual({
      status: 'noCourseEvidence',
    });

    const conceptState: UserConceptState = {
      stageId: 'stage-1',
      conceptId: 'subject',
      label: 'Subject',
      hDays: 4,
      learnedAt: 0,
      lastRetrievalAt: 0,
      evidenceCount: 1,
      successChallengeDates: [],
      createdAt: 0,
      updatedAt: 0,
    };

    expect(resolveMindMapNodeMemory(['predicate'], [conceptState], 100)).toEqual({
      status: 'unlinkedNode',
    });
    expect(resolveMindMapNodeMemory(['subject'], [conceptState], 0)).toEqual({
      status: 'available',
      recall: 1,
    });
  });
});
