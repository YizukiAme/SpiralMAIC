import { describe, expect, it } from 'vitest';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

const locales = {
  'ar-SA': arSA,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

const CODEX_KEYS = [
  'settings.providerNames.openai-codex',
  'settings.connected',
  'settings.codexOAuth.experimental',
  'settings.codexOAuth.connectTitle',
  'settings.codexOAuth.unavailableTitle',
  'settings.codexOAuth.unavailable.FEATURE_DISABLED',
  'settings.codexOAuth.unavailable.SERVERLESS_UNSUPPORTED',
  'settings.codexOAuth.unavailable.ACCESS_CODE_REQUIRED',
  'settings.codexOAuth.unavailable.DATA_DIR_UNWRITABLE',
  'settings.codexOAuth.connectedAs',
  'settings.codexOAuth.connected',
  'settings.codexOAuth.signInBrowser',
  'settings.codexOAuth.signInDevice',
  'settings.codexOAuth.waiting',
  'settings.codexOAuth.deviceInstructions',
  'settings.codexOAuth.openVerification',
  'settings.codexOAuth.copyCode',
  'settings.codexOAuth.copied',
  'settings.codexOAuth.cancel',
  'settings.codexOAuth.signOut',
  'settings.codexOAuth.models',
  'settings.codexOAuth.testConnection',
  'settings.codexOAuth.testSuccess',
  'settings.codexOAuth.testUnauthorized',
  'settings.codexOAuth.testForbidden',
  'settings.codexOAuth.testRateLimited',
  'settings.codexOAuth.testFailed',
  'settings.codexOAuth.loginFailed',
  'settings.codexOAuth.loginExpired',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON locale traversal
const get = (source: any, key: string) =>
  key.split('.').reduce((value, part) => value?.[part], source);

describe('Codex OAuth locale coverage', () => {
  it('keeps the same non-empty leaf shape in all eight locales', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      expect(
        messages.settings.providerNames['openai-codex'],
        `${locale} has the Codex provider display name`,
      ).toBe('Codex');
      for (const key of CODEX_KEYS) {
        const value = get(messages, key);
        expect(typeof value, `${locale} missing ${key}`).toBe('string');
        expect((value as string).trim(), `${locale} empty ${key}`).not.toBe('');
        expect(value, `${locale} echoes ${key}`).not.toBe(key);
      }
    }
  });

  it('uses the narrow experimental quota disclaimer without account-ban language', () => {
    expect(enUS.settings.codexOAuth.experimental).toBe(
      'Experimental third-party Codex integration; uses your ChatGPT plan quota.',
    );
    for (const messages of Object.values(locales)) {
      expect(messages.settings.codexOAuth.experimental).not.toMatch(/ban|suspend|封禁|封號|停權/i);
    }
  });
});
