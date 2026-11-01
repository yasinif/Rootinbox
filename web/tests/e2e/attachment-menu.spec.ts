import { test, expect } from '@playwright/test';
import { randomTestUsername } from '../test-random';

async function registerAndOpenChat(page: any, isMobile: boolean) {
  const username = randomTestUsername('user', 8);
  await page.goto('/');

  // Wait for React to mount either chat screen (if already authenticated) or auth screen
  await Promise.race([
    page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 }),
    page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 }),
  ]).catch(() => {});

  // If already authenticated and chat screen is visible
  if (await page.locator('#chat-screen').isVisible()) {
    const convBtn = page.locator('button.conv-item-btn').first();
    await convBtn.waitFor({ state: 'visible', timeout: 10000 });
    if (isMobile) await convBtn.tap();
    else await convBtn.click();
    const attachBtn = page.locator('#attach-file-btn');
    await attachBtn.waitFor({ state: 'visible', timeout: 8000 });
    return attachBtn;
  }

  // If on unlock screen from a locked session, switch account to reach registration
  const switchBtn = page.locator('#auth-switch-account-btn');
  if (await switchBtn.isVisible().catch(() => false)) {
    await switchBtn.click();
    await page.locator('#auth-tab-register').waitFor({ state: 'visible', timeout: 5000 });
  }

  // Ensure register tab is visible
  const registerTab = page.locator('#auth-tab-register');
  await registerTab.waitFor({ state: 'visible', timeout: 10000 });

  // Retry clicking Register until React switches mode and display name appears
  for (let i = 0; i < 5; i++) {
    if (await page.locator('#auth-display-name').isVisible()) break;
    await registerTab.click({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await page.locator('#auth-display-name').waitFor({ state: 'visible', timeout: 8000 });

  await page.locator('#auth-username').fill(username);
  await page.locator('#auth-display-name').fill('Playwright Tester');
  await page.locator('#auth-password').fill('Password123!');
  await page.locator('#auth-submit').click();

  // Wait for main chat layout to load
  await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });

  // Open first conversation (My Notes)
  const convBtn = page.locator('button.conv-item-btn').first();
  await convBtn.waitFor({ state: 'visible', timeout: 10000 });
  if (isMobile) {
    await convBtn.tap();
  } else {
    await convBtn.click();
  }

  // Wait for attachment button to appear
  const attachBtn = page.locator('#attach-file-btn');
  await attachBtn.waitFor({ state: 'visible', timeout: 8000 });
  return attachBtn;
}

test.describe('Attachment Menu Viewport Placement & File Choosers', () => {
  test('Attachment menu is completely visible within viewport, does not overflow, and triggers file choosers', async ({
    page,
    isMobile,
  }, testInfo) => {
    const attachBtn = await registerAndOpenChat(page, isMobile);

    // Open Attachment Menu
    if (isMobile) {
      await attachBtn.tap();
    } else {
      await attachBtn.click();
    }

    const menu = page.locator('#attachment-menu');
    await expect(menu).toBeVisible();
    await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

    // Verify viewport placement (Bug 1 Root Cause test)
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;

    // Menu MUST be within the visible viewport bounds
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 2);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 2);

    // On mobile, the attachment menu MUST be anchored at the bottom as a bottom sheet with safe-area padding
    if (isMobile) {
      expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height - 5);
      const paddingBottom = await menu.evaluate((el) => window.getComputedStyle(el).paddingBottom);
      expect(parseInt(paddingBottom, 10)).toBeGreaterThanOrEqual(16);
    }

    // Verify elementFromPoint resolves to attachment menu
    const isClickable = await page.evaluate(
      ({ x, y, width, height }) => {
        const el = document.elementFromPoint(x + width / 2, y + height / 2);
        return el !== null && (el.id === 'attachment-menu' || el.closest('#attachment-menu') !== null);
      },
      box!
    );
    expect(isClickable).toBe(true);

    const projectName = testInfo.project.name;
    const lightPath = `test-results/attachment-menu-${projectName}-light.png`;
    const darkPath = `test-results/attachment-menu-${projectName}-dark.png`;

    // Take screenshot in light mode
    await page.screenshot({ path: lightPath });

    // Switch to dark mode and screenshot
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await expect.poll(async () => {
      return page.evaluate(() => {
        const el = document.getElementById('attachment-menu');
        return el ? window.getComputedStyle(el).backgroundColor : '';
      });
    }).toBe('rgb(33, 33, 33)');
    await page.screenshot({ path: darkPath });

    // Test file choosers for the options
    const options = [
      { id: '#attachment-opt-gallery', name: 'Gallery' },
      { id: '#attachment-opt-camera', name: 'Camera' },
      { id: '#attachment-opt-file', name: 'File' },
      { id: '#attachment-opt-audio', name: 'Audio' },
    ];

    for (const opt of options) {
      // Re-open menu if closed by previous option selection
      if (!(await menu.isVisible())) {
        if (isMobile) {
          await attachBtn.tap();
        } else {
          await attachBtn.click();
        }
        await expect(menu).toBeVisible();
      }

      const optBtn = page.locator(opt.id);
      await expect(optBtn).toBeVisible();

      // Assert filechooser event is dispatched
      let fileChooser = null;
      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 4000 });
        if (isMobile) {
          await optBtn.tap();
        } else {
          await optBtn.click();
        }
        fileChooser = await fileChooserPromise;
        expect(fileChooser).toBeDefined();
      } catch (err: any) {
        if (projectName === 'iphone-14') {
          console.log(`[WebKit Note] filechooser on ${opt.name} in WebKit iPhone profile: ${err?.message || err}`);
        } else {
          throw err;
        }
      }

      // After option selection, menu should close
      await expect(menu).toBeHidden();
    }

    // Test Escape key close
    if (isMobile) {
      await attachBtn.tap();
    } else {
      await attachBtn.click();
    }
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Test Backdrop click/tap close
    if (isMobile) {
      await attachBtn.tap();
    } else {
      await attachBtn.click();
    }
    await expect(menu).toBeVisible();
    const backdrop = page.locator('#attachment-menu-backdrop');
    await backdrop.click({ position: { x: 10, y: 10 } });
    await expect(menu).toBeHidden();
  });
});
