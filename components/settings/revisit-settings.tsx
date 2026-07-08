'use client';

import { BrainCircuit } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';

export function RevisitSettings() {
  const { t } = useI18n();
  const reverseChallengeEnabled = useSettingsStore((s) => s.reverseChallengeEnabled);
  const stableSuccessesRequired = useSettingsStore((s) => s.stableSuccessesRequired);
  const forgettingSpeedMultiplier = useSettingsStore((s) => s.forgettingSpeedMultiplier);
  const demoAcceleratedClockEnabled = useSettingsStore((s) => s.demoAcceleratedClockEnabled);
  const demoGateSkipEnabled = useSettingsStore((s) => s.demoGateSkipEnabled);
  const setReverseChallengeEnabled = useSettingsStore((s) => s.setReverseChallengeEnabled);
  const setStableSuccessesRequired = useSettingsStore((s) => s.setStableSuccessesRequired);
  const setForgettingSpeedMultiplier = useSettingsStore((s) => s.setForgettingSpeedMultiplier);
  const setDemoAcceleratedClockEnabled = useSettingsStore((s) => s.setDemoAcceleratedClockEnabled);
  const setDemoGateSkipEnabled = useSettingsStore((s) => s.setDemoGateSkipEnabled);

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

      <div className="grid gap-4 md:grid-cols-2">
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

        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <Label>{t('settings.revisit.forgettingSpeed')}</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('settings.revisit.multiplierValue', {
                value: Number(forgettingSpeedMultiplier.toFixed(2)),
              })}
            </span>
          </div>
          <Slider
            min={0.25}
            max={4}
            step={0.25}
            value={[Math.min(4, Math.max(0.25, forgettingSpeedMultiplier))]}
            onValueChange={(value) => setForgettingSpeedMultiplier(value[0] ?? 1)}
          />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">{t('settings.revisit.demoArea')}</h3>
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="demo-accelerated-clock">{t('settings.revisit.acceleratedClock')}</Label>
          <Switch
            id="demo-accelerated-clock"
            checked={demoAcceleratedClockEnabled}
            onCheckedChange={setDemoAcceleratedClockEnabled}
          />
        </div>
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
