'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  FileCode2,
  FileDown,
  ImageDown,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { ArtifactViewer } from '@/components/revisit/artifact-viewer';
import { SettingsDialog } from '@/components/settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isStudyArtifactStale } from '@/lib/revisit/source';
import {
  exportStudyArtifactElement,
  getStudyArtifactVisualExportFormats,
  type StudyArtifactVisualExportFormat,
} from '@/lib/revisit/artifact-export';
import { getStudyArtifact } from '@/lib/revisit/db';
import type { StudyArtifact } from '@/lib/revisit/types';
import type { Scene } from '@/lib/types/stage';
import { useArtifactGenerationStore } from '@/lib/store/artifact-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { hasUsableLLMProvider } from '@/lib/store/settings-validation';
import { loadStageData } from '@/lib/utils/stage-storage';
import { parseRevisitScope, serializeRevisitScope } from '@/lib/revisit/scope';
import { buildRevisitPanelReturnUrl, parseRevisitPanelSection } from '@/lib/revisit/home-surface';
import { RevisitDemoBadge } from '@/components/revisit/demo-badge';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; artifact: StudyArtifact; stale: boolean; sourceScenes: Scene[] };

const STUDY_VIEWER_PAGE_BACKGROUND =
  'bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900';

export default function StudyArtifactPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const stageId = String(params?.id ?? '');
  const artifactId = decodeArtifactId(String(params?.artifactId ?? ''));
  const dataScope = useMemo(() => parseRevisitScope(searchParams.get('scope')), [searchParams]);
  const serializedScope = serializeRevisitScope(dataScope);
  const returnSection = parseRevisitPanelSection(searchParams.get('returnSection')) ?? 'materials';
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState<StudyArtifactVisualExportFormat | null>(null);
  const [requestedJobId, setRequestedJobId] = useState<string | null>(null);
  const providersConfig = useSettingsStore((state) => state.providersConfig);
  const canGenerate = hasUsableLLMProvider(providersConfig);
  const jobs = useArtifactGenerationStore((state) => state.jobs);
  const enqueue = useArtifactGenerationStore((state) => state.enqueue);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [artifact, stageData] = await Promise.all([
          getStudyArtifact(artifactId, dataScope),
          loadStageData(stageId),
        ]);
        if (!artifact || artifact.stageId !== stageId) {
          throw new Error(t('revisit.viewer.notFound'));
        }
        if (!stageData?.stage) throw new Error(t('revisit.viewer.courseUnavailable'));
        if (cancelled) return;
        setLoadState({
          status: 'ready',
          artifact,
          sourceScenes: stageData.scenes,
          stale: isStudyArtifactStale({
            artifact,
            stage: stageData.stage,
            scenes: stageData.scenes,
          }),
        });
      } catch (error) {
        if (!cancelled) {
          setLoadState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [artifactId, dataScope, stageId, t]);

  const currentJob = useMemo(() => {
    if (loadState.status !== 'ready') return undefined;
    return [...jobs]
      .filter(
        (job) =>
          job.stageId === stageId &&
          (job.scope ?? 'formal') === serializedScope &&
          job.kind === loadState.artifact.kind &&
          ['queued', 'generating'].includes(job.status),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }, [jobs, loadState, serializedScope, stageId]);

  const requestedJob = useMemo(
    () => jobs.find((job) => job.id === requestedJobId),
    [jobs, requestedJobId],
  );

  useEffect(() => {
    if (!requestedJobId || !requestedJob) return;
    if (requestedJob.status === 'complete' && requestedJob.artifactId) {
      setRequestedJobId(null);
      router.replace(
        `/classroom/${requestedJob.stageId}/study/${encodeURIComponent(requestedJob.artifactId)}?scope=${encodeURIComponent(serializedScope)}&returnSection=${encodeURIComponent(returnSection)}`,
      );
      return;
    }
    if (['failed', 'cancelled', 'interrupted'].includes(requestedJob.status)) {
      toast.error(requestedJob.error || t('revisit.studio.status.failed'));
      setRequestedJobId(null);
    }
  }, [requestedJob, requestedJobId, returnSection, router, serializedScope, t]);

  const returnToSpiralPanel = () => {
    router.replace(buildRevisitPanelReturnUrl({ stageId, section: returnSection }));
  };

  const printArtifact = async () => {
    if (loadState.status !== 'ready') return;
    const hadDarkTheme = document.documentElement.classList.contains('dark');
    if (hadDarkTheme) document.documentElement.classList.remove('dark');
    document.documentElement.dataset.studyPrintKind = loadState.artifact.kind;
    document.documentElement.dataset.studyPrintOrientation =
      loadState.artifact.kind === 'briefing'
        ? loadState.artifact.options.orientation
        : loadState.artifact.kind === 'mindMap'
          ? 'landscape'
          : 'portrait';
    const pageStyle = document.createElement('style');
    pageStyle.id = 'study-artifact-print-page';
    const orientation = document.documentElement.dataset.studyPrintOrientation;
    pageStyle.textContent =
      orientation === 'square'
        ? '@page { size: 210mm 210mm; margin: 0; }'
        : orientation === 'landscape'
          ? '@page { size: A4 landscape; margin: 10mm; }'
          : loadState.artifact.kind === 'briefing'
            ? '@page { size: A4 portrait; margin: 0; }'
            : '@page { size: A4 portrait; margin: 14mm; }';
    document.head.appendChild(pageStyle);
    await document.fonts?.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    window.print();
    window.setTimeout(() => {
      delete document.documentElement.dataset.studyPrintKind;
      delete document.documentElement.dataset.studyPrintOrientation;
      pageStyle.remove();
      if (hadDarkTheme) document.documentElement.classList.add('dark');
    }, 500);
  };

  if (loadState.status === 'loading') {
    return (
      <main className={`grid min-h-screen place-items-center ${STUDY_VIEWER_PAGE_BACKGROUND}`}>
        <div className="text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-3 size-5 animate-spin" />
          {t('common.loading')}
        </div>
      </main>
    );
  }

  if (loadState.status === 'error') {
    return (
      <main className={`grid min-h-screen place-items-center px-6 ${STUDY_VIEWER_PAGE_BACKGROUND}`}>
        <div className="max-w-md rounded-lg border border-border/60 bg-white/80 p-6 text-center shadow-xl shadow-slate-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/80 dark:shadow-black/25">
          <AlertTriangle className="mx-auto size-7 text-destructive" />
          <h1 className="mt-4 text-lg font-semibold">{t('revisit.viewer.loadFailed')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{loadState.message}</p>
          <Button className="mt-5" variant="outline" onClick={returnToSpiralPanel}>
            <ArrowLeft />
            {t('common.back')}
          </Button>
        </div>
      </main>
    );
  }

  const artifact = loadState.artifact;
  const visualFormats = getStudyArtifactVisualExportFormats(artifact.kind);

  const exportVisual = async (format: StudyArtifactVisualExportFormat) => {
    const element = document.getElementById('artifact-visual-export');
    if (!element) {
      toast.error(t('revisit.viewer.exportFailed'));
      return;
    }
    setExporting(format);
    try {
      await exportStudyArtifactElement({
        element,
        title: artifact.title,
        version: artifact.version,
        format,
      });
      toast.success(t('revisit.viewer.exportComplete'));
    } catch {
      toast.error(t('revisit.viewer.exportFailed'));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className={`min-h-screen ${STUDY_VIEWER_PAGE_BACKGROUND}`}>
      <header className="study-viewer-toolbar sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border/60 bg-white/70 px-3 shadow-sm shadow-slate-950/5 backdrop-blur-xl sm:px-5 dark:border-white/10 dark:bg-slate-900/80 dark:shadow-black/20 print:hidden">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.back')}
          onClick={returnToSpiralPanel}
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold sm:text-base">{artifact.title}</h1>
            <Badge variant="secondary">v{artifact.version}</Badge>
            {loadState.stale ? (
              <Badge
                variant="outline"
                className="hidden border-cyan-200/70 bg-cyan-50/50 text-slate-500 sm:inline-flex dark:border-cyan-900/60 dark:bg-cyan-950/20 dark:text-slate-400"
              >
                <AlertTriangle />
                {t('revisit.studio.status.stale')}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 hidden truncate text-xs text-muted-foreground sm:block">
            {t(`revisit.studio.kinds.${artifact.kind}.title`)} · {artifact.language}
          </p>
        </div>
        <RevisitDemoBadge scope={dataScope} />
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(currentJob)}
          onClick={() => {
            if (!canGenerate) {
              setSettingsOpen(true);
              return;
            }
            const jobId = enqueue({
              stageId: artifact.stageId,
              kind: artifact.kind,
              options: artifact.options,
              scope: serializedScope,
            });
            setRequestedJobId(jobId);
          }}
        >
          {currentJob ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          <span className="hidden sm:inline">{t('revisit.studio.regenerate')}</span>
        </Button>
        {visualFormats.includes('png') ? (
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(exporting)}
            aria-label={t('revisit.viewer.exportPng')}
            onClick={() => void exportVisual('png')}
          >
            {exporting === 'png' ? <Loader2 className="animate-spin" /> : <ImageDown />}
            <span className="hidden lg:inline">PNG</span>
          </Button>
        ) : null}
        {visualFormats.includes('svg') ? (
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(exporting)}
            aria-label={t('revisit.viewer.exportSvg')}
            onClick={() => void exportVisual('svg')}
          >
            {exporting === 'svg' ? <Loader2 className="animate-spin" /> : <FileCode2 />}
            <span className="hidden lg:inline">SVG</span>
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void printArtifact()}>
          <FileDown />
          <span className="hidden sm:inline">{t('revisit.viewer.exportPdf')}</span>
        </Button>
      </header>

      <main className="study-artifact-viewer min-h-[calc(100dvh-4rem)] print:min-h-0">
        <ArtifactViewer
          key={artifact.id}
          artifact={artifact}
          dataScope={dataScope}
          sourceScenes={loadState.sourceScenes}
        />
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialSection="providers"
      />
    </div>
  );
}

function decodeArtifactId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
