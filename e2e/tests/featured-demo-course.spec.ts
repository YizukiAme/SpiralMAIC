import { expect, test } from '../fixtures/base';

async function countFeaturedDemoStages(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('stages', 'readonly');
          const stagesRequest = transaction.objectStore('stages').getAll();
          stagesRequest.onerror = () => reject(stagesRequest.error);
          stagesRequest.onsuccess = () => {
            const count = stagesRequest.result.filter(
              (stage) => stage.featuredDemoId === 'firmicutes-obesity',
            ).length;
            database.close();
            resolve(count);
          };
        };
      }),
  );
}

test('loads the featured demo once and reopens the same classroom', async ({ page }) => {
  await page.goto('/');

  const demo = page.getByRole('region', { name: '演示课程' });
  await expect(demo.getByRole('heading', { name: '厚壁菌门与肥胖' })).toBeVisible();
  const demoBounds = await demo.boundingBox();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(demoBounds).not.toBeNull();
  expect(demoBounds!.y + demoBounds!.height).toBeLessThanOrEqual(viewportHeight);
  await demo.getByRole('button', { name: '打开演示课程：厚壁菌门与肥胖' }).click();
  await expect(page).toHaveURL(/\/classroom\/[^/]+$/);
  const firstClassroomUrl = page.url();

  await page.goto('/');
  await page
    .getByRole('region', { name: '演示课程' })
    .getByRole('button', { name: '打开演示课程：厚壁菌门与肥胖' })
    .click();

  await expect(page).toHaveURL(firstClassroomUrl);
  await expect.poll(() => countFeaturedDemoStages(page)).toBe(1);
});
