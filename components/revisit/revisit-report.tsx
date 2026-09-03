'use client';

import { CheckCircle2, MessageSquareQuote, Sparkles, Target, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  REVISIT_REPORT_DIMENSIONS,
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

export function RevisitReport({ report, density, conceptLabelsById = {} }: RevisitReportProps) {
  const { t } = useI18n();
  const evidenceAvailable = getRevisitReportFeedbackState(report) === 'evidence';
  const leadingImprovement = evidenceAvailable ? report.improvements?.[0] : undefined;
  const rankedDimensions = [...REVISIT_REPORT_DIMENSIONS].sort(
    (left, right) => report.dimensions[left] - report.dimensions[right],
  );

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
          'overflow-hidden rounded-2xl border bg-card shadow-sm',
          density === 'full' ? 'p-6 sm:p-8' : 'p-4 sm:p-5',
        )}
      >
        <div
          className="grid gap-5"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
          }}
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {report.q >= 0.75 ? t('revisit.report.strong') : t('revisit.report.needsWork')}
              </Badge>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('revisit.report.overall')} · {Math.round(report.q * 100)}%
              </span>
            </div>
            <h2
              className={cn(
                'mt-4 font-semibold tracking-tight',
                density === 'full' ? 'text-2xl' : 'text-lg',
              )}
            >
              {t('revisit.report.summary')}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{report.summary}</p>
          </div>
          {leadingImprovement ? (
            <div className="rounded-xl border border-amber-200/80 bg-amber-50/55 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
                <Target className="size-4" />
                {t('revisit.report.improvements')}
              </p>
              <h3 className="mt-3 text-sm font-semibold">{leadingImprovement.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {leadingImprovement.feedback}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section
        className={cn('rounded-2xl border bg-card', density === 'full' ? 'p-5 sm:p-6' : 'p-4')}
      >
        <div className="space-y-4">
          {rankedDimensions.map((dimension, index) => {
            const score = Math.round(report.dimensions[dimension] * 100);
            return (
              <div
                key={dimension}
                role="progressbar"
                aria-label={t(`revisit.report.dimensions.${dimension}`)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={score}
                className={cn(
                  'rounded-xl border px-3.5 py-3',
                  index === 0
                    ? 'border-amber-200/80 bg-amber-50/45 dark:border-amber-900/50 dark:bg-amber-950/15'
                    : 'bg-muted/20',
                )}
              >
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium">{t(`revisit.report.dimensions.${dimension}`)}</span>
                  <span className="font-semibold tabular-nums">{score}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      index === 0 ? 'bg-amber-500' : 'bg-primary',
                    )}
                    style={{ width: `${score}%` }}
                  />
                </div>
              </div>
            );
          })}
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
