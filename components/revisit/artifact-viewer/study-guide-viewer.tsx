'use client';

import { useMemo, useState } from 'react';
import { BookOpen, ChevronDown, FileStack, List, Network } from 'lucide-react';

import { RichBlockDocument } from '@/components/revisit/artifact-viewer/rich-blocks';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  buildStudyGuideSections,
  collectStudyArtifactReferences,
} from '@/lib/revisit/artifact-view';
import type { StudyGuideArtifact } from '@/lib/revisit/types';
import { cn } from '@/lib/utils';

export function StudyGuideViewer({ artifact }: { artifact: StudyGuideArtifact }) {
  const { t } = useI18n();
  const sections = useMemo(
    () => buildStudyGuideSections(artifact.content.blocks, t('revisit.viewer.overview')),
    [artifact.content.blocks, t],
  );
  const references = useMemo(
    () => collectStudyArtifactReferences(artifact.content.blocks),
    [artifact.content.blocks],
  );
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(sections.map((section) => section.id)),
  );

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-8 md:grid-cols-[220px_minmax(0,820px)] md:px-8 lg:gap-14 print:block print:max-w-none print:p-0">
      <nav
        aria-label={t('revisit.viewer.tableOfContents')}
        className="hidden md:block print:hidden"
      >
        <div className="sticky top-24">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <List className="size-4" />
            {t('revisit.viewer.tableOfContents')}
          </div>
          <ol className="mt-4 space-y-1 border-s ps-3">
            {sections.map((section, index) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="group flex gap-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                >
                  <span className="font-mono text-[10px] text-muted-foreground/60 group-hover:text-primary">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span>{section.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </div>
      </nav>

      <article className="study-document min-w-0 bg-transparent print:border-0 print:ps-0">
        <header className="border-b pb-7">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-amber-700 dark:text-amber-300">
            <BookOpen className="size-4" />
            {t('revisit.studio.kinds.studyGuide.title')}
          </div>
          <h1 className="mt-3 text-3xl font-bold leading-tight sm:text-4xl">{artifact.title}</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {t('revisit.viewer.version', { version: artifact.version })} · {artifact.language}
          </p>
        </header>

        <div className="grid grid-cols-3 divide-x border-b bg-muted/15 py-4">
          <GuideMetric
            icon={<FileStack />}
            value={sections.length}
            label={t('revisit.viewer.sections')}
          />
          <GuideMetric
            icon={<Network />}
            value={references.conceptIds.length}
            label={t('revisit.viewer.concepts')}
          />
          <GuideMetric
            icon={<BookOpen />}
            value={references.sourceSceneIds.length}
            label={t('revisit.viewer.sourcePages')}
          />
        </div>

        <div>
          {sections.map((section, index) => {
            const open = openIds.has(section.id);
            return (
              <section key={section.id} id={section.id} className="scroll-mt-20 border-b py-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-4 py-5 text-start print:hidden"
                  aria-expanded={open}
                  aria-controls={`${section.id}-content`}
                  onClick={() => {
                    setOpenIds((current) => {
                      const next = new Set(current);
                      if (next.has(section.id)) next.delete(section.id);
                      else next.add(section.id);
                      return next;
                    });
                  }}
                >
                  <span className="font-mono text-xs text-amber-700 dark:text-amber-300">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1 text-xl font-semibold">{section.title}</span>
                  <ChevronDown
                    className={cn(
                      'size-5 shrink-0 text-muted-foreground transition-transform',
                      open && 'rotate-180',
                    )}
                  />
                </button>
                <h2 className="hidden pt-5 text-xl font-semibold print:block">{section.title}</h2>
                <div
                  id={`${section.id}-content`}
                  className={cn('pb-8 ps-0 sm:ps-8 print:block print:ps-0', !open && 'hidden')}
                >
                  <RichBlockDocument blocks={section.blocks} />
                </div>
              </section>
            );
          })}
        </div>
      </article>
    </div>
  );
}

function GuideMetric({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-3 px-2 sm:px-4">
      <span className="hidden text-amber-700 sm:block [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold tabular-nums">{value}</span>
        <span className="block truncate text-[10px] uppercase text-muted-foreground sm:text-xs">
          {label}
        </span>
      </span>
    </div>
  );
}
