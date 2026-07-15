import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Codex settings surface contract', () => {
  it('provides a dedicated panel without generic credential or model editing controls', () => {
    const path = resolve(root, 'components/settings/codex-provider-settings.tsx');
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const source = readFileSync(path, 'utf8');
    expect(source).not.toContain('ProviderConfigPanel');
    expect(source).not.toContain('llm-api-key');
    expect(source).not.toContain('llm-base-url');
    expect(source).not.toContain('/api/provider/probe-models');
    expect(source).not.toContain('ModelEditDialog');
    expect(source).toContain('settings.codexOAuth.connectTitle');
    expect(source).toContain('data-codex-model-row');
    expect(source).toContain('bg-green-50 text-green-700 border border-green-200');
    expect(source).toContain('bg-red-50 text-red-700 border border-red-200');
  });

  it('branches to the dedicated panel and preserves OAuth credential mode in list data', () => {
    const source = read('components/settings/index.tsx');

    expect(source).toContain('<CodexProviderSettings');
    expect(source).toContain("selectedProviderId === 'openai-codex'");
    expect(source).toMatch(
      /credentialMode:\s*providersConfig\[selectedProviderId\]\.credentialMode/,
    );
    expect(source).toMatch(/credentialMode:\s*config\.credentialMode/);
    expect(source).toMatch(
      /const\s+isCodexProviderSurface\s*=\s*activeSection === 'providers'\s*&&\s*selectedProviderId === 'openai-codex'/,
    );
    expect(source).toMatch(
      /\{!isCodexProviderSurface\s*&&\s*\(\s*<Button size="sm" onClick=\{handleSave\}>/,
    );
  });

  it('re-fetches server providers after access-code unlock', () => {
    const source = read('components/access-code-guard.tsx');

    expect(source).toContain('syncServerProvidersAfterAccessUnlock');
    expect(source).toContain('useSettingsStore.getState');
  });
});
