'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Lightbulb, RotateCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { getStudyPractice, saveStudyPractice } from '@/lib/revisit/db';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createQuizPractice, scoreStudyQuiz } from '@/lib/revisit/study-practice';
import type {
  QuizStudyArtifact,
  QuizStudyPracticeState,
  StudyArtifactQuizItem,
} from '@/lib/revisit/types';
import { cn } from '@/lib/utils';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';
import { getRevisitNow } from '@/lib/revisit/clock';

export function QuizViewer({
  artifact,
  dataScope,
}: {
  artifact: QuizStudyArtifact;
  dataScope?: RevisitDataScope;
}) {
  const scope = dataScope ?? FORMAL_REVISIT_SCOPE;
  const { t } = useI18n();
  const [practice, setPractice] = useState<QuizStudyPracticeState>(() =>
    createQuizPractice({ artifactId: artifact.id, stageId: artifact.stageId }),
  );
  const [activeItemIds, setActiveItemIds] = useState<string[] | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const persistPractice = useCallback(
    (next: QuizStudyPracticeState, completedNow = false) => {
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
      if (cancelled || saved?.kind !== 'quiz') return;
      setPractice(saved);
      setSubmitted(Boolean(saved.completedAt));
      const firstUnanswered = artifact.content.items.findIndex(
        (item) => saved.answers[item.id] == null,
      );
      setCurrentIndex(Math.max(0, firstUnanswered));
    });
    return () => {
      cancelled = true;
    };
  }, [artifact.content.items, artifact.id, scope]);

  const activeItems = useMemo(() => {
    if (!activeItemIds) return artifact.content.items;
    const ids = new Set(activeItemIds);
    return artifact.content.items.filter((item) => ids.has(item.id));
  }, [activeItemIds, artifact.content.items]);
  const safeIndex = activeItems.length === 0 ? 0 : Math.min(currentIndex, activeItems.length - 1);
  const current = activeItems[safeIndex];
  const score = scoreStudyQuiz(activeItems, practice.answers);
  const allAnswered = activeItems.every((item) => practice.answers[item.id] != null);

  const handleChoose = (item: StudyArtifactQuizItem, optionIndex: number) => {
    const next = {
      ...practice,
      updatedAt: practice.updatedAt,
      completedAt: undefined,
      answers: { ...practice.answers, [item.id]: optionIndex },
      correctItemIds: practice.correctItemIds.filter((id) => id !== item.id),
    };
    setPractice(next);
    setSubmitted(false);
    persistPractice(next);
  };

  const submit = () => {
    if (!allAnswered) return;
    const fullResult = scoreStudyQuiz(artifact.content.items, practice.answers);
    const next: QuizStudyPracticeState = {
      ...practice,
      updatedAt: Date.now(),
      completedAt: Date.now(),
      correctItemIds: fullResult.correctItemIds,
    };
    setPractice(next);
    setSubmitted(true);
    persistPractice(next, true);
  };

  const retryWrong = () => {
    const result = scoreStudyQuiz(activeItems, practice.answers);
    const wrong = new Set(result.wrongItemIds);
    const answers = Object.fromEntries(
      Object.entries(practice.answers).filter(([id]) => !wrong.has(id)),
    );
    const next = { ...practice, answers, completedAt: undefined, updatedAt: Date.now() };
    setPractice(next);
    setActiveItemIds(result.wrongItemIds);
    setCurrentIndex(0);
    setSubmitted(false);
    setHintVisible(false);
    persistPractice(next);
  };

  return (
    <article className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-8 print:max-w-none print:p-0">
      <header className="mb-6 border-b pb-5 print:hidden">
        <p className="text-xs font-semibold uppercase text-blue-700 dark:text-blue-300">
          {t('revisit.studio.kinds.quiz.title')}
        </p>
        <h1 className="mt-2 text-2xl font-bold">{artifact.title}</h1>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-blue-600 transition-[width]"
            style={{
              width: `${activeItems.length ? ((safeIndex + 1) / activeItems.length) * 100 : 0}%`,
            }}
          />
        </div>
      </header>

      <div className="print:hidden">
        {submitted ? (
          <section className="space-y-6">
            <div className="border-y py-8 text-center">
              <p className="text-sm text-muted-foreground">{t('revisit.viewer.quizResult')}</p>
              <p className="mt-2 text-5xl font-bold tabular-nums text-blue-700 dark:text-blue-300">
                {score.percent}%
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('revisit.viewer.correctCount', {
                  correct: score.correct,
                  total: score.total,
                })}
              </p>
              {score.wrongItemIds.length > 0 ? (
                <Button className="mt-5" variant="outline" onClick={retryWrong}>
                  <RotateCw />
                  {t('revisit.viewer.retryWrong')}
                </Button>
              ) : null}
            </div>
            <ol className="divide-y border-y">
              {activeItems.map((item, index) => {
                const correct = practice.answers[item.id] === item.answerIndex;
                return (
                  <li key={item.id} className="break-inside-avoid px-3 py-5">
                    <div className="flex gap-3">
                      {correct ? (
                        <Check className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                      ) : (
                        <X className="mt-0.5 size-5 shrink-0 text-destructive" />
                      )}
                      <div>
                        <p className="font-semibold">
                          {index + 1}. {item.question}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">{item.explanation}</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : current ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-12">
            <section className="min-w-0">
              <p className="text-sm text-muted-foreground">
                {t('revisit.viewer.questionProgress', {
                  current: safeIndex + 1,
                  total: activeItems.length,
                })}
              </p>
              <h2 className="mt-3 text-xl font-semibold leading-relaxed sm:text-2xl">
                {current.question}
              </h2>
              {current.conceptIds?.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {current.conceptIds.map((id) => (
                    <span
                      key={id}
                      className="rounded-md border bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground"
                    >
                      {id}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-6 space-y-3">
                {current.options.map((option, optionIndex) => {
                  const selected = practice.answers[current.id] === optionIndex;
                  return (
                    <button
                      key={optionIndex}
                      type="button"
                      className={cn(
                        'flex min-h-14 w-full items-center gap-3 rounded-lg border px-4 py-3 text-start transition-colors',
                        selected
                          ? 'border-blue-500 bg-blue-50 text-blue-950 dark:bg-blue-950/30 dark:text-blue-50'
                          : 'hover:bg-muted/40',
                      )}
                      onClick={() => handleChoose(current, optionIndex)}
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold">
                        {String.fromCharCode(65 + optionIndex)}
                      </span>
                      <span>{option}</span>
                    </button>
                  );
                })}
              </div>
              {current.hint ? (
                <div className="mt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setHintVisible((value) => !value)}
                  >
                    <Lightbulb />
                    {t('revisit.viewer.hint')}
                  </Button>
                  {hintVisible ? (
                    <p className="mt-2 border-s-2 border-amber-500 ps-3 text-sm text-muted-foreground">
                      {current.hint}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-7 flex items-center justify-between gap-3 border-t pt-5">
                <Button
                  variant="outline"
                  disabled={safeIndex === 0}
                  onClick={() => {
                    setCurrentIndex((index) => Math.max(0, index - 1));
                    setHintVisible(false);
                  }}
                >
                  {t('revisit.viewer.previous')}
                </Button>
                {safeIndex === activeItems.length - 1 ? (
                  <Button disabled={!allAnswered} onClick={submit}>
                    {t('revisit.viewer.submitQuiz')}
                  </Button>
                ) : (
                  <Button
                    disabled={practice.answers[current.id] == null}
                    onClick={() => {
                      setCurrentIndex((index) => Math.min(activeItems.length - 1, index + 1));
                      setHintVisible(false);
                    }}
                  >
                    {t('revisit.viewer.next')}
                  </Button>
                )}
              </div>
            </section>

            <nav
              aria-label={t('revisit.studio.kinds.quiz.title')}
              className="order-first border-b pb-4 lg:order-none lg:border-b-0 lg:border-s lg:pb-0 lg:ps-6"
            >
              <div className="grid grid-cols-5 gap-2 sm:grid-cols-10 lg:grid-cols-4">
                {activeItems.map((item, index) => {
                  const answered = practice.answers[item.id] != null;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        'relative grid aspect-square place-items-center rounded-md border text-xs font-semibold transition-colors',
                        index === safeIndex && 'border-blue-500 bg-blue-50 text-blue-800',
                        index !== safeIndex && answered && 'border-emerald-300 bg-emerald-50',
                        index !== safeIndex && !answered && 'text-muted-foreground hover:bg-muted',
                      )}
                      aria-label={t('revisit.viewer.questionProgress', {
                        current: index + 1,
                        total: activeItems.length,
                      })}
                      aria-current={index === safeIndex ? 'step' : undefined}
                      onClick={() => {
                        setCurrentIndex(index);
                        setHintVisible(false);
                      }}
                    >
                      {index + 1}
                      {answered ? (
                        <span className="absolute end-1 bottom-1 size-1.5 rounded-full bg-emerald-500" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </nav>
          </div>
        ) : null}
      </div>

      <div className="hidden print:block">
        <h1 className="text-2xl font-bold">{artifact.title}</h1>
        <ol className="mt-6 space-y-6">
          {artifact.content.items.map((item, index) => (
            <li key={item.id} className="break-inside-avoid">
              <p className="font-semibold">
                {index + 1}. {item.question}
              </p>
              <ol className="mt-2 grid gap-1 ps-5">
                {item.options.map((option, optionIndex) => (
                  <li key={optionIndex}>
                    {String.fromCharCode(65 + optionIndex)}. {option}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
        <section className="mt-10 break-before-page">
          <h2 className="text-xl font-bold">{t('revisit.viewer.answerKey')}</h2>
          <ol className="mt-5 space-y-3">
            {artifact.content.items.map((item, index) => (
              <li key={item.id}>
                <span className="font-semibold">
                  {index + 1}. {String.fromCharCode(65 + item.answerIndex)}
                </span>{' '}
                {item.explanation}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </article>
  );
}
