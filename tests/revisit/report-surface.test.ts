import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RevisitReport } from '@/components/revisit/revisit-report';
import type { RevisitJudgeReport } from '@/lib/revisit/types';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

const liveSource = readFileSync(
  new URL('../../app/classroom/[id]/revisit/page.tsx', import.meta.url),
  'utf8',
);
const historySource = readFileSync(
  new URL('../../components/revisit/review-panel.tsx', import.meta.url),
  'utf8',
);
const playbackSource = readFileSync(
  new URL('../../components/edit/PlaybackChromeRoot.tsx', import.meta.url),
  'utf8',
);
const canvasSource = readFileSync(
  new URL('../../components/canvas/canvas-area.tsx', import.meta.url),
  'utf8',
);
const reportComponentSource = readFileSync(
  new URL('../../components/revisit/revisit-report.tsx', import.meta.url),
  'utf8',
);

const report: RevisitJudgeReport = {
  attemptId: 'attempt-1',
  stageId: 'stage-1',
  completedAt: 1,
  summary: 'A balanced explanation.',
  dimensions: {
    clarity: 0.9,
    doubtResolution: 0.8,
    transfer: 0.7,
    errorCorrection: 0.6,
  },
  qRaw: 0.78,
  q: 0.78,
  errors: [
    {
      id: 'error-1',
      conceptId: 'concept-2',
      description: 'One factual slip.',
      corrected: true,
      severity: 'minor',
    },
  ],
  evidence: [],
  pageReports: [
    {
      pageId: 'page-1',
      pageIndex: 0,
      passed: true,
      probeCount: 2,
      conceptIds: ['concept-1'],
      notes: 'Passed after one follow-up.',
    },
  ],
  findingsVersion: 1,
  strengths: [
    {
      id: 'strength-1',
      title: 'Clear causal chain',
      feedback: 'The explanation connected each step.',
      dimension: 'clarity',
      conceptIds: ['concept-1'],
      citations: [
        {
          kind: 'transcript',
          sourceId: 'message-1',
          excerpt: 'First the signal is received, then the response begins.',
        },
      ],
    },
  ],
  improvements: [
    {
      id: 'improvement-1',
      title: 'Transfer further',
      feedback: 'Try applying the idea to a novel case.',
      dimension: 'transfer',
      conceptIds: ['concept-2'],
      citations: [
        {
          kind: 'pageReport',
          sourceId: 'page-1',
          pageId: 'page-1',
          pageIndex: 0,
          passed: true,
          probeCount: 2,
          conceptIds: ['concept-1'],
        },
      ],
    },
  ],
};

describe('shared Reverse report', () => {
  it.each(['full', 'compact'] as const)(
    'renders %s density with the same evidence and accessible radar',
    (density) => {
      const html = renderToStaticMarkup(
        createElement(RevisitReport, {
          report,
          density,
          conceptLabelsById: {
            'concept-1': 'Signal flow',
            'concept-2': 'Novel application',
          },
        }),
      );

      expect(html).toContain(`data-density="${density}"`);
      expect(html).toContain('role="img"');
      expect(html).toContain('revisit.report.radarDescription');
      expect(html).toContain('90%');
      expect(html).toContain('80%');
      expect(html).toContain('70%');
      expect(html).toContain('60%');
      expect(html).toContain('Clear causal chain');
      expect(html).toContain('Transfer further');
      expect(html).toContain('Signal flow');
      expect(html).toContain('Novel application');
      expect(html).toContain('First the signal is received');
      expect(html).toContain('revisit.report.pageEvidence');
      expect(html).toContain('One factual slip.');
      expect(html).toContain('revisit.report.pages');
    },
  );

  it('shows an explicit empty state for legacy evidence instead of inferring findings', () => {
    const html = renderToStaticMarkup(
      createElement(RevisitReport, {
        report: {
          ...report,
          findingsVersion: undefined,
          strengths: undefined,
          improvements: undefined,
        },
        density: 'compact',
      }),
    );

    expect(html).toContain('revisit.report.legacyEvidenceUnavailable');
    expect(html).not.toContain('Clear causal chain');
  });

  it('uses container-width-safe auto-fit grids instead of viewport breakpoints', () => {
    expect(reportComponentSource).not.toMatch(/(?:sm|md|lg):grid-cols/);
    expect(reportComponentSource.match(/gridTemplateColumns:/g)).toHaveLength(4);
    expect(reportComponentSource).toContain('repeat(auto-fit, minmax(min(100%');
  });

  it('allows unbroken trusted evidence to wrap without widening the report', () => {
    const html = renderToStaticMarkup(
      createElement(RevisitReport, {
        report: {
          ...report,
          strengths: [
            {
              ...report.strengths![0],
              citations: [
                {
                  kind: 'transcript',
                  sourceId: 'message-long',
                  excerpt: `https://example.invalid/${'unbroken'.repeat(30)}`,
                },
              ],
            },
          ],
        },
        density: 'compact',
      }),
    );

    expect(html).toMatch(
      /data-density="compact" class="[^"]*min-w-0[^"]*\[overflow-wrap:anywhere\]/,
    );
  });
});

describe('Reverse report integration contracts', () => {
  it('uses the shared report for both the live report and history detail', () => {
    expect(liveSource).toContain('<RevisitReport');
    expect(liveSource).toContain('density="full"');
    expect(historySource).toContain('<RevisitReport');
    expect(historySource).toContain('density="compact"');
    expect(liveSource).not.toContain('function ReportView(');
    expect(historySource).not.toContain('function ReportErrors(');
    expect(historySource).not.toContain('function PageReportList(');
  });

  it('threads the completion action separately from canvasOverlay', () => {
    expect(playbackSource).toContain('completionAction?: ClassroomCompleteAction');
    expect(canvasSource).toContain('completionAction={completionAction}');
    expect(liveSource).toContain('completionAction,');
    expect(liveSource).not.toContain('<ChallengeCompletionActions');
  });

  it('keeps report generation inline without duplicate toast notifications', () => {
    const finishStart = liveSource.indexOf('async function finishChallenge()');
    const finishSource = liveSource.slice(
      finishStart,
      liveSource.indexOf('if (!reverseChallengeEnabled)', finishStart),
    );

    expect(finishSource).not.toContain('toast.loading');
    expect(finishSource).not.toContain('toast.success');
    expect(finishSource).not.toContain('toast.error');
    expect(finishSource).not.toContain('toast.dismiss');
    expect(finishSource).toContain('setReport(nextReport);');
    expect(finishSource).toContain("setTailView('report');");
    expect(finishSource).toContain('setCurrentSceneId(REVISIT_REPORT_PAGE_ID)');
  });

  it('gives the judging button an accurate generating label', () => {
    const actionStart = liveSource.indexOf('const completionAction =');
    const actionSource = liveSource.slice(actionStart, liveSource.indexOf('return (', actionStart));

    expect(actionSource).toContain('label: judging');
    expect(actionSource).toContain("t('revisit.challenge.generatingReport')");
    expect(actionSource).toContain("t('revisit.challenge.retryReport')");
  });
});
