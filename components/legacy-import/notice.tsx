'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LegacyImportConsentState, LegacyImportOutcome } from '@/lib/legacy-browser-import';
import {
  approveLegacyImport,
  LEGACY_IMPORT_CHANGED_EVENT,
  LEGACY_IMPORT_OPEN_EVENT,
} from '@/lib/legacy-browser-import/consent';

function progress(ledger: LegacyImportConsentState['ledger']) {
  const entries = [
    ...Object.values(ledger?.courses ?? {}),
    ...Object.values(ledger?.folders ?? {}),
  ];
  const mediaFailures = Object.values(ledger?.courses ?? {}).flatMap((course) =>
    Object.values(course.media ?? {}).filter((media) => media.status === 'failed'),
  );
  return {
    done: entries.filter((entry) => entry.status === 'done').length,
    pending: entries.filter((entry) => entry.status === 'pending').length,
    failed: entries.filter((entry) => entry.status === 'failed').length + mediaFailures.length,
    reasons: [
      ...entries.flatMap((entry) =>
        entry.status === 'failed' && entry.reason ? [entry.reason] : [],
      ),
      ...mediaFailures.map((media) => media.reason),
    ],
  };
}

/** Review and approve the one-time transfer of old browser data to this server. */
export function LegacyBrowserImportNotice() {
  const { t } = useI18n();
  const [state, setState] = useState<LegacyImportConsentState>();
  const [outcome, setOutcome] = useState<LegacyImportOutcome>();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const dismissed = useRef(false);

  const refresh = useCallback(async () => {
    const { getLegacyImportConsentState } = await import('@/lib/legacy-browser-import');
    const next = await getLegacyImportConsentState();
    setState(next);
    if (
      !dismissed.current &&
      (next.status === 'awaiting-consent' ||
        next.status === 'approved' ||
        next.status === 'unavailable')
    ) {
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const show = () => {
      dismissed.current = false;
      setOpen(true);
      void refresh();
    };
    const changed = () => {
      void refresh();
    };
    window.addEventListener(LEGACY_IMPORT_OPEN_EVENT, show);
    window.addEventListener(LEGACY_IMPORT_CHANGED_EVENT, changed);
    return () => {
      window.removeEventListener(LEGACY_IMPORT_OPEN_EVENT, show);
      window.removeEventListener(LEGACY_IMPORT_CHANGED_EVENT, changed);
    };
  }, [refresh]);

  const start = async () => {
    if (!state?.ownerId || !state.browserId) return;
    approveLegacyImport(localStorage, state.ownerId, state.browserId);
    setRunning(true);
    setOutcome(undefined);
    try {
      const { runApprovedLegacyBrowserImport } = await import('@/lib/legacy-browser-import');
      const result = await runApprovedLegacyBrowserImport();
      setOutcome(result);
      await refresh();
    } finally {
      setRunning(false);
    }
  };

  const counts = progress(state?.ledger);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismissed.current = true;
        setOpen(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('legacyImport.title')}</DialogTitle>
          <DialogDescription>
            {state?.status === 'awaiting-consent'
              ? t('legacyImport.transferDescription')
              : t('legacyImport.statusDescription')}
          </DialogDescription>
        </DialogHeader>

        {state?.status === 'awaiting-consent' ? (
          <p className="text-sm text-muted-foreground">{t('legacyImport.originalsRemain')}</p>
        ) : state?.status === 'no-legacy-data' ? (
          <p className="text-sm">{t('legacyImport.noData')}</p>
        ) : state?.status === 'unavailable' || !state ? (
          <p className="text-sm">{t('legacyImport.unavailable')}</p>
        ) : (
          <div className="space-y-2 text-sm" role="status" aria-live="polite">
            <p>
              {running
                ? t('legacyImport.running')
                : state.status === 'complete'
                  ? t('legacyImport.complete')
                  : t('legacyImport.pending')}
            </p>
            <p>{t('legacyImport.progress', counts)}</p>
            {outcome?.status === 'claimed-by-another-owner' && (
              <p>{t('legacyImport.otherOwner')}</p>
            )}
            {counts.failed > 0 && (
              <div>
                <p>{t('legacyImport.failed', { count: counts.failed })}</p>
                <ul className="list-disc pl-5">
                  {counts.reasons.slice(0, 3).map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {state?.status === 'awaiting-consent' ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  dismissed.current = true;
                  setOpen(false);
                }}
              >
                {t('legacyImport.later')}
              </Button>
              <Button
                disabled={running}
                onClick={() => {
                  void start();
                }}
              >
                {t('legacyImport.start')}
              </Button>
            </>
          ) : (
            <>
              {state?.status === 'unavailable' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    void refresh();
                  }}
                >
                  {t('common.retry')}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  dismissed.current = true;
                  setOpen(false);
                }}
              >
                {t('common.close')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
