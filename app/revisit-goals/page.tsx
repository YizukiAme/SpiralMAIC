'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, BrainCircuit, CheckCircle2, LockKeyhole, Map } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { computeLessonMemory } from '@/lib/revisit/memory';
import type { LessonMemorySummary, UserConceptState } from '@/lib/revisit/types';

const DAY = 24 * 60 * 60 * 1000;

const DEMO_NODES = [
  {
    id: 'core-ideas',
    titleKey: 'revisit.goalMap.nodes.basics',
    offset: 'lg:translate-x-0',
    states: [
      {
        conceptId: 'core-definition',
        label: 'Core definition',
        hDays: 21,
        lastRetrievalDaysAgo: 1,
      },
      { conceptId: 'key-example', label: 'Key example', hDays: 14, lastRetrievalDaysAgo: 2 },
    ],
  },
  {
    id: 'transfer',
    titleKey: 'revisit.goalMap.nodes.causal',
    offset: 'lg:translate-x-14',
    states: [
      { conceptId: 'new-context', label: 'New context', hDays: 7, lastRetrievalDaysAgo: 5 },
      {
        conceptId: 'compare-cases',
        label: 'Compare cases',
        hDays: 6,
        lastRetrievalDaysAgo: 5,
      },
    ],
  },
  {
    id: 'correction',
    titleKey: 'revisit.goalMap.nodes.choiceTraps',
    offset: 'lg:-translate-x-10',
    states: [
      {
        conceptId: 'common-mistake',
        label: 'Common mistake',
        hDays: 4,
        lastRetrievalDaysAgo: 6,
      },
      {
        conceptId: 'repair-explanation',
        label: 'Repair explanation',
        hDays: 3,
        lastRetrievalDaysAgo: 7,
      },
    ],
  },
  {
    id: 'mastery',
    titleKey: 'revisit.goalMap.nodes.mastery',
    locked: true,
    offset: 'lg:translate-x-20',
    states: [],
  },
];

export default function RevisitGoalMapPage() {
  const { t } = useI18n();
  const stableSuccessesRequired = useSettingsStore((s) => s.stableSuccessesRequired);
  const forgettingSpeedMultiplier = useSettingsStore((s) => s.forgettingSpeedMultiplier);
  const demoAcceleratedClockEnabled = useSettingsStore((s) => s.demoAcceleratedClockEnabled);
  const [now] = useState(() => Date.now());

  const summaries = DEMO_NODES.map((node) => ({
    ...node,
    memory: node.locked
      ? null
      : computeLessonMemory(
          node.states.map((state) => createDemoState(state, now)),
          now,
          {
            stableSuccessesRequired,
            forgettingSpeedMultiplier: demoAcceleratedClockEnabled
              ? forgettingSpeedMultiplier * 1440
              : forgettingSpeedMultiplier,
          },
        ),
  }));

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-background/95 px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/">
              <ArrowLeft className="size-4" />
              {t('common.back')}
            </Link>
          </Button>
          <Badge variant="secondary">{t('revisit.goalMap.demoBadge')}</Badge>
        </div>
      </header>

      <section className="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Map className="size-4" />
              {t('revisit.goalMap.kicker')}
            </div>
            <h1 className="text-3xl font-semibold tracking-normal">{t('revisit.goalMap.title')}</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {t('revisit.goalMap.subtitle')}
            </p>
          </div>
        </div>

        <div className="relative grid gap-5 py-2">
          {summaries.map((node, index) => (
            <GoalNode
              key={node.id}
              title={t(node.titleKey)}
              index={index + 1}
              locked={node.locked}
              memory={node.memory}
              offset={node.offset}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function createDemoState(
  state: {
    conceptId: string;
    label: string;
    hDays: number;
    lastRetrievalDaysAgo: number;
  },
  now: number,
): UserConceptState {
  return {
    stageId: 'goal-map-preview',
    conceptId: state.conceptId,
    label: state.label,
    hDays: state.hDays,
    learnedAt: now - 18 * DAY,
    lastRetrievalAt: now - state.lastRetrievalDaysAgo * DAY,
    evidenceCount: 2,
    successChallengeDates: ['2026-07-07', '2026-07-08'],
    createdAt: now - 18 * DAY,
    updatedAt: now - state.lastRetrievalDaysAgo * DAY,
    stableAt: state.hDays >= 14 ? now - DAY : undefined,
  };
}

function GoalNode({
  title,
  index,
  locked,
  memory,
  offset,
}: {
  title: string;
  index: number;
  locked?: boolean;
  memory: LessonMemorySummary | null;
  offset: string;
}) {
  const { t } = useI18n();
  const color = memory?.color ?? '#94a3b8';
  return (
    <div className={`relative flex justify-center ${offset}`}>
      {index > 1 ? <div className="absolute -top-5 h-5 w-px bg-border" aria-hidden /> : null}
      <div
        className="grid w-full max-w-xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 rounded-lg border bg-background p-4 shadow-sm"
        style={{ borderColor: color }}
      >
        <div
          className="flex size-11 items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: color }}
        >
          {locked ? <LockKeyhole className="size-5" /> : <BrainCircuit className="size-5" />}
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">
            {locked
              ? t('revisit.goalMap.locked')
              : t(`revisit.memory.${memory?.status ?? 'unlearned'}`)}
          </p>
        </div>
        {!locked && memory?.badge === 'stable' ? (
          <CheckCircle2 className="size-5 text-emerald-500" />
        ) : null}
      </div>
    </div>
  );
}
