import { describe, expect, it } from 'vitest';

import {
  REVISIT_REPORT_DIMENSIONS,
  buildRevisitRadarPoints,
  getRevisitReportFeedbackState,
} from '@/lib/revisit/report-presentation';

describe('Reverse report presentation', () => {
  it('keeps the radar axes in the product-defined order', () => {
    expect(REVISIT_REPORT_DIMENSIONS).toEqual([
      'clarity',
      'doubtResolution',
      'transfer',
      'errorCorrection',
    ]);
  });

  it('builds one bounded polygon point per dimension', () => {
    const points = buildRevisitRadarPoints(
      {
        clarity: 1,
        doubtResolution: 0.5,
        transfer: -1,
        errorCorrection: 2,
      },
      50,
      40,
    );

    expect(points).toHaveLength(4);
    expect(points.every(({ x, y }) => x >= 10 && x <= 90 && y >= 10 && y <= 90)).toBe(true);
  });

  it('does not synthesize findings for legacy reports', () => {
    expect(getRevisitReportFeedbackState({ findingsVersion: undefined })).toBe('legacy');
    expect(getRevisitReportFeedbackState({ findingsVersion: 1 })).toBe('evidence');
  });
});
