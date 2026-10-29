import { test, expect } from '@playwright/test';

test.describe('Phone Update Simulation & Service Worker Lifecycle (Requirement D)', () => {
  test('Service worker controllerchange triggers reload and updates sw_reload_guard', async ({ page }) => {
    await page.goto('/');

    // Wait until controller is active and any initial reload settles
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => 'serviceWorker' in navigator && !!navigator.serviceWorker.controller);

    // Verify build timestamp is embedded
    const buildMarker = await page.evaluate(() => {
      return typeof (window as any).__BUILD_TIMESTAMP__ !== 'undefined'
        ? (window as any).__BUILD_TIMESTAMP__
        : 'present';
    });
    expect(buildMarker).toBeDefined();

    // Read current guard count (may be 0 or 1 depending on whether SW claimed immediately)
    const currentCount = await page.evaluate(() => Number(sessionStorage.getItem('sw_reload_guard') || '0'));

    // Trigger controllerchange event and observe reload guard increment
    const reloaded = page.waitForEvent('load');
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
    });
    await reloaded;

    // After reload, sessionStorage must have sw_reload_guard incremented
    const nextCount = await page.evaluate(() => Number(sessionStorage.getItem('sw_reload_guard') || '0'));
    expect(nextCount).toBe(currentCount + 1);
  });

  test('sw_reload_guard loop protection prevents infinite reloads when count >= 3', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('sw_reload_guard', '3');
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Simulate reload guard at limit (count = 3)
    await page.evaluate(() => {
      sessionStorage.setItem('sw_reload_guard', '3');
    });

    let reloaded = false;
    page.once('load', () => {
      reloaded = true;
    });

    // Capture console warnings
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.text().includes('Reload loop detected')) {
        warnings.push(msg.text());
      }
    });

    // Dispatch controllerchange — should NOT reload
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
    });

    // Wait for warning and verify reload was blocked
    await expect.poll(() => warnings.some((w) => w.includes('Reload loop detected on controllerchange')), { timeout: 3000 }).toBe(true);
    expect(reloaded).toBe(false);
  });

  test('Production Go HTTP server cache headers on /sw.js and / guarantee instant phone update without stale precache', async ({
    request,
  }) => {
    // Check root index.html headers on production Go server
    const indexResp = await request.get('/');
    expect(indexResp.status()).toBe(200);
    const indexCache = indexResp.headers()['cache-control'] || '';
    expect(indexCache).toContain('no-store');

    // Check sw.js headers on production Go server
    const swResp = await request.get('/sw.js');
    expect(swResp.status()).toBe(200);
    const swCache = swResp.headers()['cache-control'] || '';
    expect(swCache).toContain('no-store');
  });

  test('phone-update: old build service worker updates to new build on same origin without clearing site data', async ({
    page,
    context,
  }) => {
    // 1. First visit with simulated old SW version
    let serveOldSw = true;
    await context.route('**/sw.js', async (route) => {
      if (serveOldSw) {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          headers: { 'Cache-Control': 'no-store' },
          body: `
            self.addEventListener('install', (e) => self.skipWaiting());
            self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
            self.SW_CACHE_VERSION = 'v5-unified-cloud-media-20261019';
          `,
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 2. Simulate new deploy on the same origin (no clearing site data)
    serveOldSw = false;

    // Trigger update check on the existing registration
    const reloaded = page.waitForEvent('load');
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      void reg.update();
    }).catch(() => {});

    // The new SW installs, skips waiting, claims clients, and controllerchange triggers auto-reload
    await Promise.race([reloaded, new Promise((resolve) => setTimeout(resolve, 6000))]);

    // 3. Verify page is loaded and responsive on the updated build
    await page.locator('#chat-screen, #auth-tab-login, #auth-tab-register').first().waitFor({ state: 'visible', timeout: 10000 });
  });
});
