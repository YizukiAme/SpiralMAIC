'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { RichBlockDocument } from '@/components/revisit/artifact-viewer/rich-blocks';
import { useI18n } from '@/lib/hooks/use-i18n';
import { collectStudyArtifactReferences } from '@/lib/revisit/artifact-view';
import type { BriefingStudyArtifact } from '@/lib/revisit/types';
import { cn } from '@/lib/utils';

export function BriefingViewer({ artifact }: { artifact: BriefingStudyArtifact }) {
  const { t } = useI18n();
  const references = collectStudyArtifactReferences(artifact.content.blocks);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentScale, setContentScale] = useState(1);

  useLayoutEffect(() => {
    const fit = () => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return;
      const nextScale = Math.min(1, viewport.clientHeight / Math.max(content.scrollHeight, 1));
      setContentScale(Math.max(0.68, Math.floor(nextScale * 100) / 100));
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [artifact.content.blocks, artifact.options.orientation]);
  return (
    <div className="flex justify-start overflow-x-auto p-4 sm:justify-center sm:p-8 print:block print:overflow-visible print:p-0">
      <article
        id="artifact-visual-export"
        data-artifact-kind="briefing"
        data-orientation={artifact.options.orientation}
        className={cn(
          'briefing-artboard relative shrink-0 overflow-hidden border bg-white text-neutral-900 shadow-lg print:border-0 print:shadow-none',
          artifact.options.orientation === 'portrait' && 'h-[1123px] w-[794px]',
          artifact.options.orientation === 'landscape' && 'h-[794px] w-[1123px]',
          artifact.options.orientation === 'square' && 'size-[900px]',
        )}
      >
        <div className="absolute inset-x-0 top-0 grid h-2 grid-cols-3">
          <span className="bg-cyan-600" />
          <span className="bg-violet-600" />
          <span className="bg-emerald-600" />
        </div>
        <div className="pointer-events-none absolute inset-5 border border-neutral-200" />
        <div className="flex h-full flex-col px-[7%] py-[6%]">
          <header className="mb-0 grid grid-cols-[minmax(0,1fr)_110px] items-stretch border-b-2 border-neutral-900">
            <div className="pb-5 pe-6">
              <p className="text-xs font-semibold uppercase text-cyan-700">
                Spiral Study Studio / Brief
              </p>
              <h1 className="mt-3 text-4xl font-bold leading-[1.08] text-neutral-950">
                {artifact.title}
              </h1>
            </div>
            <div className="flex flex-col justify-between border-s border-neutral-300 pb-5 ps-5 text-end">
              <span className="text-4xl font-light tabular-nums text-neutral-300">
                {String(artifact.version).padStart(2, '0')}
              </span>
              <span className="text-[10px] font-semibold uppercase text-neutral-500">
                {artifact.language}
              </span>
            </div>
          </header>
          <div className="mb-6 grid grid-cols-2 divide-x border-b border-neutral-200 py-3 text-neutral-700">
            <BriefingMetric
              value={references.conceptIds.length}
              label={t('revisit.viewer.concepts')}
            />
            <BriefingMetric
              value={references.sourceSceneIds.length}
              label={t('revisit.viewer.sourcePages')}
            />
          </div>
          <div ref={viewportRef} className="min-h-0 flex-1 overflow-hidden">
            <div
              ref={contentRef}
              style={{
                transform: `scale(${contentScale})`,
                transformOrigin: 'top left',
                width: `${100 / contentScale}%`,
              }}
            >
              <RichBlockDocument
                blocks={artifact.content.blocks}
                variant="briefing"
                className={cn(
                  'text-neutral-800 [&_h2]:border-neutral-300 [&_h2]:text-neutral-950 [&_h3]:text-neutral-950 [&_.text-muted-foreground]:text-neutral-600',
                  artifact.options.orientation === 'landscape' && 'grid-cols-3',
                )}
              />
            </div>
          </div>
          <footer className="mt-4 border-t border-neutral-200 pt-4 text-[10px] text-neutral-500">
            SpiralMAIC · {artifact.lessonSourceHash}
          </footer>
        </div>
      </article>
    </div>
  );
}

function BriefingMetric({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 first:ps-0 last:pe-0">
      <span className="text-[10px] font-semibold uppercase">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-neutral-950">{value}</span>
    </div>
  );
}
