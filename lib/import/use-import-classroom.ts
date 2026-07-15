'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';

import { ClassroomImportError, importClassroomBlob, type ImportPhase } from './classroom-import';

const log = createLogger('ImportClassroom');

export function useImportClassroom(onSuccess?: () => void) {
  const [importing, setImporting] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      event.target.value = '';

      setImporting(true);
      setPhase('parsing');
      const toastId = toast.loading(t('import.parsing'));

      try {
        const MAX_SAFE_SIZE = 200 * 1024 * 1024;
        if (file.size > MAX_SAFE_SIZE) {
          log.warn(`Large ZIP file: ${(file.size / 1024 / 1024).toFixed(0)}MB`);
        }

        await importClassroomBlob(file, {
          onPhase: (nextPhase) => {
            setPhase(nextPhase);
            if (nextPhase === 'validating') {
              toast.loading(t('import.validating'), { id: toastId });
            } else if (nextPhase === 'writingMedia') {
              toast.loading(t('import.writingMedia'), { id: toastId });
            } else if (nextPhase === 'writingCourse') {
              toast.loading(t('import.writingCourse'), { id: toastId });
            }
          },
        });

        toast.success(t('import.success'), { id: toastId });
        onSuccess?.();
      } catch (error) {
        log.error('Classroom ZIP import failed:', error);
        const isQuotaError = error instanceof DOMException && error.name === 'QuotaExceededError';
        const message = isQuotaError
          ? t('import.error.storageFull')
          : error instanceof ClassroomImportError && error.code === 'invalid-manifest'
            ? t('import.error.invalidManifest')
            : error instanceof ClassroomImportError && error.code === 'missing-data'
              ? t('import.error.missingData')
              : t('import.error.invalidZip');
        toast.error(message, { id: toastId });
      } finally {
        setImporting(false);
        setPhase('idle');
      }
    },
    [onSuccess, t],
  );

  return {
    importing,
    phase,
    fileInputRef,
    triggerFileSelect,
    handleFileChange,
  };
}
