export const LEGACY_IMPORT_CONSENT_KEY = 'spiral:legacy-import-consent:v1';
export const LEGACY_IMPORT_OPEN_EVENT = 'openmaic:legacy-import-open';
export const LEGACY_IMPORT_CHANGED_EVENT = 'openmaic:legacy-import-changed';

export function isLegacyImportApproved(
  storage: Storage,
  ownerId: string,
  browserId: string,
): boolean {
  try {
    const saved = JSON.parse(storage.getItem(LEGACY_IMPORT_CONSENT_KEY) ?? 'null') as unknown;
    return (
      typeof saved === 'object' &&
      saved !== null &&
      'ownerId' in saved &&
      'browserId' in saved &&
      saved.ownerId === ownerId &&
      saved.browserId === browserId
    );
  } catch {
    return false;
  }
}

export function approveLegacyImport(storage: Storage, ownerId: string, browserId: string): void {
  storage.setItem(LEGACY_IMPORT_CONSENT_KEY, JSON.stringify({ ownerId, browserId }));
}

/** Every production importer uses the same owner/browser confirmation. */
export async function hasLegacyImportConsent(storage?: Storage): Promise<boolean> {
  try {
    const local = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    if (!local) return false;
    const { ensureLedger } = await import('./ledger');
    const { getPersistenceLearnerKey } = await import('@/lib/persistence/bootstrap');
    return isLegacyImportApproved(
      local,
      await getPersistenceLearnerKey(),
      ensureLedger(local).browserId,
    );
  } catch {
    return false;
  }
}
