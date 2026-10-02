import { describe, expect, it } from 'vitest';
import { isLegacyImportApproved, approveLegacyImport } from '@/lib/legacy-browser-import/consent';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe('legacy import consent', () => {
  it('does not authorize migration before confirmation', () => {
    expect(isLegacyImportApproved(storage(), 'owner-a', 'browser-a')).toBe(false);
  });

  it('authorizes only the confirmed owner and browser', () => {
    const local = storage();
    approveLegacyImport(local, 'owner-a', 'browser-a');
    expect(isLegacyImportApproved(local, 'owner-a', 'browser-a')).toBe(true);
    expect(isLegacyImportApproved(local, 'owner-b', 'browser-a')).toBe(false);
    expect(isLegacyImportApproved(local, 'owner-a', 'browser-b')).toBe(false);
  });
});
