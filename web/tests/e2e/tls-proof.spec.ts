import { test, expect, type Page, type BrowserContext } from '@playwright/test';

async function registerTestUser(page: Page, prefix: string): Promise<string> {
  const username = `${prefix}_${Math.random().toString(36).substring(2, 8)}`;
  await page.goto('/');

  const chatScreen = page.locator('#chat-screen');
  const authScreen = page.locator('#auth-screen');
  await Promise.race([
    chatScreen.waitFor({ state: 'visible', timeout: 15000 }),
    authScreen.waitFor({ state: 'visible', timeout: 15000 }),
  ]).catch(() => {});

  if (await chatScreen.isVisible()) {
    const logoutBtn = page.locator('#chat-logout');
    if (await logoutBtn.isVisible()) {
      await logoutBtn.click();
      await authScreen.waitFor({ state: 'visible', timeout: 10000 });
    }
  }

  const switchBtn = page.locator('#auth-switch-account-btn');
  if (await switchBtn.isVisible().catch(() => false)) {
    await switchBtn.click();
  }

  const registerTab = page.locator('#auth-tab-register');
  await registerTab.waitFor({ state: 'visible', timeout: 10000 });
  for (let i = 0; i < 5; i++) {
    if (await page.locator('#auth-display-name').isVisible()) break;
    await registerTab.click({ force: true });
    await page.waitForTimeout(300);
  }

  await page.locator('#auth-username').fill(username);
  await page.locator('#auth-display-name').fill(`User ${username}`);
  await page.locator('#auth-password').fill('Password123!');
  await page.locator('#auth-submit').click();

  await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 20000 });
  return username;
}

test.describe('H6: Real-Browser TLS Proof (Secure Context, SW, getUserMedia, WSS, & Chat)', () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium SPKI certificate pinning and fake media are only supported in Chromium');
    // Both contexts inherit launch options including pinned SPKI and fake media devices
    contextA = await browser.newContext({
      permissions: ['microphone'],
      ignoreHTTPSErrors: false, // Strict: rely solely on Chromium certificate pin / browser trust
    });
    contextB = await browser.newContext({
      permissions: ['microphone'],
      ignoreHTTPSErrors: false,
    });
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test('1. Validates Secure Context, Service Worker Registration, and getUserMedia({audio: true})', async () => {
    await pageA.goto('/');
    await pageA.waitForLoadState('networkidle');

    // 1. Assert secure context
    const isSecure = await pageA.evaluate(() => window.isSecureContext);
    expect(isSecure).toBe(true);

    // 2. Assert subtle crypto is available
    const hasCrypto = await pageA.evaluate(() => typeof window.crypto?.subtle !== 'undefined');
    expect(hasCrypto).toBe(true);

    // 3. Assert service worker registration succeeds in secure context
    const swRegistered = await pageA.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      try {
        const reg = await navigator.serviceWorker.ready;
        return Boolean(reg && reg.active);
      } catch {
        return false;
      }
    });
    expect(swRegistered).toBe(true);

    // 4. Assert getUserMedia({ audio: true }) succeeds without security errors
    const audioStreamAcquired = await pageA.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const tracks = stream.getAudioTracks();
        const ok = tracks.length > 0 && tracks[0].readyState === 'live';
        tracks.forEach((t) => t.stop());
        return ok;
      } catch (err) {
        console.error('getUserMedia failed:', err);
        return false;
      }
    });
    expect(audioStreamAcquired).toBe(true);
  });

  test('2. Two users connect over WSS and exchange messages', async () => {
    test.setTimeout(60000);

    const userA = await registerTestUser(pageA, 'tls_alice');
    const userB = await registerTestUser(pageB, 'tls_bob');

    // User A starts chat with User B
    const searchInput = pageA.locator('#user-search-input');
    await searchInput.waitFor({ state: 'visible', timeout: 10000 });
    await searchInput.fill(userB);

    const msgBtn = pageA.locator(`#search-msg-${userB}`);
    await msgBtn.waitFor({ state: 'visible', timeout: 10000 });
    await msgBtn.click();

    await pageA.locator('#chat-input').waitFor({ state: 'visible', timeout: 10000 });

    // Send chat message from User A to User B over TLS
    const tlsMessage = `TLS Proof Message ${Date.now()}`;
    await pageA.locator('#chat-input').fill(tlsMessage);
    await pageA.locator('#chat-send-btn').click();

    // Verify bubble appears on User A
    const bubbleA = pageA.locator('.bubble', { hasText: tlsMessage }).first();
    await bubbleA.waitFor({ state: 'visible', timeout: 15000 });

    // Verify User B receives it over WSS
    // Select conversation if needed
    const convBtnB = pageB.locator('button.conv-item-btn', { hasText: userA }).first();
    await convBtnB.waitFor({ state: 'visible', timeout: 15000 });
    await convBtnB.click();

    const bubbleB = pageB.locator('.bubble', { hasText: tlsMessage }).first();
    await bubbleB.waitFor({ state: 'visible', timeout: 20000 });
    expect(await bubbleB.innerText()).toContain(tlsMessage);
  });
});
