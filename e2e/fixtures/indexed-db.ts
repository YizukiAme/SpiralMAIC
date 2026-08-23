import type { Page } from '@playwright/test';

/** Open the home app and wait for its IndexedDB migration instead of network idleness. */
export async function openHomeAndWaitForDatabase(
  page: Page,
  databaseName: string,
  objectStores: string[],
) {
  await page.goto('/', { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  await page.waitForFunction(
    async ({ name, stores }) => {
      if (!(await indexedDB.databases()).some((database) => database.name === name)) return false;
      return new Promise<boolean>((resolve) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          const database = request.result;
          const ready = stores.every((store) => database.objectStoreNames.contains(store));
          database.close();
          resolve(ready);
        };
        request.onerror = () => resolve(false);
      });
    },
    { name: databaseName, stores: objectStores },
  );
}
