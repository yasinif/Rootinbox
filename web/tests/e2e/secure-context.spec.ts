import { test, expect } from '@playwright/test';

test.describe('Secure Context & Web APIs Availability (Stage 2 IP-Only Deploy)', () => {
  test('Window is secure context and all required E2EE/PWA APIs are enabled', async ({ page, browserName }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const checks = await page.evaluate(() => {
      return {
        isSecureContext: window.isSecureContext,
        hasSubtleCrypto: typeof window.crypto?.subtle !== 'undefined',
        hasServiceWorker: 'serviceWorker' in navigator,
        hasNotification: 'Notification' in window,
        hasMediaDevices: typeof navigator.mediaDevices !== 'undefined',
      };
    });

    expect(checks.isSecureContext).toBe(true);
    expect(checks.hasSubtleCrypto).toBe(true);
    expect(checks.hasServiceWorker).toBe(true);
    expect(checks.hasMediaDevices).toBe(true);

    if (browserName === 'chromium') {
      expect(checks.hasNotification).toBe(true);
    }
  });

  test('Zero requests to external hosts: abort every non-origin request and assert none attempted', async ({ page }) => {
    const attemptedExternalRequests: string[] = [];

    await page.route('**', (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
        route.continue();
        return;
      }
      try {
        const parsed = new URL(requestUrl);
        const currentUrl = page.url();
        const originHost = currentUrl && currentUrl !== 'about:blank' ? new URL(currentUrl).host : '';
        if (
          parsed.host !== originHost &&
          parsed.host !== '127.0.0.1:8080' &&
          parsed.host !== 'localhost:8080' &&
          !parsed.host.startsWith('127.0.0.1:') &&
          !parsed.host.startsWith('localhost:')
        ) {
          attemptedExternalRequests.push(requestUrl);
          route.abort('blockedbyclient');
          return;
        }
      } catch {
        // continue
      }
      route.continue();
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Prove zero external requests were attempted
    expect(attemptedExternalRequests).toEqual([]);
  });
});

