import { describe, expect, it } from 'vitest';

import zhCN from '@/lib/i18n/locales/zh-CN.json';

describe('Simplified Chinese revisit settings labels', () => {
  it('uses the Spiral product name for the navigation label and page title', () => {
    expect(zhCN.settings.revisit.nav).toBe('Spiral');
    expect(zhCN.settings.revisit.title).toBe('Spiral');
  });
});
