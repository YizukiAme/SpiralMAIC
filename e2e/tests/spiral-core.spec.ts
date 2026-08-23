import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { test, expect } from '../fixtures/base';
import {
  seedV032SpiralScenario,
  SPIRAL_ARTIFACT_ID,
  SPIRAL_ATTEMPT_ID,
  SPIRAL_STAGE_ID,
} from '../fixtures/spiral-scenario';

const ACCESSIBILITY_VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
] as const;

async function expectNoCriticalOrSeriousViolations(page: Page, surface: string) {
  const originalViewport = page.viewportSize();
  for (const viewport of ACCESSIBILITY_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const results = await new AxeBuilder({ page })
      // Local `next dev` injects its own shadow-DOM toolbar; production builds do not ship it.
      .exclude('nextjs-portal')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    const blockingDetails = await Promise.all(
      blocking.flatMap((violation) =>
        violation.nodes.map(async (node) => {
          const target = node.target.join(' ');
          const locator = page.locator(target).first();
          const liveHtml = (await locator.count())
            ? await locator.evaluate((element) => element.outerHTML)
            : node.html;
          return `${violation.id} ${target} ${liveHtml.replace(/\s+/g, ' ')}`;
        }),
      ),
    );
    await test.info().attach(`a11y-${surface}-${viewport.label}`, {
      body: JSON.stringify(blocking, null, 2),
      contentType: 'application/json',
    });
    expect(
      blocking,
      `${surface} (${viewport.label}) has blocking accessibility violations:\n${blockingDetails.join('\n')}`,
    ).toEqual([]);
  }
  if (originalViewport) await page.setViewportSize(originalViewport);
}

test.describe('Spiral v0.4 core loop', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page, mockApi }) => {
    await mockApi.mockRevisitChat();
    await mockApi.mockRevisitJudge();
    await seedV032SpiralScenario(page);
  });

  test('reads v0.3.2 data and completes Reverse Challenge → report → Study Studio → overtime', async ({
    page,
  }) => {
    const courseCard = page.getByRole('button', { name: 'Photosynthesis review' });
    await expect(courseCard).toBeVisible();
    await expect(page.locator('[aria-label^="Memory "]')).toBeVisible();
    await expectNoCriticalOrSeriousViolations(page, 'home');

    await courseCard.focus();
    await courseCard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Reverse 1' }).click();
    await page.waitForURL(
      new RegExp(`/classroom/${SPIRAL_STAGE_ID}/revisit\\?attempt=${SPIRAL_ATTEMPT_ID}`),
    );
    await expect(page.getByText('Explain photosynthesis', { exact: true }).first()).toBeVisible();
    await expectNoCriticalOrSeriousViolations(page, 'reverse-challenge');

    await page.keyboard.press('T');
    const teacherInput = page.getByPlaceholder('Type your message...', { exact: true });
    await expect(teacherInput).toBeVisible();
    await teacherInput.fill(
      'Plants use light to turn water and carbon dioxide into sugar, storing energy chemically.',
    );
    await teacherInput.press('Enter');

    // Once the turn is handed back, the classroom intentionally hides the
    // finished speech bubble but keeps the student's question in the transcript.
    await expect(page.getByText('Could you give one real-world example?')).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(page.getByLabel('Has an unresolved question')).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('T');
    await expect(teacherInput).toBeVisible();
    await teacherInput.fill(
      'For a houseplant, less light usually means less sugar is produced and growth slows.',
    );
    await teacherInput.press('Enter');
    await expect(page.getByText('Passed', { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByText('Course complete', { exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'All challenge pages passed' })).toBeVisible();
    await page.getByRole('button', { name: 'Complete challenge' }).click();
    await expect(
      page.getByText('You clearly connected light energy to stored chemical energy.'),
    ).toBeVisible({ timeout: 15_000 });
    await expectNoCriticalOrSeriousViolations(page, 'reverse-report');

    await page.goto('/');
    await expect(courseCard).toBeVisible();
    await expect(page.locator('[aria-label^="Memory "]')).toBeVisible();
    await courseCard.focus();
    await courseCard.press('Enter');
    await expect(
      page.getByText('You clearly connected light energy to stored chemical energy.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Study materials' }).click();
    await expect(page.getByRole('heading', { name: 'My study materials' })).toBeVisible();
    await expectNoCriticalOrSeriousViolations(page, 'study-studio');
    await page.getByRole('button', { name: /Photosynthesis study guide/ }).click();
    await page.waitForURL(
      new RegExp(`/classroom/${SPIRAL_STAGE_ID}/study/${encodeURIComponent(SPIRAL_ARTIFACT_ID)}`),
    );
    await expect(
      page.getByRole('article').getByRole('heading', { name: 'Photosynthesis study guide' }),
    ).toBeVisible();
    await expect(
      page.getByText('Light energy is stored as chemical energy in sugar.'),
    ).toBeVisible();

    await page.goto(`/classroom/${SPIRAL_STAGE_ID}`);
    await expect(
      page.getByTestId('scene-title').filter({ hasText: 'Overtime: photosynthesis at home' }),
    ).toBeVisible();
    await expectNoCriticalOrSeriousViolations(page, 'classroom-with-overtime');
  });
});
