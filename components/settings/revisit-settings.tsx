'use client';

import { BrainCircuit } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';

export function RevisitSettings() {
  const { t } = useI18n();
  const reverseChallengeEnabled = useSettingsStore((s) => s.reverseChallengeEnabled);
  const stableSuccessesRequired = useSettingsStore((s) => s.stableSuccessesRequired);
  const demoGateSkipEnabled = useSettingsStore((s) => s.demoGateSkipEnabled);
  const setReverseChallengeEnabled = useSettingsStore((s) => s.setReverseChallengeEnabled);
  const setStableSuccessesRequired = useSettingsStore((s) => s.setStableSuccessesRequired);
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
