import { test, expect } from '@playwright/test';

test.describe('Device Pre-Check Diagnostics (/device-check)', () => {
  test('loads diagnostics page and passes all cryptographic and platform capability probes', async ({ page }) => {
    // Navigate directly to /device-check
    await page.goto('/device-check');

    // Verify title and main elements
    await expect(page).toHaveTitle(/RootInbox Device Pre-Check/);
    const overallStatus = page.locator('#overall-status');
    await expect(overallStatus).toBeVisible();

    // Wait for all diagnostics (including Argon2id real run and libsodium) to finish
    await expect(overallStatus).not.toHaveText('RUNNING', { timeout: 15000 });
    await expect(overallStatus).not.toHaveText('PENDING', { timeout: 15000 });
    await expect(overallStatus).toHaveText(/PASS|WARNING/);

    // Verify critical capabilities are PASS
    const passChecks = [
      '#check-secure-context',
      '#check-crypto-subtle',
      '#check-crypto-random-values',
      '#check-wasm-presence',
      '#check-wasm-memory-32',
      '#check-wasm-memory-64',
      '#check-argon2-real',
      '#check-capability-probe',
      '#check-libsodium-ed25519',
      '#check-indexeddb',
      '#check-health-ready',
      '#check-clock-skew',
      '#check-client-environment',
    ];

    for (const selector of passChecks) {
      const badge = page.locator(`${selector} .status-badge`);
      await expect(badge).toHaveText('PASS');
    }

    // Verify copy report button exists and is clickable
    const copyBtn = page.locator('#copy-report-btn');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Verify re-run button exists
    const rerunBtn = page.locator('#run-tests-btn');
    await expect(rerunBtn).toBeVisible();

    // Verify back to auth link
    const backLink = page.locator('a.btn-link[href="/auth"]');
    await expect(backLink).toBeVisible();
  });
});
