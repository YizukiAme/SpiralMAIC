import { describe, expect, it } from 'vitest';

import { computeJudgeQ, normalizeJudgeReport } from '@/lib/revisit/judge';

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
    const report = normalizeJudgeReport({
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
    });

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
  });

  it('names evidence uniquely per attempt so Dexie history cannot be overwritten', () => {
    const dimensions = {
      clarity: 0.5,
      doubtResolution: 0.5,
      transfer: 0.5,
      errorCorrection: 0.5,
    };
    const makeReport = (attemptId: string) =>
      normalizeJudgeReport({
        attemptId,
        stageId: 'stage-1',
        summary: 'A valid report.',
        dimensions,
        conceptScores: [{ conceptId: 'concept-1', scores: dimensions }],
      });

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
        },
        { expectedConceptIds: ['concept-1'] },
      ),
    ).toThrow(/unknown concept/i);

    expect(() =>
      normalizeJudgeReport(
        {
          ...base,
          conceptScores: [],
        },
        { expectedConceptIds: ['concept-1'] },
      ),
    ).toThrow(/missing concept/i);
  });
});
