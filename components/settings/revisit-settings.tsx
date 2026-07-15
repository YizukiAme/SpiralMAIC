'use client';

import { useState } from 'react';
import { BrainCircuit, Clock3, Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  advanceRevisitDemoClock,
  restoreRealRevisitClock,
  startRevisitDemoClock,
} from '@/lib/revisit/clock';
import { useSettingsStore } from '@/lib/store/settings';

const CLOCK_STEPS = [1, 6, 24, 72, 168] as const;

export function RevisitSettings() {
  const { t } = useI18n();
  const reverseChallengeEnabled = useSettingsStore((s) => s.reverseChallengeEnabled);
  const stableSuccessesRequired = useSettingsStore((s) => s.stableSuccessesRequired);
  const activeDemoSessionId = useSettingsStore((s) => s.activeRevisitDemoSessionId);
  const offsetHours = useSettingsStore((s) => s.revisitVirtualClockOffsetHours);
  const demoGateSkipEnabled = useSettingsStore((s) => s.demoGateSkipEnabled);
  const setReverseChallengeEnabled = useSettingsStore((s) => s.setReverseChallengeEnabled);
  const setStableSuccessesRequired = useSettingsStore((s) => s.setStableSuccessesRequired);
  const setActiveDemoSession = useSettingsStore((s) => s.setActiveRevisitDemoSession);
  const setOffsetHours = useSettingsStore((s) => s.setRevisitVirtualClockOffsetHours);
  const setDemoGateSkipEnabled = useSettingsStore((s) => s.setDemoGateSkipEnabled);
  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  const advanceClock = async (hours: number) => {
    setClockBusy(true);
    setClockError(null);
    try {
      const session = activeDemoSessionId
        ? await advanceRevisitDemoClock(activeDemoSessionId, hours)
        : await startRevisitDemoClock();
      const advanced = activeDemoSessionId
        ? session
        : await advanceRevisitDemoClock(session.id, hours);
      setActiveDemoSession(advanced.id);
      setOffsetHours(advanced.offsetHours);
    } catch (error) {
      setClockError(error instanceof Error ? error.message : String(error));
    } finally {
      setClockBusy(false);
    }
  };

  const restoreClock = async () => {
    if (!activeDemoSessionId) return;
    setClockBusy(true);
    setClockError(null);
    try {
      await restoreRealRevisitClock(activeDemoSessionId);
      setActiveDemoSession(null);
      setOffsetHours(0);
    } catch (error) {
      setClockError(error instanceof Error ? error.message : String(error));
    } finally {
      setClockBusy(false);
    }
  };

  const simulatedAt = new Date(Date.now() + offsetHours * 60 * 60 * 1000);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <BrainCircuit className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="reverse-challenge-enabled" className="text-sm font-semibold">
              {t('settings.revisit.reverseChallenge')}
            </Label>
            <Switch
              id="reverse-challenge-enabled"
              checked={reverseChallengeEnabled}
              onCheckedChange={setReverseChallengeEnabled}
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t('settings.revisit.reverseChallengeDetail')}
          </p>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border p-4">
        <Label htmlFor="stable-successes-required">{t('settings.revisit.stableSuccesses')}</Label>
        <div className="flex items-center gap-3">
          <Input
            id="stable-successes-required"
            type="number"
            min={1}
            max={12}
            value={stableSuccessesRequired}
            onChange={(event) => setStableSuccessesRequired(Number(event.target.value))}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">{t('settings.revisit.timesUnit')}</span>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Clock3 className="size-4" />
              {t('settings.revisit.virtualClock')}
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('settings.revisit.virtualClockDetail')}
            </p>
          </div>
          {clockBusy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>

        <div className="rounded-md bg-muted/45 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('settings.revisit.simulatedTime')}</p>
          <p className="mt-1 text-sm font-medium tabular-nums">
            {activeDemoSessionId ? simulatedAt.toLocaleString() : t('settings.revisit.realTime')}
          </p>
          {activeDemoSessionId ? (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('settings.revisit.demoOffset', { hours: offsetHours })}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {CLOCK_STEPS.map((hours) => (
            <Button
              key={hours}
              type="button"
              variant="outline"
              size="sm"
              disabled={clockBusy || offsetHours >= 168}
              onClick={() => void advanceClock(hours)}
            >
              +{hours < 24 ? `${hours}h` : `${hours / 24}d`}
            </Button>
          ))}
        </div>

        {activeDemoSessionId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={clockBusy}
            onClick={() => void restoreClock()}
          >
            <RotateCcw />
            {t('settings.revisit.restoreRealTime')}
          </Button>
        ) : null}
        {clockError ? <p className="text-xs text-destructive">{clockError}</p> : null}
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        <h3 className="text-sm font-semibold">{t('settings.revisit.demoArea')}</h3>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="demo-gate-skip">{t('settings.revisit.gateSkip')}</Label>
          <Switch
            id="demo-gate-skip"
            checked={demoGateSkipEnabled}
            onCheckedChange={setDemoGateSkipEnabled}
          />
        </div>
      </div>
    </div>
  );
}
