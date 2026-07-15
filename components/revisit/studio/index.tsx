'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock3,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { ArtifactCustomizeDialog } from '@/components/revisit/studio/artifact-customize-dialog';
import {
  STUDY_ARTIFACT_DEFINITIONS,
  STUDY_ARTIFACT_DEFINITION_BY_KIND,
} from '@/components/revisit/studio/artifact-definitions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ArtifactGenerationJob } from '@/lib/revisit/artifact-queue';
import { getDefaultStudyArtifactOptions } from '@/lib/revisit/artifact-options';
import { deleteStudyArtifact, renameStudyArtifact } from '@/lib/revisit/db';
import {
  groupArtifactGenerationJobs,
  groupStudyArtifacts,
  latestVisibleArtifactJobs,
  latestStudyArtifactByKind,
  STUDY_ARTIFACT_GROUPS,
} from '@/lib/revisit/studio';
import type { RevisitPanelSummary } from '@/lib/revisit/panel-summary';
import type { StudyArtifact, StudyArtifactKind, StudyArtifactOptions } from '@/lib/revisit/types';
import { useArtifactGenerationStore } from '@/lib/store/artifact-generation';
import type { StageListItem } from '@/lib/utils/stage-storage';
import { cn } from '@/lib/utils';
import { serializeRevisitScope, type RevisitDataScope } from '@/lib/revisit/scope';

interface StudyStudioProps {
  classroom: StageListItem | null;
  artifacts: RevisitPanelSummary['artifacts'];
  lessonCompleted: boolean;
  canGenerate: boolean;
  disabled: boolean;
  onOpenClassroom: (stageId: string) => void;
  onConfigureProvider: () => void;
  onOpenArtifact: (artifact: StudyArtifact) => void;
  onRefresh: () => void | Promise<void>;
  formatDateTime: (timestamp: number) => string;
  dataScope: RevisitDataScope;
}

export function StudyStudio({
  classroom,
  artifacts: artifactEntries,
  lessonCompleted,
  canGenerate,
  disabled,
  onOpenClassroom,
  onConfigureProvider,
  onOpenArtifact,
  onRefresh,
  formatDateTime,
  dataScope,
}: StudyStudioProps) {
  const { t } = useI18n();
  const allJobs = useArtifactGenerationStore((state) => state.jobs);
  const enqueue = useArtifactGenerationStore((state) => state.enqueue);
  const retry = useArtifactGenerationStore((state) => state.retry);
  const cancel = useArtifactGenerationStore((state) => state.cancel);
  const [customizingKind, setCustomizingKind] = useState<StudyArtifactKind | null>(null);
  const [renameTarget, setRenameTarget] = useState<StudyArtifact | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<StudyArtifact | null>(null);
  const refreshedArtifactIds = useRef(new Set<string>());

  const artifacts = useMemo(
    () => artifactEntries.map((entry) => entry.artifact),
    [artifactEntries],
  );
  const staleById = useMemo(
    () => new Map(artifactEntries.map((entry) => [entry.artifact.id, entry.stale])),
    [artifactEntries],
  );
  const latestByKind = useMemo(() => latestStudyArtifactByKind(artifacts), [artifacts]);
  const groupedArtifacts = useMemo(() => groupStudyArtifacts(artifacts), [artifacts]);
  const stageJobs = useMemo(
    () =>
      allJobs.filter(
        (job) =>
          job.stageId === classroom?.id &&
          (job.scope ?? 'formal') === serializeRevisitScope(dataScope),
      ),
    [allJobs, classroom?.id, dataScope],
  );
  const visibleJobByKind = useMemo(() => {
    return latestVisibleArtifactJobs(stageJobs);
  }, [stageJobs]);
  const libraryJobs = useMemo(
    () => Object.values(visibleJobByKind).filter(Boolean) as ArtifactGenerationJob[],
    [visibleJobByKind],
  );
  const groupedJobs = useMemo(() => groupArtifactGenerationJobs(libraryJobs), [libraryJobs]);

  useEffect(() => {
    for (const job of stageJobs) {
      if (job.status !== 'complete' || !job.artifactId) continue;
      if (artifacts.some((artifact) => artifact.id === job.artifactId)) continue;
      if (refreshedArtifactIds.current.has(job.artifactId)) continue;
      refreshedArtifactIds.current.add(job.artifactId);
      void onRefresh();
    }
  }, [artifacts, onRefresh, stageJobs]);

  const requestGeneration = (kind: StudyArtifactKind, options: StudyArtifactOptions) => {
    if (!classroom) return;
    if (!lessonCompleted) {
      onOpenClassroom(classroom.id);
      return;
    }
    if (!canGenerate) {
      onConfigureProvider();
      return;
    }
    enqueue({ stageId: classroom.id, kind, options, scope: serializeRevisitScope(dataScope) });
  };

  const openCustomize = (kind: StudyArtifactKind) => {
    if (!classroom) return;
    if (!lessonCompleted) {
      onOpenClassroom(classroom.id);
      return;
    }
    if (!canGenerate) {
      onConfigureProvider();
      return;
    }
    setCustomizingKind(kind);
  };

  return (
    <div className="space-y-7 pb-5">
      <section aria-labelledby="study-studio-create-heading" className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="study-studio-create-heading" className="text-base font-semibold">
              {t('revisit.studio.createTitle')}
            </h2>
          </div>
          {stageJobs.some((job) => job.status === 'queued') ? (
            <Badge variant="secondary">
              <Clock3 />
              {t('revisit.studio.queueActive')}
            </Badge>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STUDY_ARTIFACT_DEFINITIONS.map((definition) => {
            const latest = latestByKind[definition.kind];
            const job = visibleJobByKind[definition.kind];
            return (
              <ArtifactCreationTile
                key={definition.kind}
                definition={definition}
                latest={latest}
                job={job}
                disabled={disabled}
                lessonCompleted={lessonCompleted}
                canGenerate={canGenerate}
                onGenerate={() =>
                  requestGeneration(
                    definition.kind,
                    getDefaultStudyArtifactOptions(definition.kind),
                  )
                }
                onCustomize={() => openCustomize(definition.kind)}
                onRetry={() => job && retry(job.id)}
                onCancel={() => job && cancel(job.id)}
              />
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby="study-studio-library-heading"
        className="border-t border-border/60 pt-6 dark:border-white/10"
      >
        <div className="mb-4 px-1">
          <h2 id="study-studio-library-heading" className="text-base font-semibold">
            {t('revisit.studio.libraryTitle')}
          </h2>
        </div>

        {artifacts.length === 0 && libraryJobs.length === 0 ? (
          <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-border/60 bg-white/65 px-6 text-center shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/65">
            <Sparkles className="mb-3 size-5 text-muted-foreground" />
            <p className="text-sm font-medium">{t('revisit.studio.emptyTitle')}</p>
            <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
              {t('revisit.studio.emptyDescription')}
            </p>
          </div>
        ) : (
          <div className="divide-y overflow-hidden rounded-lg border border-border/60 bg-white/65 shadow-sm backdrop-blur-xl dark:divide-white/10 dark:border-white/10 dark:bg-slate-900/65">
            {STUDY_ARTIFACT_GROUPS.map((group) => {
              const groupArtifacts = groupedArtifacts[group.id];
              const groupJobs = groupedJobs[group.id];
              if (groupArtifacts.length === 0 && groupJobs.length === 0) return null;
              return (
                <div key={group.id} className="grid grid-cols-1 md:grid-cols-[160px_minmax(0,1fr)]">
                  <div className="border-b border-border/60 bg-slate-100/70 px-4 py-4 md:border-r md:border-b-0 dark:border-white/10 dark:bg-slate-950/35">
                    <h3 className="text-sm font-medium">
                      {t(`revisit.studio.groups.${group.id}.title`)}
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t(`revisit.studio.groups.${group.id}.description`)}
                    </p>
                  </div>
                  <div className="divide-y">
                    {groupJobs.map((job) => (
                      <ArtifactLibraryJobRow
                        key={job.id}
                        job={job}
                        formatDateTime={formatDateTime}
                        onRetry={() => retry(job.id)}
                        onCancel={() => cancel(job.id)}
                      />
                    ))}
                    {groupArtifacts.map((artifact) => (
                      <ArtifactLibraryRow
                        key={artifact.id}
                        artifact={artifact}
                        stale={staleById.get(artifact.id) ?? false}
                        formatDateTime={formatDateTime}
                        onOpen={() => onOpenArtifact(artifact)}
                        onRegenerate={() => requestGeneration(artifact.kind, artifact.options)}
                        onRename={() => {
                          setRenameTarget(artifact);
                          setRenameValue(artifact.title);
                        }}
                        onDelete={() => setDeleteTarget(artifact)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {classroom && customizingKind ? (
        <ArtifactCustomizeDialog
          open
          onOpenChange={(open) => !open && setCustomizingKind(null)}
          stageId={classroom.id}
          kind={customizingKind}
          initialOptions={latestByKind[customizingKind]?.options}
          onGenerate={(options) => requestGeneration(customizingKind, options)}
        />
      ) : null}

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-md border-border/60 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/95">
          <DialogHeader>
            <DialogTitle>{t('revisit.studio.renameTitle')}</DialogTitle>
            <DialogDescription>{t('revisit.studio.renameDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            maxLength={120}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.form?.requestSubmit();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!renameValue.trim()}
              onClick={async () => {
                if (!renameTarget) return;
                await renameStudyArtifact(renameTarget.id, renameValue.trim(), dataScope);
                setRenameTarget(null);
                await onRefresh();
                toast.success(t('revisit.studio.renamed'));
              }}
            >
              {t('revisit.studio.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="border-border/60 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/95">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('revisit.studio.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('revisit.studio.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (!deleteTarget) return;
                await deleteStudyArtifact(deleteTarget.id, dataScope);
                setDeleteTarget(null);
                await onRefresh();
                toast.success(t('revisit.studio.deleted'));
              }}
            >
              {t('revisit.studio.deleteAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ArtifactLibraryJobRow({
  job,
  formatDateTime,
  onRetry,
  onCancel,
}: {
  job: ArtifactGenerationJob;
  formatDateTime: (timestamp: number) => string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const definition = STUDY_ARTIFACT_DEFINITION_BY_KIND[job.kind];
  const Icon = definition.icon;
  const pending = job.status === 'queued' || job.status === 'generating';
  const focusLabel = t(`revisit.studio.customize.focusModes.${job.options.focusMode}.title`);
  const statusLabel = t(`revisit.studio.status.${job.status}`);

  return (
    <div
      className="relative flex min-h-20 items-center gap-3 overflow-hidden bg-slate-50/45 px-4 py-3 dark:bg-slate-950/25"
      aria-live="polite"
    >
      {pending ? (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-2/3 animate-pulse bg-primary/70" />
        </div>
      ) : null}
      <span
        className={cn(
          'relative grid size-9 shrink-0 place-items-center rounded-md',
          definition.iconBackgroundClassName,
        )}
      >
        <Icon className={cn('size-4', definition.iconClassName)} />
        {pending ? (
          <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full border bg-background">
            <Loader2 className="size-2.5 animate-spin text-primary" />
          </span>
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{t(definition.labelKey)}</p>
          <ArtifactJobBadge job={job} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {statusLabel} · {formatDateTime(job.createdAt)} · {focusLabel}
        </p>
        {job.status === 'failed' && job.error ? (
          <p className="mt-1 line-clamp-1 text-xs text-destructive" title={job.error}>
            {job.error}
          </p>
        ) : null}
      </div>
      {pending ? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X />
          <span className="hidden sm:inline">{t('revisit.studio.cancelGeneration')}</span>
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw />
          {t('revisit.studio.retry')}
        </Button>
      )}
    </div>
  );
}

function ArtifactCreationTile({
  definition,
  latest,
  job,
  disabled,
  lessonCompleted,
  canGenerate,
  onGenerate,
  onCustomize,
  onRetry,
  onCancel,
}: {
  definition: (typeof STUDY_ARTIFACT_DEFINITIONS)[number];
  latest?: StudyArtifact;
  job?: ArtifactGenerationJob;
  disabled: boolean;
  lessonCompleted: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  onCustomize: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const Icon = definition.icon;
  const pending = job?.status === 'queued' || job?.status === 'generating';
  const retryable = job?.status === 'failed' || job?.status === 'interrupted';

  return (
    <article className="flex min-h-[196px] flex-col rounded-lg border border-border/60 bg-white/75 p-4 shadow-sm shadow-slate-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/70 dark:shadow-black/20">
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-lg',
            definition.iconBackgroundClassName,
          )}
        >
          <Icon className={cn('size-5', definition.iconClassName)} />
        </span>
        <ArtifactJobBadge job={job} latest={latest} />
      </div>
      <div className="mt-4 min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{t(definition.labelKey)}</h3>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {t(definition.descriptionKey)}
        </p>
        {job?.status === 'failed' && job.error ? (
          <p className="mt-2 line-clamp-1 text-xs text-destructive" title={job.error}>
            {job.error}
          </p>
        ) : latest ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('revisit.studio.latestVersion', { version: latest.version })}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          className="min-w-0 flex-1"
          disabled={disabled || pending}
          onClick={retryable ? onRetry : onGenerate}
        >
          {pending ? (
            <Loader2 className="animate-spin" />
          ) : retryable ? (
            <RefreshCw />
          ) : (
            <Sparkles />
          )}
          <span className="truncate">
            {!lessonCompleted
              ? t('revisit.studio.openCourse')
              : !canGenerate
                ? t('home.configureProvider')
                : retryable
                  ? t('revisit.studio.retry')
                  : latest
                    ? t('revisit.studio.regenerate')
                    : t('revisit.studio.generate')}
          </span>
        </Button>
        <Button size="sm" variant="outline" disabled={disabled || pending} onClick={onCustomize}>
          <SlidersHorizontal />
          {t('revisit.studio.customizeButton')}
        </Button>
        {pending ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={onCancel}>
                <X />
                <span className="sr-only">{t('revisit.studio.cancelGeneration')}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('revisit.studio.cancelGeneration')}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </article>
  );
}

function ArtifactJobBadge({
  job,
  latest,
}: {
  job?: ArtifactGenerationJob;
  latest?: StudyArtifact;
}) {
  const { t } = useI18n();
  if (job?.status === 'generating') {
    return (
      <Badge variant="secondary">
        <Loader2 className="animate-spin" />
        {t('revisit.studio.status.generating')}
      </Badge>
    );
  }
  if (job?.status === 'queued') {
    return (
      <Badge variant="secondary">
        <Clock3 />
        {t('revisit.studio.status.queued')}
      </Badge>
    );
  }
  if (job?.status === 'failed') {
    return (
      <Badge variant="destructive">
        <AlertTriangle />
        {t('revisit.studio.status.failed')}
      </Badge>
    );
  }
  if (job?.status === 'interrupted') {
    return (
      <Badge variant="outline">
        <AlertTriangle />
        {t('revisit.studio.status.interrupted')}
      </Badge>
    );
  }
  if (latest) {
    return (
      <Badge variant="outline">
        <Check />
        {t('revisit.studio.status.ready')}
      </Badge>
    );
  }
  return <Badge variant="outline">{t('revisit.studio.status.empty')}</Badge>;
}

function ArtifactLibraryRow({
  artifact,
  stale,
  formatDateTime,
  onOpen,
  onRegenerate,
  onRename,
  onDelete,
}: {
  artifact: StudyArtifact;
  stale: boolean;
  formatDateTime: (timestamp: number) => string;
  onOpen: () => void;
  onRegenerate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const definition = STUDY_ARTIFACT_DEFINITION_BY_KIND[artifact.kind];
  const Icon = definition.icon;
  const focusLabel = t(`revisit.studio.customize.focusModes.${artifact.options.focusMode}.title`);
  const customFocus = artifact.options.customInstructions.trim();

  return (
    <div className="flex min-h-20 items-center gap-3 px-4 py-3 transition-colors hover:bg-violet-50/45 focus-within:bg-violet-50/45 dark:hover:bg-violet-500/8 dark:focus-within:bg-violet-500/8">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
      >
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-md',
            definition.iconBackgroundClassName,
          )}
        >
          <Icon className={cn('size-4', definition.iconClassName)} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{artifact.title}</span>
            <Badge variant="secondary">v{artifact.version}</Badge>
            {stale ? (
              <Badge
                variant="outline"
                className="border-cyan-200/70 bg-cyan-50/50 text-slate-500 dark:border-cyan-900/60 dark:bg-cyan-950/20 dark:text-slate-400"
              >
                <AlertTriangle />
                {t('revisit.studio.status.stale')}
              </Badge>
            ) : null}
          </span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {t(definition.labelKey)} · {formatDateTime(artifact.createdAt)} · {focusLabel}
            {customFocus ? ` · ${customFocus}` : ''}
          </span>
        </span>
      </button>

      <Button size="sm" variant="ghost" className="hidden sm:inline-flex" onClick={onOpen}>
        <Play />
        {t('revisit.studio.open')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost">
            <MoreHorizontal />
            <span className="sr-only">{t('revisit.studio.moreActions')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={onOpen}>
            <Play />
            {t('revisit.studio.open')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRegenerate}>
            <RefreshCw />
            {t('revisit.studio.regenerateSame')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRename}>
            <Pencil />
            {t('revisit.studio.rename')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 />
            {t('revisit.studio.deleteAction')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
