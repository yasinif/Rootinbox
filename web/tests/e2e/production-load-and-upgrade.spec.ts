import { test, expect, type Page } from '@playwright/test';
import { randomTestUsername } from '../test-random';

test.describe('Production App Load, HTTPS, Device-Check & SW Upgrade', () => {
  test('1. Root / renders Login and Register UI with correct asset MIME types and no HTTP/2 errors', async ({ page }) => {
    const failedRequests: { url: string; error: string }[] = [];
    const consoleErrors: string[] = [];
    const responses: { url: string; status: number; contentType: string }[] = [];

    page.on('requestfailed', (req) => {
      failedRequests.push({ url: req.url(), error: req.failure()?.errorText || 'unknown' });
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore expected non-fatal browser vibration permission warning and initial unauthenticated session 401
        if (!text.includes('navigator.vibrate') && !text.includes('401')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('response', (resp) => {
      responses.push({
        url: resp.url(),
        status: resp.status(),
        contentType: resp.headers()['content-type'] || '',
      });
    });

    const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(res).not.toBeNull();
    expect(res?.status()).toBe(200);

    // Verify title and AuthScreen elements
    await expect(page).toHaveTitle(/RootInbox/);
    const authScreen = page.locator('#auth-screen');
    await expect(authScreen).toBeVisible({ timeout: 15000 });

    const usernameInput = page.locator('#auth-username');
    const passwordInput = page.locator('#auth-password');
    const submitBtn = page.locator('#auth-submit');
    const registerTab = page.locator('#auth-tab-register');
    const loginTab = page.locator('#auth-tab-login');
    const deviceCheckLink = page.locator('#auth-device-check-link');

    await expect(usernameInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(submitBtn).toBeVisible();
    await expect(registerTab).toBeVisible();
    await expect(loginTab).toBeVisible();
    await expect(deviceCheckLink).toBeVisible();

    // Verify assets served with correct MIME types
    for (const r of responses) {
      if (r.url.endsWith('.js') || r.url.includes('/assets/') && r.url.endsWith('.js')) {
        expect(r.status).toBe(200);
        expect(r.contentType).toMatch(/javascript/);
      }
      if (r.url.endsWith('.css')) {
        expect(r.status).toBe(200);
        expect(r.contentType).toMatch(/text\/css/);
      }
      if (r.url.endsWith('.webmanifest')) {
        expect(r.status).toBe(200);
        expect(r.contentType).toMatch(/manifest\+json/);
      }
    }

    // Verify no request failures or HTTP/2 protocol errors
    expect(failedRequests).toHaveLength(0);
    expect(consoleErrors).toHaveLength(0);

    // Allow page resources to settle before teardown
    await page.waitForLoadState('load');
  });

  test('2. New user can register over HTTPS and reach the chat list', async ({ page }) => {
    const username = randomTestUsername('prod_reg', 6);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const authScreen = page.locator('#auth-screen');
    await expect(authScreen).toBeVisible({ timeout: 15000 });

    // Wait for any initial client-side redirect (e.g. to /auth) to settle
    await page.waitForTimeout(500);

    // Switch to register tab with retry
    const registerTab = page.locator('#auth-tab-register');
    await registerTab.waitFor({ state: 'visible', timeout: 10000 });
    for (let i = 0; i < 5; i++) {
      if (await page.locator('#auth-display-name').isVisible()) break;
      await registerTab.click({ force: true });
      await page.waitForTimeout(300);
    }
    const displayNameInput = page.locator('#auth-display-name');
    await expect(displayNameInput).toBeVisible({ timeout: 10000 });

    // Fill form
    await page.locator('#auth-username').fill(username);
    await displayNameInput.fill(`User ${username}`);
    await page.locator('#auth-password').fill('P@ssword123456!');
    await page.locator('#auth-submit').click();

    // Must reach chat screen
    const chatScreen = page.locator('#chat-screen');
    await expect(chatScreen).toBeVisible({ timeout: 25000 });

    // Search input visible
    const searchInput = page.locator('#user-search-input');
    await expect(searchInput).toBeVisible();
  });

  test('3. /device-check finishes with explicit PASS/FAIL statuses (no WAIT remaining)', async ({ page }) => {
    const failedRequests: { url: string; error: string }[] = [];
    page.on('requestfailed', (req) => {
      failedRequests.push({ url: req.url(), error: req.failure()?.errorText || 'unknown' });
    });

    await page.goto('/device-check', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/RootInbox Device Pre-Check/);

    const overallStatus = page.locator('#overall-status');
    await expect(overallStatus).toBeVisible();

    // Wait until overall status leaves PENDING/RUNNING
    await expect(overallStatus).not.toHaveText('PENDING', { timeout: 20000 });
    await expect(overallStatus).not.toHaveText('RUNNING', { timeout: 20000 });
    await expect(overallStatus).toHaveText(/PASS|WARNING|FAIL/);

    // Verify that NO check item remains at WAIT
    const waitBadges = page.locator('#checks-list .status-badge:has-text("WAIT")');
    const waitCount = await waitBadges.count();
    expect(waitCount).toBe(0);

    // Copy report button is functional
    const copyBtn = page.locator('#copy-report-btn');
    await expect(copyBtn).toBeVisible();

    // No failed module requests
    expect(failedRequests).toHaveLength(0);
  });

  test('4. Stale-service-worker upgrade scenario preserves app load', async ({ page }) => {
    // 1. Visit / and allow initial load to stabilize
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15000 });

    // Wait briefly for service worker registration if supported
    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg?.active) {
          await reg.update();
        }
      } catch {}
    });

    // 2. Simulate subsequent visit under existing SW / cache without clearing site data
    await page.waitForTimeout(500);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#auth-username')).toBeVisible();

    // 3. Navigate to /device-check under existing SW / cache via link
    const deviceCheckLink = page.locator('#auth-device-check-link');
    await expect(deviceCheckLink).toBeVisible();
    await deviceCheckLink.click();
    await expect(page.locator('#overall-status')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#overall-status')).not.toHaveText('PENDING', { timeout: 20000 });
  });
});

