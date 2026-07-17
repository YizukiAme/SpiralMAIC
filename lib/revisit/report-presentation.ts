import type { RevisitDimension, RevisitDimensionScores } from '@/lib/revisit/types';

export const REVISIT_REPORT_DIMENSIONS = [
  'clarity',
  'doubtResolution',
  'transfer',
  'errorCorrection',
] as const satisfies readonly RevisitDimension[];

export interface RevisitRadarPoint {
  dimension: RevisitDimension;
  value: number;
  x: number;
  y: number;
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function buildRevisitRadarPoints(
  dimensions: RevisitDimensionScores,
  center: number,
  radius: number,
): RevisitRadarPoint[] {
  return REVISIT_REPORT_DIMENSIONS.map((dimension, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / REVISIT_REPORT_DIMENSIONS.length;
    const value = clampScore(dimensions[dimension]);
    return {
      dimension,
      value,
      x: center + Math.cos(angle) * radius * value,
      y: center + Math.sin(angle) * radius * value,
    };
  });
}

export function getRevisitReportFeedbackState(report: {
  findingsVersion?: 1;
}): 'legacy' | 'evidence' {
  return report.findingsVersion === 1 ? 'evidence' : 'legacy';
}
