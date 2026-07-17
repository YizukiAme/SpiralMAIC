import { describe, expect, it } from 'vitest';

import { computeJudgeQ, normalizeJudgeReport } from '@/lib/revisit/judge';

const dimensions = {
  clarity: 0.8,
  doubtResolution: 0.7,
  transfer: 0.6,
  errorCorrection: 0.9,
};

const transcript = [
  {
    id: 'message-1',
    role: 'teacher' as const,
    text: `  A real explanation
with trusted   spacing.  `,
    createdAt: 1,
  },
];

const pageReports = [
  {
    pageId: 'page-1',
    pageIndex: 0,
    passed: true,
    probeCount: 1,
    conceptIds: ['concept-1'],
    notes: 'The explanation passed the page gate.',
  },
];

const findings = {
  strengths: [
    {
      title: 'Clear explanation',
      feedback: 'The explanation accurately connected the core ideas.',
      dimension: 'clarity' as const,
      conceptIds: ['concept-1'],
      citations: [
        {
          kind: 'transcript' as const,
          sourceId: 'message-1',
        },
      ],
    },
  ],
  improvements: [
    {
      title: 'Add a transfer example',
      feedback: 'Use a second situation to demonstrate transfer.',
      dimension: 'transfer' as const,
      conceptIds: ['concept-1'],
      citations: [
        {
          kind: 'pageReport' as const,
          sourceId: 'page-1',
        },
      ],
    },
  ],
};

const trustedInputs = {
  expectedConceptIds: ['concept-1'],
  transcript,
  pageReports,
};

describe('SpiralMAIC revisit judge scoring', () => {
  it('maps four visible dimensions into q with PRD weights and clipping', () => {
    const result = computeJudgeQ({
      clarity: 0.8,
      doubtResolution: 0.6,
      transfer: 0.4,
      errorCorrection: 1,
    });

    expect(result.qRaw).toBeCloseTo(0.69, 4);
    expect(result.q).toBeCloseTo(0.69, 4);
    expect(
      computeJudgeQ({ clarity: 1, doubtResolution: 1, transfer: 1, errorCorrection: 1 }).q,
    ).toBe(0.98);
    expect(
      computeJudgeQ({ clarity: 0, doubtResolution: 0, transfer: 0, errorCorrection: 0 }).q,
    ).toBe(0.05);
  });

  it('deducts uncorrected factual errors while preserving corrected error evidence', () => {
    const result = computeJudgeQ(
      { clarity: 0.9, doubtResolution: 0.9, transfer: 0.9, errorCorrection: 0.9 },
      [
        {
          id: 'err-1',
          conceptId: 'concept-1',
          description: 'Claims ad hominem and straw man are identical.',
          corrected: false,
          severity: 'critical',
        },
        {
          id: 'err-2',
          conceptId: 'concept-1',
          description: 'Initially gives a weak example, then fixes it after the student asks.',
          corrected: true,
          severity: 'minor',
        },
      ],
    );

    expect(result.uncorrectedErrorCount).toBe(1);
    expect(result.qRaw).toBeCloseTo(0.9, 4);
    expect(result.q).toBeCloseTo(0.75, 4);
  });

  it('normalizes model reports and creates per-concept evidence records', () => {
    const report = normalizeJudgeReport(
      {
        attemptId: 'attempt-1',
        stageId: 'stage-1',
        completedAt: Date.UTC(2026, 6, 8),
        summary: 'Clear explanation with one corrected example.',
        dimensions: {
          clarity: 82,
          doubtResolution: 0.7,
          transfer: 0.6,
          errorCorrection: 0.9,
        },
        conceptScores: [
          {
            conceptId: 'concept-1',
            scores: {
              clarity: 0.8,
              doubtResolution: 0.7,
              transfer: 0.7,
              errorCorrection: 0.9,
            },
            notes: 'Can distinguish the fallacy from a real counterargument.',
          },
        ],
        errors: [
          {
            conceptId: 'concept-1',
            description: 'Mislabels a minor example before correcting it.',
            corrected: true,
            severity: 'minor',
          },
        ],
        ...findings,
      },
      trustedInputs,
    );

    expect(report.dimensions.clarity).toBeCloseTo(0.82, 4);
    expect(report.q).toBeGreaterThan(0.05);
    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]).toMatchObject({
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      conceptId: 'concept-1',
      source: 'teach_back',
      polarity: 'positive',
    });
    expect(report.errors[0]).toMatchObject({ id: expect.any(String), corrected: true });
    expect(report.findingsVersion).toBe(1);
    expect(report.strengths).toEqual([
      {
        id: 'attempt-1:strength-01',
        title: 'Clear explanation',
        feedback: 'The explanation accurately connected the core ideas.',
        dimension: 'clarity',
        conceptIds: ['concept-1'],
        citations: [
          {
            kind: 'transcript',
            sourceId: 'message-1',
            excerpt: 'A real explanation with trusted spacing.',
          },
        ],
      },
    ]);
    expect(report.improvements?.[0]?.citations[0]).toMatchObject({
      kind: 'pageReport',
      sourceId: 'page-1',
      pageId: 'page-1',
      pageIndex: 0,
      passed: true,
      probeCount: 1,
      conceptIds: ['concept-1'],
    });
  });

  it('copies and caps transcript excerpts from trusted messages instead of model text', () => {
    const longTranscript = [
      {
        ...transcript[0],
        text: ` trusted\n${'evidence '.repeat(40)}`,
      },
    ];
    const raw = {
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      summary: 'A valid report.',
      dimensions,
      conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
      strengths: [
        {
          ...findings.strengths[0],
          citations: [
            {
              kind: 'transcript' as const,
              sourceId: 'message-1',
              excerpt: 'Fabricated model-authored quotation.',
            },
          ],
        },
      ],
      improvements: findings.improvements,
    };

    const report = normalizeJudgeReport(raw, {
      ...trustedInputs,
      transcript: longTranscript,
    });
    const citation = report.strengths?.[0]?.citations[0];

    expect(citation?.kind).toBe('transcript');
    if (citation?.kind !== 'transcript') throw new Error('Expected transcript citation');
    expect(citation.excerpt).not.toContain('Fabricated');
    expect(citation.excerpt).not.toMatch(/\s{2,}|\n/);
    expect(citation.excerpt.length).toBeLessThanOrEqual(240);
  });

  it('persists defensive copies of trusted page reports instead of model-authored page reports', () => {
    const trustedPageReports = [
      {
        ...pageReports[0],
        conceptIds: [...pageReports[0].conceptIds],
      },
    ];
    const report = normalizeJudgeReport(
      {
        attemptId: 'attempt-1',
        stageId: 'stage-1',
        summary: 'A valid report.',
        dimensions,
        conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
        pageReports: [
          {
            pageId: 'model-page',
            pageIndex: 99,
            passed: false,
            probeCount: 99,
            conceptIds: ['model-concept'],
            notes: 'Fabricated model-authored page report.',
          },
        ],
        ...findings,
      },
      {
        ...trustedInputs,
        pageReports: trustedPageReports,
      },
    );

    expect(report.pageReports).toEqual(trustedPageReports);
    expect(report.pageReports).not.toBe(trustedPageReports);
    expect(report.pageReports[0]).not.toBe(trustedPageReports[0]);
    expect(report.pageReports[0]?.conceptIds).not.toBe(trustedPageReports[0]?.conceptIds);
    expect(report.improvements?.[0]?.citations[0]).toMatchObject({
      kind: 'pageReport',
      sourceId: 'page-1',
      pageId: 'page-1',
      conceptIds: ['concept-1'],
    });

    trustedPageReports[0].conceptIds.push('mutated-after-normalization');
    expect(report.pageReports[0]?.conceptIds).toEqual(['concept-1']);
  });

  it.each([
    {
      label: 'transcript',
      finding: {
        ...findings.strengths[0],
        citations: [{ kind: 'transcript' as const, sourceId: 'missing-message' }],
      },
      error: /unknown transcript/i,
    },
    {
      label: 'page report',
      finding: {
        ...findings.strengths[0],
        citations: [{ kind: 'pageReport' as const, sourceId: 'missing-page' }],
      },
      error: /unknown page report/i,
    },
    {
      label: 'concept',
      finding: {
        ...findings.strengths[0],
        conceptIds: ['missing-concept'],
      },
      error: /unknown concept/i,
    },
  ])('rejects a finding with an unknown $label reference', ({ finding, error }) => {
    expect(() =>
      normalizeJudgeReport(
        {
          attemptId: 'attempt-1',
          stageId: 'stage-1',
          summary: 'A valid report.',
          dimensions,
          conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
          strengths: [finding],
          improvements: findings.improvements,
        },
        trustedInputs,
      ),
    ).toThrow(error);
  });

  it('rejects unknown references in findings beyond the persisted three-item limit', () => {
    const validStrengths = Array.from({ length: 3 }, (_, index) => ({
      ...findings.strengths[0],
      title: `Valid strength ${index + 1}`,
    }));

    expect(() =>
      normalizeJudgeReport(
        {
          attemptId: 'attempt-1',
          stageId: 'stage-1',
          summary: 'A valid report.',
          dimensions,
          conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
          strengths: [
            ...validStrengths,
            {
              ...findings.strengths[0],
              title: 'Invalid fourth strength',
              conceptIds: ['missing-concept'],
            },
          ],
          improvements: findings.improvements,
        },
        trustedInputs,
      ),
    ).toThrow(/unknown concept/i);
  });

  it('rejects unknown references in citations beyond the persisted two-citation limit', () => {
    expect(() =>
      normalizeJudgeReport(
        {
          attemptId: 'attempt-1',
          stageId: 'stage-1',
          summary: 'A valid report.',
          dimensions,
          conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
          strengths: [
            {
              ...findings.strengths[0],
              citations: [
                { kind: 'transcript', sourceId: 'message-1' },
                { kind: 'pageReport', sourceId: 'page-1' },
                { kind: 'transcript', sourceId: 'missing-message' },
              ],
            },
          ],
          improvements: findings.improvements,
        },
        trustedInputs,
      ),
    ).toThrow(/unknown transcript/i);
  });

  it('persists at most three validated findings and two validated citations', () => {
    const report = normalizeJudgeReport(
      {
        attemptId: 'attempt-1',
        stageId: 'stage-1',
        summary: 'A valid report.',
        dimensions,
        conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
        strengths: Array.from({ length: 4 }, (_, index) => ({
          ...findings.strengths[0],
          title: `Valid strength ${index + 1}`,
          citations: [
            { kind: 'transcript' as const, sourceId: 'message-1' },
            { kind: 'pageReport' as const, sourceId: 'page-1' },
            { kind: 'transcript' as const, sourceId: 'message-1' },
          ],
        })),
        improvements: findings.improvements,
      },
      trustedInputs,
    );

    expect(report.strengths).toHaveLength(3);
    expect(report.strengths?.[0]?.citations).toHaveLength(2);
  });

  it.each([
    { strengths: undefined, improvements: findings.improvements },
    { strengths: [], improvements: findings.improvements },
    { strengths: findings.strengths, improvements: undefined },
    { strengths: findings.strengths, improvements: [] },
  ])('rejects missing or empty strength and improvement categories', (findingCategories) => {
    expect(() =>
      normalizeJudgeReport(
        {
          attemptId: 'attempt-1',
          stageId: 'stage-1',
          summary: 'A valid report.',
          dimensions,
          conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
          ...findingCategories,
        },
        trustedInputs,
      ),
    ).toThrow(/strength|improvement/i);
  });

  it('keeps findings out of q, qRaw, and concept evidence calculations', () => {
    const base = {
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      completedAt: 1,
      summary: 'A valid report.',
      dimensions,
      conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
      errors: [
        {
          conceptId: 'concept-1',
          description: 'An uncorrected error.',
          corrected: false,
          severity: 'major' as const,
        },
      ],
    };
    const first = normalizeJudgeReport({ ...base, ...findings }, trustedInputs);
    const second = normalizeJudgeReport(
      {
        ...base,
        strengths: [
          {
            ...findings.strengths[0],
            title: 'A completely different presentation title',
            dimension: 'errorCorrection' as const,
          },
        ],
        improvements: [
          {
            ...findings.improvements[0],
            feedback: 'Different presentation feedback.',
            dimension: 'clarity' as const,
          },
        ],
      },
      trustedInputs,
    );

    expect(second.q).toBe(first.q);
    expect(second.qRaw).toBe(first.qRaw);
    expect(second.evidence).toEqual(first.evidence);
  });

  it('names evidence uniquely per attempt so Dexie history cannot be overwritten', () => {
    const dimensions = {
      clarity: 0.5,
      doubtResolution: 0.5,
      transfer: 0.5,
      errorCorrection: 0.5,
    };
    const makeReport = (attemptId: string) =>
      normalizeJudgeReport(
        {
          attemptId,
          stageId: 'stage-1',
          summary: 'A valid report.',
          dimensions,
          conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
          ...findings,
        },
        trustedInputs,
      );

    const firstId = makeReport('attempt-1').evidence[0]?.id;
    const secondId = makeReport('attempt-2').evidence[0]?.id;

    expect(firstId).toContain('attempt-1');
    expect(secondId).toContain('attempt-2');
    expect(firstId).not.toBe(secondId);
  });

  it('rejects structurally empty judge output instead of counting a failed judgment', () => {
    expect(() => normalizeJudgeReport({})).toThrow(/missing/i);
  });

  it('rejects judge evidence for unknown or missing blueprint concepts', () => {
    const base = {
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      summary: 'Evidence-backed result.',
      dimensions: {
        clarity: 0.8,
        doubtResolution: 0.8,
        transfer: 0.8,
        errorCorrection: 0.8,
      },
    };

    expect(() =>
      normalizeJudgeReport(
        {
          ...base,
          conceptScores: [{ conceptId: 'model-typo', scores: base.dimensions }],
          ...findings,
        },
        trustedInputs,
      ),
    ).toThrow(/unknown concept/i);

    expect(() =>
      normalizeJudgeReport(
        {
          ...base,
          conceptScores: [],
          ...findings,
        },
        trustedInputs,
      ),
    ).toThrow(/missing concept/i);
  });
});
