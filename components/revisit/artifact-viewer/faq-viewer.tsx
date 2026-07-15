'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import { filterStudyArtifactFaqItems } from '@/lib/revisit/artifact-view';
import type { FaqStudyArtifact, StudyArtifactFaqItem } from '@/lib/revisit/types';
import type { Scene } from '@/lib/types/stage';
import { cn } from '@/lib/utils';
import { SourceSceneReferences } from '@/components/revisit/artifact-viewer/source-scene-references';

export function FaqViewer({
  artifact,
  sourceScenes,
}: {
  artifact: FaqStudyArtifact;
  sourceScenes: Scene[];
}) {
  const { t } = useI18n();
  const firstItemId = artifact.content.items[0]?.id;
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(firstItemId ? [firstItemId] : []),
  );
  const [query, setQuery] = useState('');
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const conceptIds = useMemo(
    () =>
      [...new Set(artifact.content.items.flatMap((item) => item.conceptIds ?? []))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [artifact.content.items],
  );
  const visibleItems = useMemo(
    () => filterStudyArtifactFaqItems(artifact.content.items, query, selectedConceptId),
    [artifact.content.items, query, selectedConceptId],
  );
  const allVisibleOpen =
    visibleItems.length > 0 && visibleItems.every((item) => openIds.has(item.id));

  const toggleAll = () => {
    setOpenIds((current) => {
      const next = new Set(current);
      for (const item of visibleItems) {
        if (allVisibleOpen) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  };

  return (
    <article className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 print:max-w-none print:p-0">
      <header className="mb-0 flex items-end justify-between gap-4 border-b pb-6">
        <div>
          <p className="text-xs font-semibold uppercase text-rose-700 dark:text-rose-300">
            {t('revisit.studio.kinds.faq.title')}
          </p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">{artifact.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('revisit.viewer.questionCount', { count: artifact.content.items.length })}
          </p>
        </div>
        <Button variant="outline" size="sm" className="print:hidden" onClick={toggleAll}>
          {allVisibleOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          {allVisibleOpen ? t('revisit.viewer.collapseAll') : t('revisit.viewer.expandAll')}
        </Button>
      </header>

      <div className="border-b bg-muted/15 py-4 print:hidden">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            className="border-border/70 bg-white/75 ps-9 pe-10 dark:border-white/10 dark:bg-slate-950/35"
            placeholder={t('revisit.viewer.searchFaq')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 end-2 -translate-y-1/2"
              aria-label={t('revisit.viewer.clearSearch')}
              onClick={() => setQuery('')}
            >
              <X />
            </Button>
          ) : null}
        </div>
        {conceptIds.length > 0 ? (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            <TopicButton
              active={selectedConceptId === null}
              label={t('revisit.viewer.allTopics')}
              onClick={() => setSelectedConceptId(null)}
            />
            {conceptIds.map((conceptId) => (
              <TopicButton
                key={conceptId}
                active={selectedConceptId === conceptId}
                label={conceptId}
                onClick={() => setSelectedConceptId(conceptId)}
              />
            ))}
          </div>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          {t('revisit.viewer.faqResults', { count: visibleItems.length })}
        </p>
      </div>

      {visibleItems.length > 0 ? (
        <FaqList
          idPrefix="screen"
          items={visibleItems}
          openIds={openIds}
          sourceScenes={sourceScenes}
          className="print:hidden"
          onToggle={(itemId) => {
            setOpenIds((current) => {
              const next = new Set(current);
              if (next.has(itemId)) next.delete(itemId);
              else next.add(itemId);
              return next;
            });
          }}
        />
      ) : (
        <div className="border-b py-16 text-center print:hidden">
          <Search className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">{t('revisit.viewer.noFaqMatches')}</p>
        </div>
      )}

      <FaqList
        idPrefix="print"
        items={artifact.content.items}
        openIds={new Set(artifact.content.items.map((item) => item.id))}
        sourceScenes={sourceScenes}
        className="hidden print:block"
      />
    </article>
  );
}

function TopicButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 rounded-md border px-3 py-1.5 text-xs transition-colors',
        active
          ? 'border-rose-500 bg-rose-50 font-medium text-rose-800 dark:bg-rose-950/30 dark:text-rose-200'
          : 'border-border/70 bg-white/65 text-muted-foreground hover:bg-violet-50/60 hover:text-foreground dark:border-white/10 dark:bg-slate-950/30 dark:hover:bg-violet-500/10',
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FaqList({
  idPrefix,
  items,
  openIds,
  sourceScenes,
  className,
  onToggle,
}: {
  idPrefix: string;
  items: StudyArtifactFaqItem[];
  openIds: Set<string>;
  sourceScenes: Scene[];
  className?: string;
  onToggle?: (itemId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <ol className={cn('divide-y border-b', className)}>
      {items.map((item, index) => {
        const open = openIds.has(item.id);
        return (
          <li key={item.id} className="break-inside-avoid">
            <button
              type="button"
              className="flex w-full items-start gap-4 py-5 text-start print:hidden"
              aria-expanded={open}
              aria-controls={`${idPrefix}-faq-answer-${item.id}`}
              onClick={() => onToggle?.(item.id)}
            >
              <span className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-rose-700 dark:text-rose-300">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold">{item.question}</span>
                {item.conceptIds?.length ? (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {item.conceptIds.map((id) => (
                      <Badge key={id} variant="outline" className="font-normal">
                        {id}
                      </Badge>
                    ))}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                className={cn(
                  'mt-0.5 size-5 shrink-0 text-muted-foreground transition-transform',
                  open && 'rotate-180',
                )}
              />
            </button>
            <h2 className="hidden pt-5 text-base font-semibold print:block">
              {index + 1}. {item.question}
            </h2>
            <div
              id={`${idPrefix}-faq-answer-${item.id}`}
              className={cn(
                'faq-print-answer border-s-2 border-rose-300 pb-6 ps-4 text-[15px] leading-7 text-muted-foreground print:block',
                !open && 'hidden',
              )}
            >
              <p>{item.answer}</p>
              {item.sourceSceneIds?.length ? (
                <div className="mt-3 text-xs text-muted-foreground/75">
                  <span className="me-2">{t('revisit.viewer.sources')}:</span>
                  <SourceSceneReferences
                    sourceSceneIds={item.sourceSceneIds}
                    sourceScenes={sourceScenes}
                    className="mt-2"
                  />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
