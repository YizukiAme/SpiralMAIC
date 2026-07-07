import type { RevisitDimension, RevisitJudgeReport } from '@/lib/revisit/types';

const DIMENSIONS: RevisitDimension[] = [
  'clarity',
  'doubtResolution',
  'transfer',
  'errorCorrection',
];

function spread(values: number[]): number {
  if (values.length <= 1) return 0;
  return Math.max(...values) - Math.min(...values);
}

export function judgeRevisitReportStability(
  reports: RevisitJudgeReport[],
  limits: { maxQDelta: number; maxDimensionDelta: number },
): {
  passed: boolean;
  reason: string;
  qValues: number[];
  maxQDelta: number;
  maxDimensionDelta: number;
} {
  const qValues = reports.map((report) => report.q);
  const qDelta = spread(qValues);
  const dimensionDeltas = DIMENSIONS.map((dimension) =>
    spread(reports.map((report) => report.dimensions[dimension])),
  );
  const dimensionDelta = Math.max(0, ...dimensionDeltas);
  const passed = qDelta <= limits.maxQDelta && dimensionDelta <= limits.maxDimensionDelta;

  return {
    passed,
    reason: passed
      ? `stable: q delta ${qDelta.toFixed(3)}, dimension delta ${dimensionDelta.toFixed(3)}`
      : `unstable: q delta ${qDelta.toFixed(3)}, dimension delta ${dimensionDelta.toFixed(3)}`,
    qValues,
    maxQDelta: qDelta,
    maxDimensionDelta: dimensionDelta,
  };
}
