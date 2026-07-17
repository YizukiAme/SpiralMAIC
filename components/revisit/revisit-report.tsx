'use client';

import { CheckCircle2, MessageSquareQuote, Sparkles, Target, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  REVISIT_REPORT_DIMENSIONS,
  buildRevisitRadarPoints,
  getRevisitReportFeedbackState,
} from '@/lib/revisit/report-presentation';
import type {
  RevisitJudgeReport,
  RevisitReportCitation,
  RevisitReportFinding,
} from '@/lib/revisit/types';
import { cn } from '@/lib/utils';

export interface RevisitReportProps {
  readonly report: RevisitJudgeReport;
  readonly density: 'full' | 'compact';
  readonly conceptLabelsById?: Readonly<Record<string, string>>;
}

const RADAR_CENTER = 100;
const RADAR_RADIUS = 68;

function polygonPoints(points: Array<{ x: number; y: number }>): string {
  return points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function axisPoint(index: number, radius = RADAR_RADIUS): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / REVISIT_REPORT_DIMENSIONS.length;
  return {
    x: RADAR_CENTER + Math.cos(angle) * radius,
    y: RADAR_CENTER + Math.sin(angle) * radius,
  };
}

export function RevisitReport({ report, density, conceptLabelsById = {} }: RevisitReportProps) {
  const { t } = useI18n();
  const radarPoints = buildRevisitRadarPoints(report.dimensions, RADAR_CENTER, RADAR_RADIUS);
  const radarDescription = REVISIT_REPORT_DIMENSIONS.map(
    (dimension) =>
      `${t(`revisit.report.dimensions.${dimension}`)} ${Math.round(report.dimensions[dimension] * 100)}%`,
  ).join(', ');
  const evidenceAvailable = getRevisitReportFeedbackState(report) === 'evidence';

  return (
    <article
      data-density={density}
      className={cn(
        'mx-auto min-w-0 w-full text-foreground [overflow-wrap:anywhere]',
        density === 'full' ? 'max-w-5xl space-y-5' : 'space-y-4',
      )}
    >
      <section
        className={cn(
          'overflow-hidden rounded-2xl border border-amber-200/70 bg-gradient-to-br from-amber-50 via-background to-orange-50/60 shadow-sm dark:border-amber-900/60 dark:from-amber-950/25 dark:via-background dark:to-orange-950/20',
          density === 'full' ? 'p-6 sm:p-8' : 'p-4 sm:p-5',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
              {t('revisit.report.overall')}
            </p>
            <p
              className={cn(
                'mt-1 font-black tabular-nums text-amber-800 dark:text-amber-200',
                density === 'full' ? 'text-5xl' : 'text-3xl',
              )}
            >
              {Math.round(report.q * 100)}%
            </p>
          </div>
          <Badge
            className={cn(
              report.q >= 0.75
                ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                : 'bg-amber-500 text-white hover:bg-amber-500',
            )}
          >
            {report.q >= 0.75 ? t('revisit.report.strong') : t('revisit.report.needsWork')}
          </Badge>
        </div>
        <div className="mt-5 border-t border-amber-200/60 pt-4 dark:border-amber-900/50">
          <h2 className="text-sm font-semibold">{t('revisit.report.summary')}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{report.summary}</p>
        </div>
      </section>

      <section
        className={cn('rounded-2xl border bg-card', density === 'full' ? 'p-5 sm:p-6' : 'p-4')}
      >
        <div
          className="grid items-center gap-5"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
          }}
        >
          <svg
            viewBox="0 0 200 200"
            className="mx-auto aspect-square w-full max-w-[300px] text-primary"
            role="img"
            aria-label={t('revisit.report.radarLabel')}
          >
            <title>{t('revisit.report.radarLabel')}</title>
            <desc>{t('revisit.report.radarDescription', { scores: radarDescription })}</desc>
            {[0.25, 0.5, 0.75, 1].map((scale) => (
              <polygon
                key={scale}
                points={polygonPoints(
                  REVISIT_REPORT_DIMENSIONS.map((_, index) =>
                    axisPoint(index, RADAR_RADIUS * scale),
                  ),
                )}
                fill="none"
                stroke="currentColor"
                strokeOpacity={scale === 1 ? 0.3 : 0.14}
                strokeWidth="1"
              />
            ))}
            {REVISIT_REPORT_DIMENSIONS.map((dimension, index) => {
              const end = axisPoint(index);
              return (
                <line
                  key={dimension}
                  x1={RADAR_CENTER}
                  y1={RADAR_CENTER}
                  x2={end.x}
                  y2={end.y}
                  stroke="currentColor"
                  strokeOpacity="0.18"
                  strokeWidth="1"
                />
              );
            })}
            <polygon
              points={polygonPoints(radarPoints)}
              fill="currentColor"
              fillOpacity="0.22"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            {radarPoints.map((point) => (
              <circle key={point.dimension} cx={point.x} cy={point.y} r="3" fill="currentColor" />
            ))}
          </svg>

          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 11rem), 1fr))',
            }}
          >
            {REVISIT_REPORT_DIMENSIONS.map((dimension) => (
              <div key={dimension} className="rounded-xl border bg-muted/25 px-3 py-3">
                <p className="text-xs text-muted-foreground">
                  {t(`revisit.report.dimensions.${dimension}`)}
                </p>
                <p className="mt-1 text-lg font-bold tabular-nums">
                  {Math.round(report.dimensions[dimension] * 100)}%
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {evidenceAvailable ? (
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
          }}
        >
          <FindingSection
            title={t('revisit.report.strengths')}
            findings={report.strengths ?? []}
            tone="strength"
            conceptLabelsById={conceptLabelsById}
          />
          <FindingSection
            title={t('revisit.report.improvements')}
            findings={report.improvements ?? []}
            tone="improvement"
            conceptLabelsById={conceptLabelsById}
          />
        </div>
      ) : (
        <section className="rounded-2xl border border-dashed bg-muted/20 px-5 py-6 text-center">
          <MessageSquareQuote className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t('revisit.report.legacyEvidenceUnavailable')}
          </p>
        </section>
      )}

      <ReportErrors report={report} />
      <PageReportList report={report} />
    </article>
  );
}

function FindingSection({
  title,
  findings,
  tone,
  conceptLabelsById,
}: {
  title: string;
  findings: RevisitReportFinding[];
  tone: 'strength' | 'improvement';
  conceptLabelsById: Readonly<Record<string, string>>;
}) {
  const { t } = useI18n();
  const positive = tone === 'strength';
  const Icon = positive ? Sparkles : Target;
  return (
    <section
      className={cn(
        'rounded-2xl border p-4 sm:p-5',
        positive
          ? 'border-emerald-200/80 bg-emerald-50/55 dark:border-emerald-900/60 dark:bg-emerald-950/20'
          : 'border-amber-200/80 bg-amber-50/55 dark:border-amber-900/60 dark:bg-amber-950/20',
      )}
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Icon
          className={cn(
            'size-4.5',
            positive
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-amber-600 dark:text-amber-400',
          )}
        />
        {title}
      </h2>
      <div className="mt-3 space-y-3">
        {findings.map((finding) => (
          <article key={finding.id} className="rounded-xl border bg-background/80 p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-sm font-semibold">{finding.title}</h3>
              <Badge variant="outline" className="text-[10px]">
                {t(`revisit.report.dimensions.${finding.dimension}`)}
              </Badge>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{finding.feedback}</p>
            {finding.conceptIds.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {finding.conceptIds.map((conceptId) => (
                  <Badge key={conceptId} variant="secondary" className="font-normal">
                    {conceptLabelsById[conceptId] ?? conceptId}
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="mt-3 border-t pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('revisit.report.evidence')}
              </p>
              <div className="mt-2 space-y-2">
                {finding.citations.map((citation) => (
                  <FindingCitation
                    key={`${citation.kind}:${citation.sourceId}`}
                    citation={citation}
                  />
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function FindingCitation({ citation }: { citation: RevisitReportCitation }) {
  const { t } = useI18n();
  if (citation.kind === 'transcript') {
    return (
      <blockquote className="rounded-lg bg-muted/45 px-3 py-2 text-xs leading-5 text-muted-foreground">
        <span className="mb-1 block font-medium text-foreground/80">
          {t('revisit.report.transcriptEvidence')}
        </span>
        “{citation.excerpt}”
      </blockquote>
    );
  }
  return (
    <div className="rounded-lg bg-muted/45 px-3 py-2 text-xs leading-5 text-muted-foreground">
      {t('revisit.report.pageEvidence', {
        page: citation.pageIndex + 1,
        count: citation.probeCount,
        status: citation.passed ? t('revisit.report.passed') : t('revisit.report.notPassed'),
      })}
    </div>
  );
}

function ReportErrors({ report }: { report: RevisitJudgeReport }) {
  const { t } = useI18n();
  return (
    <section className="rounded-2xl border bg-card p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <TriangleAlert className="size-4.5 text-destructive" />
        {t('revisit.report.errors')}
      </h2>
      {report.errors.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('revisit.report.noErrors')}</p>
      ) : (
        <div className="mt-3 divide-y">
          {report.errors.map((error) => (
            <div key={error.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <span>{error.description}</span>
              <Badge variant={error.corrected ? 'secondary' : 'destructive'}>
                {error.corrected ? t('revisit.report.corrected') : t('revisit.report.uncorrected')}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PageReportList({ report }: { report: RevisitJudgeReport }) {
  const { t } = useI18n();
  return (
    <section className="rounded-2xl border bg-card p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CheckCircle2 className="size-4.5 text-primary" />
        {t('revisit.report.pages')}
      </h2>
      <div
        className="mt-3 grid gap-2"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))',
        }}
      >
        {report.pageReports.map((page) => (
          <div
            key={`${page.pageId}:${page.pageIndex}`}
            className="flex items-center gap-3 rounded-xl border bg-muted/20 px-3 py-2.5"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-xs font-semibold shadow-sm">
              {page.pageIndex + 1}
            </span>
            <span className="min-w-0 flex-1 text-sm">
              {page.passed ? t('revisit.report.passed') : t('revisit.report.notPassed')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('revisit.report.probes', { count: page.probeCount })}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
