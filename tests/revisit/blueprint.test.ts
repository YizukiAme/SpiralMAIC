import { describe, expect, it } from 'vitest';

import { normalizeBlueprint } from '@/lib/revisit/blueprint';

describe('SpiralMAIC blueprint normalization', () => {
  it('normalizes concepts, probes, and skeleton pages with stable ids', () => {
    const blueprint = normalizeBlueprint(
      {
        language: 'en-US',
        openingBrief:
          'The lesson moves from identifying a claim to recognizing how that claim is distorted.',
        concepts: [
          {
            label: 'Straw man fallacy',
            summary: 'Distorting a claim before attacking it.',
            anchors: {
              clarity: ['Define it'],
              doubtResolution: ['Explain why it is not just disagreement'],
              transfer: ['Identify it in a debate'],
              errorCorrection: ['Correct a fake example'],
            },
            probes: [
              {
                prompt: 'Is every weak counterargument a straw man?',
                kind: 'confusion',
              },
            ],
          },
        ],
        skeleton: {
          pages: [
            {
              title: 'Name the real claim',
              summary: 'Teach the difference between the real claim and distorted claim.',
              conceptLabels: ['Straw man fallacy'],
              cues: ['real claim', 'distorted claim'],
            },
          ],
        },
      },
      { stageId: 'stage-1', generatedAt: Date.UTC(2026, 6, 8), sourceHash: 'abc' },
    );

    expect(blueprint.id).toBe('stage-1:abc');
    expect(blueprint.openingBrief).toBe(
      'The lesson moves from identifying a claim to recognizing how that claim is distorted.',
    );
    expect(blueprint.concepts[0].id).toBe('straw-man-fallacy');
    expect(blueprint.concepts[0].probes[0]).toMatchObject({
      conceptId: 'straw-man-fallacy',
      pageIndex: 0,
      kind: 'confusion',
    });
    expect(blueprint.skeleton.pages[0].conceptIds).toEqual(['straw-man-fallacy']);
  });

  it('rejects incomplete blueprint responses instead of inventing a local fallback', () => {
    expect(() =>
      normalizeBlueprint(
        {
          language: 'en-US',
          concepts: [],
          skeleton: { pages: [] },
        },
        { stageId: 'stage-1', generatedAt: Date.UTC(2026, 6, 8), sourceHash: 'abc' },
      ),
    ).toThrow(/no concepts/i);
  });

  it('rejects pages that reference concepts the model did not define', () => {
    expect(() =>
      normalizeBlueprint(
        {
          language: 'en-US',
          concepts: [
            {
              id: 'known',
              label: 'Known concept',
              summary: 'A real concept.',
              anchors: {
                clarity: ['Define it'],
                doubtResolution: ['Clarify it'],
                transfer: ['Apply it'],
                errorCorrection: ['Correct it'],
              },
              probes: [{ prompt: 'Why?', kind: 'confusion' }],
            },
          ],
          skeleton: {
            pages: [
              {
                title: 'Unknown mapping',
                summary: 'This must not silently map to the first concept.',
                conceptIds: ['missing'],
                cues: ['cue'],
              },
            ],
          },
        },
        { stageId: 'stage-1', generatedAt: 1, sourceHash: 'abc' },
      ),
    ).toThrow(/unknown concept/i);
  });

  it('rejects colliding normalized concept ids instead of merging memory identities', () => {
    const concept = (label: string) => ({
      label,
      summary: label,
      anchors: {
        clarity: ['Define it'],
        doubtResolution: ['Clarify it'],
        transfer: ['Apply it'],
        errorCorrection: ['Correct it'],
      },
      probes: [{ prompt: `Explain ${label}`, kind: 'confusion' }],
    });

    expect(() =>
      normalizeBlueprint(
        {
          concepts: [concept('C++'), concept('C#')],
          skeleton: {
            pages: [
              {
                title: 'Languages',
                summary: 'Compare them.',
                conceptLabels: ['C++', 'C#'],
                cues: ['syntax'],
              },
            ],
          },
        },
        { stageId: 'stage-1', generatedAt: 1, sourceHash: 'abc' },
      ),
    ).toThrow(/duplicate concept id/i);
  });

  it('enforces the cue budget supplied by the challenge profile', () => {
    const blueprint = normalizeBlueprint(
      {
        concepts: [
          {
            id: 'c1',
            label: 'Concept',
            summary: 'Summary',
            anchors: {
              clarity: ['Define it'],
              doubtResolution: ['Clarify it'],
              transfer: ['Apply it'],
              errorCorrection: ['Correct it'],
            },
            probes: [{ prompt: 'Explain it', kind: 'confusion' }],
          },
        ],
        skeleton: {
          pages: [
            {
              title: 'Sparse page',
              summary: 'Teach independently.',
              conceptIds: ['c1'],
              cues: ['one', 'two', 'three', 'four'],
            },
          ],
        },
      },
      { stageId: 'stage-1', generatedAt: 1, sourceHash: 'abc', maxCuesPerPage: 1 },
    );

    expect(blueprint.skeleton.pages[0]?.cues).toEqual(['one']);
  });

  it('rejects empty probe prompts instead of inventing a question', () => {
    expect(() =>
      normalizeBlueprint(
        {
          concepts: [
            {
              id: 'c1',
              label: 'Concept',
              summary: 'Summary',
              anchors: {
                clarity: ['Define it'],
                doubtResolution: ['Clarify it'],
                transfer: ['Apply it'],
                errorCorrection: ['Correct it'],
              },
              probes: [{ kind: 'confusion' }],
            },
          ],
          skeleton: {
            pages: [
              {
                title: 'Page',
                summary: 'Teach it.',
                conceptIds: ['c1'],
                cues: [],
              },
            ],
          },
        },
        { stageId: 'stage-1', generatedAt: 1, sourceHash: 'abc' },
      ),
    ).toThrow(/probe prompt/i);
  });

  it('preserves canonical concept ids across regenerated challenge blueprints', () => {
    const normalized = normalizeBlueprint(
      {
        concepts: [
          {
            id: 'model-renamed-id',
            label: 'Straw man fallacy',
            summary: 'Distorting a claim before attacking it.',
            anchors: {
              clarity: ['Define it'],
              doubtResolution: ['Clarify it'],
              transfer: ['Apply it'],
              errorCorrection: ['Correct it'],
            },
            probes: [{ prompt: 'Spot it in a new debate.', kind: 'transfer' }],
          },
        ],
        skeleton: {
          pages: [
            {
              title: 'Transfer it',
              summary: 'Apply the concept.',
              conceptLabels: ['Straw man fallacy'],
              cues: ['new setting'],
            },
          ],
        },
      },
      {
        stageId: 'stage-1',
        generatedAt: 2,
        sourceHash: 'next',
        canonicalConcepts: [{ id: 'straw-man', label: 'Straw man fallacy' }],
      },
    );

    expect(normalized.concepts[0]?.id).toBe('straw-man');
    expect(normalized.skeleton.pages[0]?.conceptIds).toEqual(['straw-man']);
  });

  it('allows regenerated blueprints to select only a subset of historical concepts', () => {
    const normalized = normalizeBlueprint(
      {
        concepts: [
          {
            id: 'model-renamed-id',
            label: 'Straw man fallacy',
            summary: 'Distorting a claim before attacking it.',
            anchors: {
              clarity: ['Define it'],
              doubtResolution: ['Clarify it'],
              transfer: ['Apply it'],
              errorCorrection: ['Correct it'],
            },
            probes: [{ prompt: 'Spot it.', kind: 'transfer' }],
          },
        ],
        skeleton: {
          pages: [
            {
              title: 'Transfer it',
              summary: 'Apply the concept.',
              conceptIds: ['model-renamed-id'],
              cues: ['new setting'],
            },
          ],
        },
      },
      {
        stageId: 'stage-1',
        generatedAt: 2,
        sourceHash: 'next',
        canonicalConcepts: [
          { id: 'straw-man', label: 'Straw man fallacy' },
          { id: 'appeal-to-authority', label: 'Appeal to authority' },
        ],
      },
    );

    expect(normalized.concepts.map((concept) => concept.id)).toEqual(['straw-man']);
  });

  it('allows a regenerated blueprint to introduce a genuinely new concept', () => {
    const normalized = normalizeBlueprint(
      {
        concepts: [
          {
            id: 'appeal-to-authority',
            label: 'Appeal to authority',
            summary: 'Treating authority as sufficient proof.',
            anchors: {
              clarity: ['Define it'],
              doubtResolution: ['Clarify it'],
              transfer: ['Apply it'],
              errorCorrection: ['Correct it'],
            },
            probes: [{ prompt: 'Spot it.', kind: 'transfer' }],
          },
        ],
        skeleton: {
          pages: [
            {
              title: 'Transfer it',
              summary: 'Apply the concept.',
              conceptIds: ['appeal-to-authority'],
              cues: ['new setting'],
            },
          ],
        },
      },
      {
        stageId: 'stage-1',
        generatedAt: 2,
        sourceHash: 'next',
        canonicalConcepts: [{ id: 'straw-man', label: 'Straw man fallacy' }],
      },
    );

    expect(normalized.concepts.map((concept) => concept.id)).toEqual(['appeal-to-authority']);
  });

  it('rejects a blueprint that omits a required pending-assessment concept', () => {
    expect(() =>
      normalizeBlueprint(
        {
          concepts: [
            {
              id: 'appeal-to-authority',
              label: 'Appeal to authority',
              summary: 'Treating authority as sufficient proof.',
              anchors: {
                clarity: ['Define it'],
                doubtResolution: ['Clarify it'],
                transfer: ['Apply it'],
                errorCorrection: ['Correct it'],
              },
              probes: [{ prompt: 'Spot it.', kind: 'transfer' }],
            },
          ],
          skeleton: {
            pages: [
              {
                title: 'Transfer it',
                summary: 'Apply the concept.',
                conceptIds: ['appeal-to-authority'],
                cues: ['new setting'],
              },
            ],
          },
        },
        {
          stageId: 'stage-1',
          generatedAt: 2,
          sourceHash: 'next',
          canonicalConcepts: [
            { id: 'straw-man', label: 'Straw man fallacy' },
            { id: 'appeal-to-authority', label: 'Appeal to authority' },
          ],
          requiredConceptIds: ['straw-man'],
        },
      ),
    ).toThrow(/required concept/i);
  });

  it('rejects a blueprint that declares but does not teach a required concept', () => {
    expect(() =>
      normalizeBlueprint(
        {
          concepts: [
            {
              id: 'approach',
              label: 'approach',
              summary: 'Move closer.',
              anchors: {
                clarity: ['Define it'],
                doubtResolution: ['Clarify it'],
                transfer: ['Apply it'],
                errorCorrection: ['Correct it'],
              },
              probes: [{ prompt: 'Use it.', kind: 'transfer' }],
            },
            {
              id: 'go',
              label: 'go',
              summary: 'Move away.',
              anchors: {
                clarity: ['Define it'],
                doubtResolution: ['Clarify it'],
                transfer: ['Apply it'],
                errorCorrection: ['Correct it'],
              },
              probes: [{ prompt: 'Use it.', kind: 'transfer' }],
            },
          ],
          skeleton: {
            pages: [
              {
                title: 'Review go',
                summary: 'Apply go.',
                conceptIds: ['go'],
                cues: ['new setting'],
              },
            ],
          },
        },
        {
          stageId: 'stage-1',
          generatedAt: 2,
          sourceHash: 'next',
          canonicalConcepts: [{ id: 'approach', label: 'approach' }],
          requiredConceptIds: ['approach'],
        },
      ),
    ).toThrow(/skeleton omitted required concept/i);
  });
});
