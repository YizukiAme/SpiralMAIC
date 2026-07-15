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

async function inspectImportedDemoMedia(page: import('@playwright/test').Page, stageId: string) {
  return page.evaluate(async (importedStageId) => {
    const records = await new Promise<{
      scenes: Array<{ stageId: string }>;
      audio: Array<{ blob: Blob }>;
      media: Array<{ stageId: string; blob: Blob }>;
    }>((resolve, reject) => {
      const request = indexedDB.open('MAIC-Database');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(
          ['scenes', 'audioFiles', 'mediaFiles'],
          'readonly',
        );
        const sceneRequest = transaction.objectStore('scenes').getAll();
        const audioRequest = transaction.objectStore('audioFiles').getAll();
        const mediaRequest = transaction.objectStore('mediaFiles').getAll();
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          database.close();
          resolve({
            scenes: sceneRequest.result,
            audio: audioRequest.result,
            media: mediaRequest.result,
          });
        };
      };
    });

    const audioContext = new AudioContext();
    const decodedAudio = await audioContext.decodeAudioData(
      await records.audio[0].blob.arrayBuffer(),
    );
    await audioContext.close();
    const decodedImage = await createImageBitmap(records.media[0].blob);
    const imageWidth = decodedImage.width;
    decodedImage.close();

    return {
      sceneCount: records.scenes.filter((scene) => scene.stageId === importedStageId).length,
      audioCount: records.audio.length,
      mediaCount: records.media.filter((media) => media.stageId === importedStageId).length,
      audioDuration: decodedAudio.duration,
      imageWidth,
    };
  }, stageId);
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
  const stageId = decodeURIComponent(new URL(firstClassroomUrl).pathname.split('/').pop()!);
  const decodedMedia = await inspectImportedDemoMedia(page, stageId);
  expect(decodedMedia).toMatchObject({
    sceneCount: 12,
    audioCount: 66,
    mediaCount: 4,
  });
  expect(decodedMedia.audioDuration).toBeGreaterThan(0);
  expect(decodedMedia.imageWidth).toBeGreaterThan(0);

  await page.goto('/');
  await page
    .getByRole('region', { name: '演示课程' })
    .getByRole('button', { name: '打开演示课程：厚壁菌门与肥胖' })
    .click();

  await expect(page).toHaveURL(firstClassroomUrl);
  await expect.poll(() => countFeaturedDemoStages(page)).toBe(1);
});
