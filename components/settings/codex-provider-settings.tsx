'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  KeyRound,
  Loader2,
  LogOut,
  Send,
  ShieldAlert,
  Sparkles,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  CodexOAuthClient,
  syncCodexProviderAndSelect,
  syncServerProvidersAfterAccessUnlock,
  type CodexOAuthClientMessageKey,
  type CodexOAuthClientSnapshot,
} from '@/lib/client/codex-oauth';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { cn } from '@/lib/utils';
import { formatContextWindow } from './utils';

const INITIAL_SNAPSHOT: CodexOAuthClientSnapshot = {
  auth: null,
  attempt: null,
  busy: null,
  startingMethod: null,
  errorKey: null,
};

type TestState = {
  status: 'idle' | 'testing' | 'success' | 'error';
  messageKey: CodexOAuthClientMessageKey | null;
};

export function CodexProviderSettings() {
  const { t } = useI18n();
  const models = useSettingsStore((state) => state.providersConfig['openai-codex']?.models ?? []);
  const codexFastMode = useSettingsStore((state) => state.codexFastMode);
  const setCodexFastMode = useSettingsStore((state) => state.setCodexFastMode);
  const [snapshot, setSnapshot] = useState<CodexOAuthClientSnapshot>(INITIAL_SNAPSHOT);
  const [copied, setCopied] = useState(false);
  const [testState, setTestState] = useState<TestState>({ status: 'idle', messageKey: null });
  const clientRef = useRef<CodexOAuthClient | null>(null);

  useEffect(() => {
    const client = new CodexOAuthClient({
      fetcher: globalThis.fetch.bind(globalThis),
      openPopup: () => {
        const popup = window.open(
          'about:blank',
          'openmaic-codex-oauth',
          'popup,width=520,height=720',
        );
        if (!popup) return null;
        return {
          get closed() {
            return popup.closed;
          },
          navigate: (url) => popup.location.assign(url),
          close: () => popup.close(),
        };
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearSchedule: (handle) => window.clearTimeout(handle as number),
      onChange: setSnapshot,
      onLoginComplete: () =>
        syncCodexProviderAndSelect(() => {
          const state = useSettingsStore.getState();
          return {
            fetchServerProviders: state.fetchServerProviders,
            providersConfig: state.providersConfig,
            setModel: state.setModel,
          };
        }),
      onLogoutComplete: () =>
        syncServerProvidersAfterAccessUnlock(() => useSettingsStore.getState()),
    });
    clientRef.current = client;
    void client.mount();
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  const auth = snapshot.auth;
  const attempt = snapshot.attempt;
  const isPending = attempt?.status === 'pending';
  const isBusy = snapshot.busy !== null;
  const isSyncing = snapshot.busy === 'syncing';
  const supportsBrowser = auth?.methods.includes('browser') ?? false;
  const supportsDevice = auth?.methods.includes('device') ?? false;
  const deviceAttempt = attempt?.method === 'device' && isPending ? attempt : null;
  const hasFastModel = models.some((model) =>
    model.capabilities?.serviceTiers?.includes('priority'),
  );

  const startBrowser = () => {
    setCopied(false);
    setTestState({ status: 'idle', messageKey: null });
    void clientRef.current?.startBrowser();
  };

  const startDevice = () => {
    setCopied(false);
    setTestState({ status: 'idle', messageKey: null });
    void clientRef.current?.startDevice();
  };

  const copyDeviceCode = async () => {
    if (!deviceAttempt?.userCode) return;
    try {
      await navigator.clipboard.writeText(deviceAttempt.userCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const testConnection = async () => {
    const modelId = models[0]?.id;
    if (!modelId || !clientRef.current) return;
    setTestState({ status: 'testing', messageKey: null });
    const result = await clientRef.current.testConnection(modelId);
    setTestState({
      status: result.ok ? 'success' : 'error',
      messageKey: result.messageKey,
    });
  };

  if (!auth && snapshot.busy === 'loading') {
    return (
      <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        {t('settings.codexOAuth.waiting')}
      </div>
    );
  }

  if (auth && !auth.available) {
    const reasonKey = `settings.codexOAuth.unavailable.${auth.reason}`;
    const translatedReason = t(reasonKey);
    return (
      <div className="max-w-3xl space-y-4">
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{t('settings.codexOAuth.unavailableTitle')}</AlertTitle>
          <AlertDescription>
            {translatedReason === reasonKey
              ? t('settings.codexOAuth.unavailableTitle')
              : translatedReason}
          </AlertDescription>
        </Alert>
        <p className="text-sm text-muted-foreground">{t('settings.codexOAuth.experimental')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-5">
      {auth?.connected ? (
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                  {auth.email
                    ? t('settings.codexOAuth.connectedAs').replace('{email}', auth.email)
                    : t('settings.codexOAuth.connected')}
                </CardTitle>
              </div>
              <Badge variant="secondary">{t('settings.connected')}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {hasFastModel && (
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border/50 bg-muted/20 p-3">
                <div className="space-y-1">
                  <Label htmlFor="codex-fast-mode">{t('settings.codexOAuth.fastMode')}</Label>
                  <p id="codex-fast-mode-description" className="text-xs text-muted-foreground">
                    {t('settings.codexOAuth.fastModeDescription')}
                  </p>
                </div>
                <Switch
                  id="codex-fast-mode"
                  aria-label={t('settings.codexOAuth.fastMode')}
                  aria-describedby="codex-fast-mode-description"
                  checked={codexFastMode}
                  onCheckedChange={setCodexFastMode}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>{t('settings.codexOAuth.models')}</Label>
              <div className="space-y-1.5" aria-label={t('settings.codexOAuth.models')}>
                {models.map((model) => (
                  <div
                    key={model.id}
                    data-codex-model-row
                    className="flex items-center justify-between rounded-lg border border-border/50 bg-card p-3"
                  >
                    <div className="flex-1">
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">
                          {model.name || model.id}
                        </span>
                        {model.capabilities?.serviceTiers?.includes('priority') && (
                          <Badge
                            data-codex-fast-supported
                            variant="secondary"
                            className="h-4 px-1.5 text-[10px]"
                          >
                            {t('settings.codexOAuth.fastMode')}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1">
                          {model.capabilities?.vision && (
                            <span title={t('settings.capabilities.vision')}>
                              <Sparkles className="h-3 w-3" aria-hidden="true" />
                            </span>
                          )}
                          {model.capabilities?.tools && (
                            <span title={t('settings.capabilities.tools')}>
                              <Wrench className="h-3 w-3" aria-hidden="true" />
                            </span>
                          )}
                          {model.capabilities?.streaming && (
                            <span title={t('settings.capabilities.streaming')}>
                              <Zap className="h-3 w-3" aria-hidden="true" />
                            </span>
                          )}
                        </div>
                        {model.contextWindow && (
                          <span className="flex items-center gap-0.5">
                            <FileText className="h-3 w-3" aria-hidden="true" />
                            <span className="text-[10px]">
                              {formatContextWindow(model.contextWindow)}
                            </span>
                          </span>
                        )}
                        {model.outputWindow && (
                          <span className="flex items-center gap-0.5">
                            <Send className="h-3 w-3" aria-hidden="true" />
                            <span className="text-[10px]">
                              {formatContextWindow(model.outputWindow)}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void testConnection()}
                disabled={isBusy || testState.status === 'testing' || models.length === 0}
              >
                {testState.status === 'testing' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Zap className="h-4 w-4" aria-hidden="true" />
                )}
                {t('settings.codexOAuth.testConnection')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void clientRef.current?.logout()}
                disabled={isBusy}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {snapshot.busy === 'signing-out' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                )}
                {t('settings.codexOAuth.signOut')}
              </Button>
            </div>
            {testState.messageKey && (
              <div
                role="status"
                className={cn(
                  'overflow-hidden rounded-lg p-3 text-sm',
                  testState.status === 'success' &&
                    'bg-green-50 text-green-700 border border-green-200',
                  testState.status === 'error' && 'bg-red-50 text-red-700 border border-red-200',
                )}
              >
                <div className="flex min-w-0 items-start gap-2">
                  {testState.status === 'success' && (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  {testState.status === 'error' && (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <p className="min-w-0 flex-1 break-words">
                    {t(`settings.codexOAuth.${testState.messageKey}`)}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t('settings.codexOAuth.signInBrowser')}</CardTitle>
            <CardDescription>{t('settings.codexOAuth.experimental')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isSyncing && (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('settings.codexOAuth.waiting')}
              </div>
            )}
            {!isPending && (
              <div className="flex flex-wrap gap-2">
                {supportsBrowser && (
                  <Button type="button" onClick={startBrowser} disabled={isBusy}>
                    {snapshot.busy === 'starting' && snapshot.startingMethod === 'browser' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                    )}
                    {t('settings.codexOAuth.signInBrowser')}
                  </Button>
                )}
                {supportsDevice && (
                  <Button
                    type="button"
                    variant={supportsBrowser ? 'outline' : 'default'}
                    onClick={startDevice}
                    disabled={isBusy}
                  >
                    {snapshot.busy === 'starting' && snapshot.startingMethod === 'device' && (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    )}
                    {t('settings.codexOAuth.signInDevice')}
                  </Button>
                )}
              </div>
            )}

            {isPending && (
              <div className="space-y-4" aria-live="polite">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('settings.codexOAuth.waiting')}
                </div>
                {deviceAttempt?.userCode && deviceAttempt.verificationUrl && (
                  <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                    <p className="text-sm text-muted-foreground">
                      {t('settings.codexOAuth.deviceInstructions')}
                    </p>
                    <code className="block select-all rounded-md bg-background px-3 py-2 text-center font-mono text-lg tracking-wider">
                      {deviceAttempt.userCode}
                    </code>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" asChild>
                        <a
                          href={deviceAttempt.verificationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-4 w-4" aria-hidden="true" />
                          {t('settings.codexOAuth.openVerification')}
                        </a>
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={copyDeviceCode}>
                        {copied ? (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Copy className="h-4 w-4" aria-hidden="true" />
                        )}
                        {t(copied ? 'settings.codexOAuth.copied' : 'settings.codexOAuth.copyCode')}
                      </Button>
                    </div>
                  </div>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void clientRef.current?.cancel()}
                  disabled={snapshot.busy === 'cancelling'}
                >
                  {snapshot.busy === 'cancelling' && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  )}
                  {t('settings.codexOAuth.cancel')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {snapshot.errorKey && (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertDescription>{t(`settings.codexOAuth.${snapshot.errorKey}`)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
