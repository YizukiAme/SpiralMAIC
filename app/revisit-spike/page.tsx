'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, GraduationCap, Loader2, Play, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import type { StatelessEvent } from '@/lib/types/chat';
import {
  createRevisitSeatSpikeRequest,
  parseRevisitSeatSpikeSse,
  summarizeRevisitSeatSpikeEvents,
} from '@/lib/revisit/seat-spike';

type RunState = 'idle' | 'running' | 'success' | 'failure';

export default function RevisitSeatSpikePage() {
  const { t } = useI18n();
  const [teacherUtterance, setTeacherUtterance] = useState(
    "Today I will explain the straw man fallacy: it attacks a weaker version of someone else's claim instead of answering the real claim.",
  );
  const [events, setEvents] = useState<StatelessEvent[]>([]);
  const [runState, setRunState] = useState<RunState>('idle');
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => summarizeRevisitSeatSpikeEvents(events), [events]);

  const statusLabel =
    runState === 'running'
      ? t('revisitSpike.statusRunning')
      : runState === 'success'
        ? t('revisitSpike.statusSuccess')
        : runState === 'failure'
          ? t('revisitSpike.statusFailure')
          : t('revisitSpike.statusIdle');

  async function runSpike() {
    const trimmed = teacherUtterance.trim();
    if (!trimmed || runState === 'running') return;

    setEvents([]);
    setError(null);
    setRunState('running');

    try {
      const modelConfig = getCurrentModelConfig();
      if (modelConfig.requiresApiKey && !modelConfig.isServerConfigured && !modelConfig.apiKey) {
        throw new Error(t('revisitSpike.missingModelConfig'));
      }

      const request = createRevisitSeatSpikeRequest({
        teacherUtterance: trimmed,
        model: modelConfig.modelString,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        providerType: modelConfig.providerType,
      });

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          ...(modelConfig.thinkingConfig ? { thinkingConfig: modelConfig.thinkingConfig } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`${t('revisitSpike.requestFailed')} (${response.status})`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(t('revisitSpike.requestFailed'));
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const collected: StatelessEvent[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseRevisitSeatSpikeSse(buffer);
        buffer = parsed.remaining;

        if (parsed.events.length > 0) {
          collected.push(...parsed.events);
          setEvents([...collected]);
        }
      }

      if (buffer.trim()) {
        const parsed = parseRevisitSeatSpikeSse(`${buffer}\n\n`);
        collected.push(...parsed.events);
        setEvents([...collected]);
      }

      const finalSummary = summarizeRevisitSeatSpikeEvents(collected);
      setRunState(
        finalSummary.dispatchedStudent &&
          finalSummary.studentResponded &&
          !finalSummary.errorMessage
          ? 'success'
          : 'failure',
      );
      if (finalSummary.errorMessage) setError(finalSummary.errorMessage);
    } catch (err) {
      setRunState('failure');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-normal">{t('revisitSpike.title')}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{t('revisitSpike.subtitle')}</p>
          </div>
          <Badge
            variant={
              runState === 'failure'
                ? 'destructive'
                : runState === 'success'
                  ? 'default'
                  : 'secondary'
            }
            className="h-7 self-start px-3 sm:self-auto"
          >
            {runState === 'running' ? <Loader2 className="animate-spin" /> : null}
            {runState === 'success' ? <CheckCircle2 /> : null}
            {runState === 'failure' ? <AlertTriangle /> : null}
            {statusLabel}
          </Badge>
        </header>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="rounded-lg border bg-background p-4 shadow-xs">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <UserRound className="size-4 text-primary" />
              {t('revisitSpike.teacherLabel')}
            </div>
            <Textarea
              value={teacherUtterance}
              onChange={(event) => setTeacherUtterance(event.target.value)}
              placeholder={t('revisitSpike.teacherPlaceholder')}
              className="min-h-44 resize-none"
              disabled={runState === 'running'}
            />
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="truncate text-xs text-muted-foreground">
                {t('revisitSpike.currentModel', { model: getCurrentModelConfig().modelString })}
              </p>
              <Button
                onClick={runSpike}
                disabled={!teacherUtterance.trim() || runState === 'running'}
              >
                {runState === 'running' ? <Loader2 className="animate-spin" /> : <Play />}
                {runState === 'running' ? t('revisitSpike.running') : t('revisitSpike.run')}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border bg-background p-4 shadow-xs">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <GraduationCap className="size-4 text-primary" />
              {t('revisitSpike.studentResponse')}
            </div>
            <div className="min-h-44 rounded-md bg-muted/40 p-3 text-sm leading-6">
              {summary.responseText ? (
                <p className="whitespace-pre-wrap">{summary.responseText}</p>
              ) : (
                <p className="text-muted-foreground">{t('revisitSpike.noResponse')}</p>
              )}
            </div>
            {error ? (
              <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border bg-background p-4 shadow-xs">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">{t('revisitSpike.eventLog')}</h2>
            <span className="text-xs text-muted-foreground">{events.length}</span>
          </div>
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-3 text-xs leading-5">
            {events.length > 0
              ? events.map((event, index) => `${index + 1}. ${event.type}`).join('\n')
              : t('revisitSpike.noEvents')}
          </pre>
        </section>
      </div>
    </main>
  );
}
