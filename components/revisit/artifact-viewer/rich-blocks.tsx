import { AlertTriangle, BookOpen, Bookmark, Lightbulb, ShieldAlert } from 'lucide-react';

import type { StudyArtifactReferenceFields, StudyArtifactRichBlock } from '@/lib/revisit/types';
import { cn } from '@/lib/utils';

interface RichBlockDocumentProps {
  blocks: StudyArtifactRichBlock[];
  className?: string;
  variant?: 'document' | 'briefing';
}

export function RichBlockDocument({
  blocks,
  className,
  variant = 'document',
}: RichBlockDocumentProps) {
  const headingIds = createHeadingIds(blocks);
  let headingIndex = 0;

  return (
    <div
      className={cn(
        'study-rich-document text-foreground/90',
        variant === 'document' && 'space-y-5 text-[15px] leading-7',
        variant === 'briefing' && 'grid grid-cols-2 gap-3 text-sm leading-6',
        className,
      )}
    >
      {blocks.map((block, index) => {
        const headingId = block.type === 'heading' ? headingIds[headingIndex++] : undefined;
        return (
          <RichBlock
            key={`${block.type}:${index}`}
            block={block}
            headingId={headingId}
            variant={variant}
          />
        );
      })}
    </div>
  );
}

function RichBlock({
  block,
  headingId,
  variant,
}: {
  block: StudyArtifactRichBlock;
  headingId?: string;
  variant: 'document' | 'briefing';
}) {
  const data = referenceData(block);

  if (block.type === 'heading') {
    if (block.level === 3) {
      return (
        <h3
          id={headingId}
          className={cn(
            'scroll-mt-24 pt-2 text-base font-semibold text-foreground',
            variant === 'briefing' && 'col-span-full',
          )}
          {...data}
        >
          {block.text}
        </h3>
      );
    }
    return (
      <h2
        id={headingId}
        className={cn(
          'scroll-mt-24 border-b pb-2 text-xl font-semibold text-foreground',
          variant === 'briefing' && 'col-span-full text-lg',
        )}
        {...data}
      >
        {block.text}
      </h2>
    );
  }

  if (block.type === 'paragraph') {
    return (
      <p className={cn(variant === 'briefing' && 'col-span-full')} {...data}>
        {block.text}
      </p>
    );
  }

  if (block.type === 'list') {
    const List = block.style === 'numbered' ? 'ol' : 'ul';
    return (
      <section className="break-inside-avoid" {...data}>
        {block.title ? <h3 className="mb-2 font-semibold text-foreground">{block.title}</h3> : null}
        <List
          className={cn(
            'space-y-1.5 ps-5',
            block.style === 'numbered' ? 'list-decimal' : 'list-disc',
          )}
        >
          {block.items.map((item, index) => (
            <li key={index} {...referenceData(item)}>
              {item.text}
            </li>
          ))}
        </List>
      </section>
    );
  }

  if (block.type === 'callout') {
    const Icon =
      block.tone === 'tip'
        ? Lightbulb
        : block.tone === 'warning'
          ? AlertTriangle
          : block.tone === 'pitfall'
            ? ShieldAlert
            : Bookmark;
    return (
      <aside
        className={cn(
          'break-inside-avoid border-s-4 px-4 py-3',
          block.tone === 'tip' &&
            (variant === 'briefing'
              ? 'border-cyan-500 bg-cyan-50'
              : 'border-cyan-500 bg-cyan-50 dark:bg-cyan-950/30'),
          block.tone === 'remember' &&
            (variant === 'briefing'
              ? 'border-emerald-500 bg-emerald-50'
              : 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'),
          block.tone === 'warning' &&
            (variant === 'briefing'
              ? 'border-amber-500 bg-amber-50'
              : 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'),
          block.tone === 'pitfall' &&
            (variant === 'briefing'
              ? 'border-rose-500 bg-rose-50'
              : 'border-rose-500 bg-rose-50 dark:bg-rose-950/30'),
        )}
        {...data}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-white/70 text-current shadow-xs dark:bg-black/10">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground">{block.title}</h3>
            <p className="mt-1">{block.body}</p>
          </div>
        </div>
      </aside>
    );
  }

  if (block.type === 'definition') {
    return (
      <dl
        className={cn(
          'break-inside-avoid border-s-2 ps-4',
          variant === 'briefing' ? 'border-cyan-500' : 'border-primary/50',
        )}
        {...data}
      >
        <dt
          className={cn(
            'text-xs font-semibold uppercase text-cyan-700',
            variant === 'document' && 'dark:text-cyan-300',
          )}
        >
          {block.term}
        </dt>
        <dd
          className={cn(
            'mt-2 text-base font-medium leading-6',
            variant === 'briefing' ? 'text-neutral-800' : 'text-foreground/90',
          )}
        >
          {block.definition}
        </dd>
      </dl>
    );
  }

  if (block.type === 'example') {
    return (
      <figure
        className={cn(
          'break-inside-avoid rounded-lg border p-4',
          variant === 'briefing' ? 'border-neutral-200 bg-neutral-50' : 'bg-muted/20',
        )}
        {...data}
      >
        <figcaption
          className={cn(
            'flex items-center gap-2 font-semibold',
            variant === 'briefing' ? 'text-neutral-950' : 'text-foreground',
          )}
        >
          <BookOpen className="size-4 text-violet-600" />
          {block.title}
        </figcaption>
        {block.prompt ? (
          <p className="mt-3 border-s-2 border-violet-300 ps-3 font-medium">{block.prompt}</p>
        ) : null}
        <p className="mt-3 text-muted-foreground">{block.explanation}</p>
      </figure>
    );
  }

  if (block.type === 'comparison') {
    return (
      <section
        className={cn('break-inside-avoid', variant === 'briefing' && 'col-span-full')}
        {...data}
      >
        <h3 className="mb-3 font-semibold text-foreground">{block.title}</h3>
        <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
          <div
            className={cn(
              'p-4',
              variant === 'briefing' ? 'bg-white' : 'bg-white/55 dark:bg-slate-950/30',
            )}
          >
            <h4
              className={cn(
                'text-sm font-semibold text-cyan-700',
                variant === 'document' && 'dark:text-cyan-300',
              )}
            >
              {block.leftLabel}
            </h4>
            <p className="mt-2">{block.leftText}</p>
          </div>
          <div
            className={cn(
              'p-4',
              variant === 'briefing' ? 'bg-white' : 'bg-white/55 dark:bg-slate-950/30',
            )}
          >
            <h4
              className={cn(
                'text-sm font-semibold text-violet-700',
                variant === 'document' && 'dark:text-violet-300',
              )}
            >
              {block.rightLabel}
            </h4>
            <p className="mt-2">{block.rightText}</p>
          </div>
        </div>
        {block.takeaway ? (
          <p
            className={cn(
              'mt-2 text-sm font-medium',
              variant === 'briefing' ? 'text-neutral-900' : 'text-foreground',
            )}
          >
            {block.takeaway}
          </p>
        ) : null}
      </section>
    );
  }

  if (block.type === 'timeline') {
    return (
      <section className="break-inside-avoid" {...data}>
        {block.title ? <h3 className="mb-3 font-semibold text-foreground">{block.title}</h3> : null}
        <ol className="space-y-3 border-s-2 border-border ps-5">
          {block.entries.map((entry, index) => (
            <li key={index} className="relative" {...referenceData(entry)}>
              <span className="absolute top-0.5 -start-[2.1rem] grid size-6 place-items-center rounded-full border bg-white text-[10px] font-semibold text-primary dark:bg-slate-900">
                {index + 1}
              </span>
              <p
                className={cn(
                  'font-semibold',
                  variant === 'briefing' ? 'text-neutral-950' : 'text-foreground',
                )}
              >
                {entry.label}
              </p>
              <p className="mt-0.5 text-muted-foreground">{entry.text}</p>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <figure
      className={cn(
        'break-inside-avoid overflow-x-auto',
        variant === 'briefing' && 'col-span-full',
      )}
      {...data}
    >
      {block.title ? (
        <figcaption className="mb-2 font-semibold text-foreground">{block.title}</figcaption>
      ) : null}
      <table className="w-full border-collapse text-start text-sm">
        <thead>
          <tr>
            {block.columns.map((column) => (
              <th
                key={column}
                scope="col"
                className={cn(
                  'border px-3 py-2 text-start',
                  variant === 'briefing' ? 'bg-neutral-100' : 'bg-muted/50',
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex} {...referenceData(row)}>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex} className="border px-3 py-2 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function getRichBlockHeadings(
  blocks: StudyArtifactRichBlock[],
): Array<{ id: string; text: string; level: 2 | 3 }> {
  const headings = blocks.filter(
    (block): block is Extract<StudyArtifactRichBlock, { type: 'heading' }> =>
      block.type === 'heading',
  );
  const ids = createHeadingIds(blocks);
  return headings.map((heading, index) => ({ ...heading, id: ids[index] }));
}

function createHeadingIds(blocks: StudyArtifactRichBlock[]): string[] {
  const seen = new Map<string, number>();
  return blocks
    .filter((block) => block.type === 'heading')
    .map((block) => {
      const base = slugify(block.type === 'heading' ? block.text : 'section') || 'section';
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count === 1 ? base : `${base}-${count}`;
    });
}

function slugify(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function referenceData(value: StudyArtifactReferenceFields): {
  'data-concept-ids'?: string;
  'data-source-scene-ids'?: string;
} {
  return {
    'data-concept-ids': value.conceptIds?.join(',') || undefined,
    'data-source-scene-ids': value.sourceSceneIds?.join(',') || undefined,
  };
}
