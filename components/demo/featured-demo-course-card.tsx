'use client';

import Image from 'next/image';
import { ArrowRight, LoaderCircle, Sparkles } from 'lucide-react';

import { FEATURED_DEMO_COURSE, type FeaturedDemoPhase } from '@/lib/demo/featured-course';
import { cn } from '@/lib/utils';

interface FeaturedDemoCourseCardProps {
  course: typeof FEATURED_DEMO_COURSE;
  phase: FeaturedDemoPhase;
  error: string | null;
  onOpen: () => void;
}

function phaseLabel(phase: FeaturedDemoPhase, error: string | null) {
  if (error) return error;
  if (phase === 'downloading') return '正在下载演示课程…';
  if (phase === 'parsing' || phase === 'validating') return '正在准备演示课程…';
  if (phase === 'writingMedia' || phase === 'writingCourse') return '正在保存到浏览器…';
  return '12 页完整课程 · 点击即可体验';
}

export function FeaturedDemoCourseCard({
  course,
  phase,
  error,
  onOpen,
}: FeaturedDemoCourseCardProps) {
  const loading = phase !== 'idle' && phase !== 'done';

  return (
    <section aria-label={course.badge} className="relative z-10 mt-5 w-full max-w-3xl px-1">
      <button
        type="button"
        aria-label={`打开演示课程：${course.title}`}
        onClick={onOpen}
        disabled={loading}
        className={cn(
          'group grid w-full overflow-hidden rounded-3xl border border-emerald-200/70 bg-white/90 text-left shadow-lg shadow-emerald-950/[0.06] transition-all duration-300 dark:border-emerald-800/60 dark:bg-slate-900/90 sm:grid-cols-[minmax(240px,0.9fr)_minmax(0,1.1fr)]',
          loading
            ? 'cursor-wait'
            : 'cursor-pointer hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-xl hover:shadow-emerald-950/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 dark:hover:border-emerald-700',
        )}
      >
        <span className="relative block aspect-[16/9] min-h-44 overflow-hidden bg-emerald-50 sm:aspect-auto sm:min-h-48">
          <Image
            src={course.coverUrl}
            alt=""
            fill
            priority
            sizes="(max-width: 640px) 100vw, 340px"
            className="object-cover transition-transform duration-500 group-hover:scale-[1.02]"
          />
          <span className="absolute inset-0 bg-gradient-to-t from-slate-950/20 via-transparent to-white/5" />
        </span>

        <span className="flex min-w-0 flex-col justify-center p-6 sm:p-7">
          <span className="mb-3 inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
            <Sparkles className="size-3.5" />
            {course.badge}
          </span>
          <span
            role="heading"
            aria-level={2}
            className="text-balance text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-2xl"
          >
            {course.title}
          </span>
          <span
            className={cn(
              'mt-3 flex items-center gap-2 text-sm',
              error ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400',
            )}
          >
            {loading ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin" />
            ) : (
              <ArrowRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
            )}
            {phaseLabel(phase, error)}
          </span>
        </span>
      </button>
    </section>
  );
}
