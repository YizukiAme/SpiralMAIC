'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, RotateCw, Shuffle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getStudyPractice, saveStudyPractice } from '@/lib/revisit/db';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createFlashcardPractice, recordFlashcardResult } from '@/lib/revisit/study-practice';
import type { FlashcardsStudyArtifact, FlashcardsStudyPracticeState } from '@/lib/revisit/types';
import { cn } from '@/lib/utils';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';
import { getRevisitNow } from '@/lib/revisit/clock';

export function FlashcardsViewer({
  artifact,
  dataScope,
}: {
  artifact: FlashcardsStudyArtifact;
  dataScope?: RevisitDataScope;
}) {
  const scope = dataScope ?? FORMAL_REVISIT_SCOPE;
  const { t } = useI18n();
  const [practice, setPractice] = useState<FlashcardsStudyPracticeState>(() =>
    createFlashcardPractice({ artifactId: artifact.id, stageId: artifact.stageId }),
  );
  const [order, setOrder] = useState(() => artifact.content.items.map((item) => item.id));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [onlyDifficult, setOnlyDifficult] = useState(false);
  const persistPractice = useCallback(
    (next: FlashcardsStudyPracticeState, completedNow = false) => {
      void getRevisitNow(scope).then((now) =>
        saveStudyPractice(
          {
            ...next,
            updatedAt: now,
            ...(completedNow ? { completedAt: now } : {}),
          },
          scope,
        ),
      );
    },
    [scope],
  );

  useEffect(() => {
    let cancelled = false;
    void getStudyPractice(artifact.id, scope).then((saved) => {
      if (cancelled || saved?.kind !== 'flashcards') return;
      setPractice(saved);
      setCurrentIndex(saved.currentIndex);
    });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, scope]);

  const cardsById = useMemo(
    () => new Map(artifact.content.items.map((item) => [item.id, item])),
    [artifact.content.items],
  );
  const deck = useMemo(() => {
    const cards = order
      .map((id) => cardsById.get(id))
      .filter((card): card is NonNullable<typeof card> => Boolean(card));
    return onlyDifficult
      ? cards.filter((card) => practice.difficultItemIds.includes(card.id))
      : cards;
  }, [cardsById, onlyDifficult, order, practice.difficultItemIds]);
  const safeIndex = deck.length === 0 ? 0 : Math.min(currentIndex, deck.length - 1);
  const current = deck[safeIndex];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.closest('button, a, input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        setFlipped((value) => !value);
        return;
      }
      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!delta || deck.length === 0) return;
      const nextIndex = (currentIndex + delta + deck.length) % deck.length;
      const nextPractice = { ...practice, currentIndex: nextIndex, updatedAt: Date.now() };
      setCurrentIndex(nextIndex);
      setPractice(nextPractice);
      persistPractice(nextPractice);
      setFlipped(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, deck.length, persistPractice, practice]);

  const moveTo = (index: number) => {
    if (deck.length === 0) return;
    const nextIndex = (index + deck.length) % deck.length;
    setCurrentIndex(nextIndex);
    setFlipped(false);
    const nextPractice = { ...practice, currentIndex: nextIndex, updatedAt: Date.now() };
    setPractice(nextPractice);
    persistPractice(nextPractice);
  };

  const mark = (mastered: boolean) => {
    if (!current) return;
    const nextIndex = deck.length === 0 ? 0 : (safeIndex + 1) % deck.length;
    const completedNow =
      !practice.completedAt &&
      new Set([...practice.masteredItemIds, ...practice.difficultItemIds, current.id]).size >=
        artifact.content.items.length;
    const next = {
      ...recordFlashcardResult(practice, current.id, mastered),
      currentIndex: nextIndex,
      completedAt: completedNow ? Date.now() : practice.completedAt,
    };
    setPractice(next);
    setCurrentIndex(nextIndex);
    setFlipped(false);
    persistPractice(next, completedNow);
  };

  const shuffle = () => {
    setOrder((currentOrder) => {
      const next = [...currentOrder];
      for (let index = next.length - 1; index > 0; index -= 1) {
        const target = Math.floor(Math.random() * (index + 1));
        [next[index], next[target]] = [next[target], next[index]];
      }
      return next;
    });
    setCurrentIndex(0);
    setFlipped(false);
  };

  return (
    <article className="mx-auto w-full max-w-5xl px-4 py-7 sm:px-8 print:max-w-none print:p-0">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b pb-5 print:hidden">
        <div>
          <p className="text-xs font-semibold uppercase text-violet-700 dark:text-violet-300">
            {t('revisit.studio.kinds.flashcards.title')}
          </p>
          <h1 className="mt-2 text-2xl font-bold">{artifact.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('revisit.viewer.flashcardsProgress', {
              mastered: practice.masteredItemIds.length,
              total: artifact.content.items.length,
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={shuffle}>
            <Shuffle />
            {t('revisit.viewer.shuffle')}
          </Button>
          <Button
            variant={onlyDifficult ? 'secondary' : 'outline'}
            size="sm"
            disabled={practice.difficultItemIds.length === 0}
            onClick={() => {
              setOnlyDifficult((value) => !value);
              setCurrentIndex(0);
              setFlipped(false);
            }}
          >
            <RotateCw />
            {t('revisit.viewer.onlyDifficult')}
          </Button>
        </div>
      </header>

      <div className="print:hidden">
        {current ? (
          <>
            <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {safeIndex + 1} / {deck.length}
              </span>
              <span>
                {practice.difficultItemIds.includes(current.id)
                  ? t('revisit.viewer.needsPractice')
                  : practice.masteredItemIds.includes(current.id)
                    ? t('revisit.viewer.mastered')
                    : t('revisit.viewer.unseen')}
              </span>
            </div>
            <div className="relative pe-3 pb-3">
              <div className="pointer-events-none absolute inset-0 translate-x-3 translate-y-3 rounded-lg border bg-muted/30" />
              <div className="pointer-events-none absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-lg border border-border/60 bg-white/65 dark:border-white/10 dark:bg-slate-950/35" />
              <button
                type="button"
                className={cn(
                  'relative z-10 flex min-h-[360px] w-full items-center justify-center rounded-lg border p-8 text-center shadow-sm transition-colors sm:min-h-[430px] sm:p-14',
                  flipped
                    ? 'border-violet-300 bg-violet-50 text-violet-950 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-50'
                    : 'border-border/70 bg-white/75 hover:bg-violet-50/45 dark:border-white/10 dark:bg-slate-950/35 dark:hover:bg-violet-500/10',
                )}
                aria-label={flipped ? t('revisit.viewer.showFront') : t('revisit.viewer.showBack')}
                onClick={() => setFlipped((value) => !value)}
              >
                <span className="max-w-2xl">
                  <span className="block text-xs font-semibold uppercase text-muted-foreground">
                    {flipped ? t('revisit.viewer.answer') : t('revisit.viewer.prompt')}
                  </span>
                  <span className="mt-5 block text-2xl font-semibold leading-relaxed sm:text-3xl">
                    {flipped ? current.back : current.front}
                  </span>
                  {current.conceptIds?.length ? (
                    <span className="mt-7 flex flex-wrap justify-center gap-1.5">
                      {current.conceptIds.map((id) => (
                        <Badge
                          key={id}
                          variant="outline"
                          className="bg-white/70 font-normal dark:bg-slate-900/70"
                        >
                          {id}
                        </Badge>
                      ))}
                    </span>
                  ) : null}
                  <span className="mt-8 block text-xs text-muted-foreground">
                    {flipped ? t('revisit.viewer.tapForFront') : t('revisit.viewer.tapToReveal')}
                  </span>
                </span>
              </button>
            </div>

            <div className="mt-4 flex gap-1 overflow-x-auto py-1" aria-hidden="true">
              {deck.map((card, index) => (
                <span
                  key={card.id}
                  className={cn(
                    'h-1.5 min-w-3 flex-1 rounded-full bg-muted',
                    index === safeIndex && 'bg-violet-500',
                    practice.masteredItemIds.includes(card.id) && 'bg-emerald-500',
                    practice.difficultItemIds.includes(card.id) && 'bg-rose-500',
                  )}
                />
              ))}
            </div>

            <div className="mt-5 grid grid-cols-[auto_1fr_1fr_auto] gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label={t('revisit.viewer.previous')}
                onClick={() => moveTo(safeIndex - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button variant="destructive" onClick={() => mark(false)}>
                <X />
                {t('revisit.viewer.notYet')}
              </Button>
              <Button
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={() => mark(true)}
              >
                <Check />
                {t('revisit.viewer.gotIt')}
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label={t('revisit.viewer.next')}
                onClick={() => moveTo(safeIndex + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          </>
        ) : (
          <div className="flex min-h-[360px] flex-col items-center justify-center border-y text-center">
            <Check className="size-7 text-emerald-600" />
            <p className="mt-3 font-semibold">{t('revisit.viewer.noDifficultCards')}</p>
            <Button className="mt-4" variant="outline" onClick={() => setOnlyDifficult(false)}>
              {t('revisit.viewer.backToAllCards')}
            </Button>
          </div>
        )}
      </div>

      <table className="hidden w-full border-collapse text-sm print:table">
        <thead>
          <tr>
            <th className="border p-3 text-start">{t('revisit.viewer.prompt')}</th>
            <th className="border p-3 text-start">{t('revisit.viewer.answer')}</th>
          </tr>
        </thead>
        <tbody>
          {artifact.content.items.map((card) => (
            <tr key={card.id} className="break-inside-avoid">
              <td className="w-1/2 border p-4 align-top">{card.front}</td>
              <td className="w-1/2 border p-4 align-top">{card.back}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
