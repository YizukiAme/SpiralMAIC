import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const localeFiles = [
  'ar-SA.json',
  'en-US.json',
  'ja-JP.json',
  'ko-KR.json',
  'pt-BR.json',
  'ru-RU.json',
  'zh-CN.json',
  'zh-TW.json',
];

const codexImageLocaleKeys = [
  'providerCodexImage',
  'codexImageLoginRequired',
  'codexImageConnected',
  'codexImageManageLogin',
  'codexImageFixedModel',
  'codexImageTestHint',
  'codexImagePlanLimits',
  'codexImageLoginValid',
] as const;

describe('Codex image settings surface contract', () => {
  it('uses an OAuth-specific fixed-model surface without credential or model CRUD controls', () => {
    const source = read('components/settings/image-settings.tsx');

    expect(source).toContain('getImageProviderCredentialMode');
    expect(source).toContain("credentialMode === 'oauth'");
    expect(source).toContain('onManageCodexLogin');
    expect(source).toContain('settings.codexImageLoginRequired');
    expect(source).toContain('settings.codexImageConnected');
    expect(source).toContain('settings.codexImageFixedModel');
    expect(source).toContain('settings.codexImageTestHint');
    expect(source).toContain('settings.codexImagePlanLimits');
    expect(source).toContain('settings.codexImageLoginValid');
    expect(source).toContain('/api/verify-image-provider');
    expect(source).not.toMatch(/data\.(error|message)/);
    expect(source).toMatch(/!isOAuth\s*&&\s*!isServerConfigured/);
    expect(source).toMatch(/!isOAuth\s*&&\s*\([\s\S]*settings\.addNewModel/);
    expect(source).not.toContain("selectedProviderId === 'codex-image'");
  });

  it('navigates inside Settings to the existing Codex LLM login', () => {
    const source = read('components/settings/index.tsx');

    expect(source).toMatch(
      /handleManageCodexLogin[\s\S]*setActiveSection\('providers'\)[\s\S]*setSelectedProviderId\('openai-codex'\)/,
    );
    expect(source).toContain('onManageCodexLogin={handleManageCodexLogin}');
    expect(source).toContain("'codex-image': 'providerCodexImage'");
    expect(source).toContain("'codex-image': '/logos/openai.svg'");
  });

  it('gates the media popover by OAuth publication and keeps the fixed model', () => {
    const availabilityPath = resolve(root, 'lib/media/image-provider-availability.ts');
    expect(existsSync(availabilityPath)).toBe(true);
    if (!existsSync(availabilityPath)) return;

    const availability = readFileSync(availabilityPath, 'utf8');
    const popover = read('components/generation/media-popover.tsx');
    expect(availability).toContain("credentialMode === 'oauth'");
    expect(availability).toContain('isServerConfigured === true');
    expect(popover).toContain('isImageProviderAvailable');
    expect(popover).toContain("'codex-image': '/logos/openai.svg'");
    expect(popover).toMatch(/credentialMode === 'oauth'\s*\?\s*p\.models/);
  });

  it('defines every Codex image key in all eight locales', () => {
    for (const localeFile of localeFiles) {
      const locale = JSON.parse(read(`lib/i18n/locales/${localeFile}`)) as {
        settings: Record<string, unknown>;
      };
      for (const key of codexImageLocaleKeys) {
        expect(locale.settings[key], `${localeFile}: settings.${key}`).toEqual(expect.any(String));
        expect(String(locale.settings[key]).trim()).not.toBe('');
      }
    }
  });
});
