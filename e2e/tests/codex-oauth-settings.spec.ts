import { expect, test } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

function serverProvidersBody(connected: boolean) {
  return JSON.stringify({
    providers: connected ? { 'openai-codex': { models: ['gpt-live', 'gpt-next'] } } : {},
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
  });
}

async function openCodexSettings(page: HomePage['page']) {
  const home = new HomePage(page);
  await home.goto();
  await expect(home.textarea).toBeVisible();
  await page.locator('button:has(svg.lucide-settings)').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('button', { name: /ChatGPT Codex/i })
    .first()
    .click();
  await expect(page.getByText(/Experimental third-party Codex integration/i).first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('Codex OAuth settings', () => {
  test('runs blocked-popup fallback, device completion, safe test, and logout fallback', async ({
    page,
  }) => {
    let connected = false;
    let completeNextPoll = false;
    const loginEvents: string[] = [];

    await page.addInitScript(
      ({ settings }) => {
        localStorage.setItem('settings-storage', settings);
        Object.defineProperty(window, 'open', { configurable: true, value: () => null });
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              (window as typeof window & { __codexCopied?: string }).__codexCopied = value;
            },
          },
        });
      },
      {
        settings: createSettingsStorage({
          providerId: 'openai',
          modelId: 'gpt-5.5',
          providersConfig: { openai: { apiKey: 'test-openai-key' } },
          autoConfigApplied: true,
        }),
      },
    );
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: serverProvidersBody(connected),
      }),
    );
    await page.route('**/api/codex/auth', async (route) => {
      if (route.request().method() === 'DELETE') {
        connected = false;
        loginEvents.push('DELETE auth');
        await route.fulfill({ status: 200, json: { connected: false } });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          available: true,
          reason: 'AVAILABLE',
          methods: ['browser', 'device'],
          connected,
          ...(connected ? { email: 'person@example.com' } : {}),
          accountId: 'sentinel-account-id',
        },
      });
    });
    await page.route('**/api/codex/auth/login', async (route) => {
      const method = route.request().method();
      if (method === 'POST') {
        const body = route.request().postDataJSON() as { method: 'browser' | 'device' };
        loginEvents.push(`POST ${body.method}`);
        await route.fulfill({
          status: 200,
          json:
            body.method === 'browser'
              ? {
                  method: 'browser',
                  status: 'pending',
                  authorizationUrl: 'https://auth.openai.com/oauth/authorize?public=1',
                  interval: 1,
                }
              : {
                  method: 'device',
                  status: 'pending',
                  verificationUrl: 'https://auth.openai.com/codex/device',
                  userCode: 'PLAY-WRITE',
                  interval: 1,
                  accessToken: 'sentinel-access-token',
                },
        });
        return;
      }
      if (method === 'DELETE') {
        loginEvents.push('DELETE login');
        await route.fulfill({ status: 200, json: { cancelled: true } });
        return;
      }
      loginEvents.push('PATCH login');
      if (completeNextPoll) {
        connected = true;
        completeNextPoll = false;
        await route.fulfill({ status: 200, json: { method: 'device', status: 'complete' } });
      } else {
        await route.fulfill({ status: 404, json: { errorCode: 'NO_ACTIVE_ATTEMPT' } });
      }
    });
    await page.route('**/api/verify-model', (route) =>
      route.fulfill({
        status: 429,
        json: { success: false, error: 'sentinel-private-upstream-body' },
      }),
    );

    await openCodexSettings(page);
    await expect(page.locator('input[name^="llm-api-key-openai-codex"]')).toHaveCount(0);
    await expect(page.locator('input[name^="llm-base-url-openai-codex"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
    await expect(page.getByText('PLAY-WRITE', { exact: true })).toBeVisible();
    expect(loginEvents.slice(-3)).toEqual(['POST browser', 'DELETE login', 'POST device']);
    await expect(page.getByRole('link', { name: 'Open verification page' })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device',
    );
    await page.getByRole('button', { name: 'Copy code' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as typeof window & { __codexCopied?: string }).__codexCopied,
      ),
    ).toBe('PLAY-WRITE');

    await page.getByRole('button', { name: 'Cancel sign-in' }).click();
    await expect(page.getByText('PLAY-WRITE', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Use device code' }).click();
    await expect(page.getByText('PLAY-WRITE', { exact: true })).toBeVisible();
    completeNextPoll = true;
    await expect(page.getByText('Connected with ChatGPT')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /ChatGPT Codex Connected/ })).toBeVisible();

    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(
      page.getByText('Your ChatGPT plan quota or rate limit has been reached.'),
    ).toBeVisible();
    await expect(page.getByText('sentinel-private-upstream-body')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('settings-storage');
          return raw ? JSON.parse(raw).state.providerId : null;
        }),
      )
      .toBe('openai');

    const storage = await page.evaluate(() => JSON.stringify(localStorage));
    expect(storage).not.toMatch(
      /sentinel-access-token|sentinel-account-id|sentinel-private-upstream-body/,
    );
  });

  test('shows a fixed unavailable state without credential controls', async ({ page }) => {
    await page.route('**/api/codex/auth', (route) =>
      route.fulfill({
        status: 200,
        json: {
          available: false,
          reason: 'SERVERLESS_UNSUPPORTED',
          methods: [],
          connected: false,
        },
      }),
    );

    await openCodexSettings(page);

    await expect(page.getByText('Codex sign-in is unavailable')).toBeVisible();
    await expect(
      page.getByText('Codex OAuth requires a self-hosted Node server with persistent storage.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('input[name^="llm-api-key-openai-codex"]')).toHaveCount(0);
  });

  test('retries server-provider discovery after access-code unlock', async ({ page }) => {
    let authenticated = false;
    let providerFetches = 0;
    await page.route('**/api/access-code/status', (route) =>
      route.fulfill({
        status: 200,
        json: { enabled: true, authenticated },
      }),
    );
    await page.route('**/api/access-code/verify', async (route) => {
      authenticated = true;
      await route.fulfill({ status: 200, json: { success: true } });
    });
    await page.route('**/api/server-providers', (route) => {
      providerFetches += 1;
      return route.fulfill(
        authenticated
          ? {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: serverProvidersBody(false),
            }
          : { status: 401, json: { errorCode: 'UNAUTHORIZED' } },
      );
    });

    await page.goto('/');
    await page.getByPlaceholder('Access code').fill('test-access-code');
    await page.getByPlaceholder('Access code').press('Enter');

    await expect.poll(() => providerFetches).toBeGreaterThanOrEqual(2);
  });
});
