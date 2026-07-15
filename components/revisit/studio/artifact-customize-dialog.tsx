'use client';

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  buildStudyArtifactSceneChoices,
  getDefaultStudyArtifactOptions,
} from '@/lib/revisit/artifact-options';
import type {
  BriefingStudyArtifactOptions,
  FaqStudyArtifactOptions,
  FlashcardsStudyArtifactOptions,
  MindMapStudyArtifactOptions,
  QuizStudyArtifactOptions,
  StudyArtifactFocusMode,
  StudyArtifactKind,
  StudyArtifactOptions,
  StudyGuideArtifactOptions,
} from '@/lib/revisit/types';
import type { Scene } from '@/lib/types/stage';
import { loadStageData } from '@/lib/utils/stage-storage';
import { cn } from '@/lib/utils';

interface ArtifactCustomizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stageId: string;
  kind: StudyArtifactKind;
  initialOptions?: StudyArtifactOptions;
  onGenerate: (options: StudyArtifactOptions) => void;
}

const FOCUS_MODES: StudyArtifactFocusMode[] = ['balanced', 'weak-points', 'selected-scenes'];

export function ArtifactCustomizeDialog({
  open,
  onOpenChange,
  stageId,
  kind,
  initialOptions,
  onGenerate,
}: ArtifactCustomizeDialogProps) {
  const { t } = useI18n();
  const [options, setOptions] = useState<StudyArtifactOptions>(
    () => initialOptions ?? getDefaultStudyArtifactOptions(kind),
  );
  const [scenes, setScenes] = useState<Scene[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadStageData(stageId).then((data) => {
      if (!cancelled) setScenes(data?.scenes ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [open, stageId]);

  const selectionInvalid =
    options.focusMode === 'selected-scenes' && options.selectedSceneIds.length === 0;
  const sceneChoices = useMemo(() => buildStudyArtifactSceneChoices(scenes), [scenes]);

  const updateCommon = (patch: Partial<StudyArtifactOptions>) => {
    setOptions((current) => ({ ...current, ...patch }) as StudyArtifactOptions);
  };

  const toggleScene = (sceneId: string, checked: boolean) => {
    const selected = new Set(options.selectedSceneIds);
    if (checked) selected.add(sceneId);
    else selected.delete(sceneId);
    updateCommon({ selectedSceneIds: [...selected] });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] max-w-[620px] flex-col gap-0 overflow-hidden border-border/60 bg-white/95 p-0 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/95">
        <DialogHeader className="border-b border-border/60 bg-white/45 px-6 py-5 pr-12 dark:border-white/10 dark:bg-slate-900/45">
          <DialogTitle>{t('revisit.studio.customize.title')}</DialogTitle>
          <DialogDescription>{t('revisit.studio.customize.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">{t('revisit.studio.customize.focus')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('revisit.studio.customize.focusDescription')}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {FOCUS_MODES.map((focusMode) => (
                <button
                  key={focusMode}
                  type="button"
                  aria-pressed={options.focusMode === focusMode}
                  className={cn(
                    'min-h-16 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    options.focusMode === focusMode
                      ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                      : 'border-border/70 bg-white/55 text-muted-foreground hover:bg-violet-50/60 hover:text-foreground dark:border-white/10 dark:bg-slate-950/30 dark:hover:bg-violet-500/10',
                  )}
                  onClick={() => updateCommon({ focusMode })}
                >
                  <span className="font-medium">
                    {t(`revisit.studio.customize.focusModes.${focusMode}.title`)}
                  </span>
                  <span className="mt-1 block text-xs leading-4">
                    {t(`revisit.studio.customize.focusModes.${focusMode}.description`)}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {options.focusMode === 'selected-scenes' ? (
            <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-medium">{t('revisit.studio.customize.selectScenes')}</h3>
              <div className="max-h-48 divide-y overflow-y-auto rounded-lg border border-border/70 bg-white/55 dark:divide-white/10 dark:border-white/10 dark:bg-slate-950/30">
                {sceneChoices.map(({ scene, number }) => (
                  <label
                    key={scene.id}
                    className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-violet-50/60 dark:hover:bg-violet-500/10"
                  >
                    <Checkbox
                      checked={options.selectedSceneIds.includes(scene.id)}
                      onCheckedChange={(checked) => toggleScene(scene.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {number}. {scene.title}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ) : null}

          <ArtifactSpecificOptions kind={kind} options={options} onChange={setOptions} />

          <section className="space-y-2 border-t pt-5">
            <label htmlFor="artifact-custom-instructions" className="text-sm font-medium">
              {t('revisit.studio.customize.customInstructions')}
            </label>
            <Textarea
              id="artifact-custom-instructions"
              value={options.customInstructions}
              maxLength={800}
              rows={4}
              placeholder={t('revisit.studio.customize.customInstructionsPlaceholder')}
              onChange={(event) => updateCommon({ customInstructions: event.target.value })}
            />
          </section>
        </div>

        <DialogFooter className="border-t border-border/60 bg-white/45 px-6 py-4 dark:border-white/10 dark:bg-slate-900/45">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={selectionInvalid}
            onClick={() => {
              onGenerate(options);
              onOpenChange(false);
            }}
          >
            {t('revisit.studio.generate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactSpecificOptions({
  kind,
  options,
  onChange,
}: {
  kind: StudyArtifactKind;
  options: StudyArtifactOptions;
  onChange: (options: StudyArtifactOptions) => void;
}) {
  const { t } = useI18n();
  const update = (patch: object) => onChange({ ...options, ...patch } as StudyArtifactOptions);

  if (kind === 'briefing') {
    const value = options as BriefingStudyArtifactOptions;
    return (
      <section className="grid gap-4 border-t pt-5 sm:grid-cols-2">
        <SelectField
          label={t('revisit.studio.customize.orientation')}
          value={value.orientation}
          values={['portrait', 'landscape', 'square']}
          onChange={(orientation) => update({ orientation })}
        />
        <SelectField
          label={t('revisit.studio.customize.detail')}
          value={value.detailLevel}
          values={['compact', 'standard', 'detailed']}
          onChange={(detailLevel) => update({ detailLevel })}
        />
      </section>
    );
  }

  if (kind === 'mindMap') {
    const value = options as MindMapStudyArtifactOptions;
    return (
      <section className="space-y-5 border-t pt-5">
        <SliderField
          label={t('revisit.studio.customize.depth')}
          value={value.depth}
          min={2}
          max={6}
          onChange={(depth) => update({ depth })}
        />
        <label className="flex items-center gap-3 text-sm">
          <Checkbox
            checked={value.includeExamples}
            onCheckedChange={(checked) => update({ includeExamples: checked === true })}
          />
          {t('revisit.studio.customize.includeExamples')}
        </label>
      </section>
    );
  }

  if (kind === 'studyGuide') {
    const value = options as StudyGuideArtifactOptions;
    return (
      <section className="border-t pt-5">
        <SelectField
          label={t('revisit.studio.customize.detail')}
          value={value.detailLevel}
          values={['compact', 'standard', 'detailed']}
          onChange={(detailLevel) => update({ detailLevel })}
        />
      </section>
    );
  }

  if (kind === 'faq') {
    const value = options as FaqStudyArtifactOptions;
    return (
      <section className="border-t pt-5">
        <SliderField
          label={t('revisit.studio.customize.itemCount')}
          value={value.count}
          min={3}
          max={30}
          onChange={(count) => update({ count })}
        />
      </section>
    );
  }

  if (kind === 'flashcards') {
    const value = options as FlashcardsStudyArtifactOptions;
    return (
      <section className="grid gap-5 border-t pt-5 sm:grid-cols-2">
        <SliderField
          label={t('revisit.studio.customize.itemCount')}
          value={value.count}
          min={5}
          max={50}
          step={5}
          onChange={(count) => update({ count })}
        />
        <SelectField
          label={t('revisit.studio.customize.difficulty')}
          value={value.difficulty}
          values={['easy', 'medium', 'hard']}
          onChange={(difficulty) => update({ difficulty })}
        />
      </section>
    );
  }

  const value = options as QuizStudyArtifactOptions;
  return (
    <section className="grid gap-5 border-t pt-5 sm:grid-cols-2">
      <SliderField
        label={t('revisit.studio.customize.itemCount')}
        value={value.count}
        min={3}
        max={30}
        onChange={(count) => update({ count })}
      />
      <SelectField
        label={t('revisit.studio.customize.difficulty')}
        value={value.difficulty}
        values={['easy', 'medium', 'hard']}
        onChange={(difficulty) => update({ difficulty })}
      />
    </section>
  );
}

function SelectField({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="space-y-2 text-sm">
      <span className="font-medium">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`revisit.studio.options.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next ?? value)}
      />
    </div>
  );
}
