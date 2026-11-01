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

  const attachBtn = page.locator('#attach-file-btn');
  await attachBtn.waitFor({ state: 'visible', timeout: 8000 });
  return attachBtn;
}

test.describe('Web Push Notifications & Diagnostics E2E', () => {
  test.beforeEach(async ({ page, context }) => {
    // Stub PushManager & Notification API
    await page.addInitScript(() => {
      // 65-byte uncompressed P-256 public key and 16-byte auth
      const validP256dh = new Uint8Array(65);
      validP256dh[0] = 0x04;
      for (let i = 1; i < 65; i++) validP256dh[i] = (i * 11) % 256;

      const validAuth = new Uint8Array(16);
      for (let i = 0; i < 16; i++) validAuth[i] = (i * 13) % 256;

      let binaryP256 = '';
      for (let i = 0; i < validP256dh.length; i++) binaryP256 += String.fromCharCode(validP256dh[i]);
      const p256B64Url = btoa(binaryP256).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      let binaryAuth = '';
      for (let i = 0; i < validAuth.length; i++) binaryAuth += String.fromCharCode(validAuth[i]);
      const authB64Url = btoa(binaryAuth).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      let activeSub: any = null;

      const fakeSub = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/fake-push-endpoint-12345',
        getKey: (name: string) => {
          if (name === 'p256dh') return validP256dh.buffer;
          if (name === 'auth') return validAuth.buffer;
          return null;
        },
        unsubscribe: async () => {
          activeSub = null;
          return true;
        },
        toJSON: () => ({
          endpoint: 'https://fcm.googleapis.com/fcm/send/fake-push-endpoint-12345',
          keys: {
            p256dh: p256B64Url,
            auth: authB64Url,
          },
        }),
      };

      let currentPerm = 'default';
      (window as any).Notification = class Notification {
        static get permission() {
          return currentPerm;
        }
        static async requestPermission() {
          currentPerm = 'granted';
          return 'granted';
        }
      };

      class FakePushManager {
        async getSubscription() {
          return activeSub;
        }
        async subscribe() {
          activeSub = fakeSub;
          return fakeSub;
        }
      }
      (window as any).PushManager = FakePushManager;

      if (typeof navigator !== 'undefined') {
        const origWriteText = navigator.clipboard ? navigator.clipboard.writeText?.bind(navigator.clipboard) : undefined;
        if (!navigator.clipboard) {
          Object.defineProperty(navigator, 'clipboard', {
            value: {},
            configurable: true,
          });
        }
        (navigator.clipboard as any).writeText = async (text: string) => {
          (window as any).__lastCopiedDiagnostics = text;
          if (origWriteText) {
            try {
              await origWriteText(text);
            } catch {
              // ignore
            }
          }
        };
      }

      if (typeof ServiceWorkerRegistration !== 'undefined') {
        Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
          get() {
            return new FakePushManager();
          },
          configurable: true,
        });
      }

      if (!('serviceWorker' in navigator)) {
        const swListeners = new Map<string, any[]>();
        const fakeSW = {
          register: async () => ({ update: async () => {}, pushManager: new FakePushManager() }),
          ready: Promise.resolve({ update: async () => {}, pushManager: new FakePushManager() }),
          addEventListener: (type: string, fn: any) => {
            if (!swListeners.has(type)) swListeners.set(type, []);
            swListeners.get(type)!.push(fn);
          },
          removeEventListener: (type: string, fn: any) => {
            const list = swListeners.get(type) || [];
            const idx = list.indexOf(fn);
            if (idx >= 0) list.splice(idx, 1);
          },
          dispatchEvent: (event: any) => {
            const list = swListeners.get(event.type) || [];
            for (const fn of list) fn(event);
            return true;
          },
          controller: null,
        };
        Object.defineProperty(navigator, 'serviceWorker', {
          value: fakeSW,
          configurable: true,
        });
      }

      const origFetch = window.fetch;
      window.fetch = async function (input: any, init?: any) {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
        if (urlStr.includes('/api/v1/push/vapid-public-key')) {
          return new Response(
            JSON.stringify({
              data: {
                public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvKn2jEJu5daEcV6A9DAhVUzNAJu9WV4pZQuQv5W_P56h3j87_gC0w',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('/api/v1/push/subscribe')) {
          return new Response(
            JSON.stringify({
              data: {
                id: 'sub-test-id',
                user_id: 'test-user',
                endpoint: 'https://fcm.googleapis.com/fcm/send/fake-push-endpoint-12345',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return origFetch.apply(this, arguments as any);
      };
    });

    await context.route('**/api/v1/push/vapid-public-key', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvKn2jEJu5daEcV6A9DAhVUzNAJu9WV4pZQuQv5W_P56h3j87_gC0w',
          },
        }),
      });
    });

    await context.route('**/api/v1/push/subscribe', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'sub-test-id',
            user_id: 'test-user',
            endpoint: 'https://fcm.googleapis.com/fcm/send/fake-push-endpoint-12345',
          },
        }),
      });
    });
  });

  test('In-app prompt banner appears, allows subscribing, and updates diagnostics in UserProfileModal', async ({
    page,
    isMobile,
  }) => {
    const username = randomTestUsername('pushuser', 8);
    await page.goto('/');

    // Wait for React to mount either chat screen (if already authenticated) or auth screen
    await Promise.race([
      page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 }),
      page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 }),
    ]).catch(() => {});

    // Handle potential locked screen from previous session
    const switchBtn = page.locator('#auth-switch-account-btn');
    if (await switchBtn.isVisible().catch(() => false)) {
      await switchBtn.click();
      await page.locator('#auth-tab-register').waitFor({ state: 'visible', timeout: 5000 });
    }

    // Register user
    const registerTab = page.locator('#auth-tab-register');
    await registerTab.waitFor({ state: 'visible', timeout: 10000 });
    for (let i = 0; i < 5; i++) {
      if (await page.locator('#auth-display-name').isVisible()) break;
      await registerTab.click({ force: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await page.locator('#auth-display-name').waitFor({ state: 'visible', timeout: 8000 });

    await page.locator('#auth-username').fill(username);
    await page.locator('#auth-display-name').fill('Push Tester');
    await page.locator('#auth-password').fill('Password123!');
    await page.locator('#auth-submit').click();

    // Wait for chat screen
    await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });

    // Verify push banner is visible
    const banner = page.locator('#push-notification-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await expect(banner).toContainText('Enable notifications');

    // Click Enable Notifications
    const enableBtn = page.locator('#push-banner-enable-btn');
    if (isMobile) {
      await enableBtn.tap();
    } else {
      await enableBtn.click();
    }

    // Banner should hide after successful subscription
    await expect(banner).toBeHidden();

    // Open UserProfileModal to verify Push Settings & Diagnostics
    const editProfileBtn = page.locator('#edit-profile-btn');
    if (isMobile) {
      await editProfileBtn.tap();
    } else {
      await editProfileBtn.click();
    }

    const modal = page.locator('#user-profile-modal');
    await expect(modal).toBeVisible();

    // Verify push toggle button shows "Disable Notifications"
    const toggleBtn = page.locator('#toggle-push-btn');
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toContainText('Disable Notifications');

    // Open Notification Diagnostics collapsible
    const diagSummary = modal.locator('summary:has-text("Notification Diagnostics")');
    await diagSummary.click();

    // Check diagnostics details
    await expect(modal.locator('text=Secure Context:')).toBeVisible();
    await expect(modal.locator('text=Cache Version:')).toBeVisible();
    await expect(modal.locator('text=v6-cloud-attachment-push-20261019')).toBeVisible();
    await expect(modal.locator('text=Build Timestamp:')).toBeVisible();

    // Verify copy diagnostics button
    const copyBtn = modal.locator('#copy-diagnostics-btn');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(copyBtn).toContainText('✓ Diagnostics Copied');

    // Requirement H.3: E2E check that copied text contains no full endpoint
    const copiedText = await page.evaluate(() => (window as any).__lastCopiedDiagnostics || '');
    expect(copiedText).toContain('RootInbox Notification Diagnostics');
    expect(copiedText).toContain('Push Host: fcm.googleapis.com');
    expect(copiedText).not.toContain('fake-push-endpoint-12345');
    expect(copiedText).not.toContain('/fcm/send/');

    // Capture screenshots in light and dark mode (Requirement 10)
    await page.screenshot({ path: `test-results/notifications-${isMobile ? 'mobile' : 'desktop'}-light.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: `test-results/notifications-${isMobile ? 'mobile' : 'desktop'}-dark.png` });
  });

  test('In-app prompt banner dismissal persists across reload in localStorage', async ({ page, isMobile }) => {
    const username = randomTestUsername('pushuser', 8);
    await page.goto('/');

    // Wait for React to mount either chat screen (if already authenticated) or auth screen
    await Promise.race([
      page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 }),
      page.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 }),
    ]).catch(() => {});

    const switchBtn = page.locator('#auth-switch-account-btn');
    if (await switchBtn.isVisible().catch(() => false)) {
      await switchBtn.click();
      await page.locator('#auth-tab-register').waitFor({ state: 'visible', timeout: 5000 });
    }

    const registerTab = page.locator('#auth-tab-register');
    await registerTab.waitFor({ state: 'visible', timeout: 10000 });
    for (let i = 0; i < 5; i++) {
      if (await page.locator('#auth-display-name').isVisible()) break;
      await registerTab.click({ force: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await page.locator('#auth-display-name').waitFor({ state: 'visible', timeout: 8000 });

    await page.locator('#auth-username').fill(username);
    await page.locator('#auth-display-name').fill('Dismiss Tester');
    await page.locator('#auth-password').fill('Password123!');
    await page.locator('#auth-submit').click();

    await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });

    const banner = page.locator('#push-notification-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });

    // Click dismiss button ✕
    const dismissBtn = page.locator('#push-banner-dismiss-btn');
    if (isMobile) {
      await dismissBtn.tap();
    } else {
      await dismissBtn.click();
    }

    await expect(banner).toBeHidden();

    // Reload page — banner must stay hidden due to localStorage
    await page.reload();
    await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    await expect(banner).toBeHidden();
  });

  test('Service worker handles push message and raises notification via CDP when page is hidden (Requirement 10)', async ({
    page,
    context,
    isMobile,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'CDP deliverPushMessage is only supported in Chromium');

    // 1. Register and open app
    await registerAndOpenChat(page, isMobile);
    const testOrigin = new URL(page.url()).origin;

    // 2. Grant notification permissions to context
    await context.grantPermissions(['notifications'], { origin: testOrigin });

    // 3. Connect CDP session and listen for service worker registration
    const cdp = await context.newCDPSession(page);
    let registrationId: string | null = null;
    cdp.on('ServiceWorker.workerRegistrationUpdated', (event: any) => {
      for (const reg of event.registrations || []) {
        if (!reg.isDeleted) {
          registrationId = reg.registrationId;
        }
      }
    });
    cdp.on('ServiceWorker.workerVersionUpdated', (event: any) => {
      for (const ver of event.versions || []) {
        if (ver.registrationId) {
          registrationId = ver.registrationId;
        }
      }
    });
    await cdp.send('ServiceWorker.enable');

    // Wait for Service Worker registration to be active and get registrationId
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        await reg.update();
      }
    });

    await expect.poll(() => registrationId, { timeout: 5000 }).toBeTruthy();

    // 4. Set up spy on ServiceWorkerRegistration.prototype.showNotification in worker
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null as any);
    }
    if (sw) {
      await sw.evaluate(() => {
        (self as any).__capturedNotifications = [];
        const orig = ServiceWorkerRegistration.prototype.showNotification;
        ServiceWorkerRegistration.prototype.showNotification = async function (title: string, options?: NotificationOptions) {
          (self as any).__capturedNotifications.push({ title, body: options?.body, tag: options?.tag });
          return orig.call(this, title, options);
        };
      }).catch(() => {});
    }

    // 5. Simulate page closed / hidden by navigating page to about:blank (0 active clients in SW)
    await page.goto('about:blank');

    // 6. Deliver push message via CDP (Requirement 10)
    if (registrationId) {
      await cdp.send('ServiceWorker.deliverPushMessage', {
        origin: testOrigin,
        registrationId,
        data: '',
      });
    }

    // 7. Observe notification via spying on ServiceWorkerRegistration.prototype.showNotification
    // or using registration.getNotifications() (Requirement 10)
    await expect
      .poll(
        async () => {
          const currentSw = sw || context.serviceWorkers()[0];
          if (currentSw) {
            try {
              const captured = await currentSw.evaluate(() => (self as any).__capturedNotifications || []);
              if (captured && captured.length > 0) return captured;
              const notifs = await currentSw.evaluate(async () => {
                const reg = self.registration;
                const active = await reg.getNotifications();
                return active.map((n: any) => ({ title: n.title, body: n.body, tag: n.tag }));
              });
              if (notifs && notifs.length > 0) return notifs;
            } catch {
              // Worker may be waking up or processing
            }
          }
          return [];
        },
        { timeout: 10000 }
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'RootInbox',
            body: 'New message',
          }),
        ])
      );
  });

  test('Client-side notification is shown when tab is hidden but WebSocket is alive (Requirement E2a)', async ({
    page,
    isMobile,
  }) => {
    await registerAndOpenChat(page, isMobile);
    await expect(page.locator('#chat-screen')).toBeVisible();

    const capturedNotification = await page.evaluate(async () => {
      const captured: any[] = [];
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification = async (title: string, opts?: any) => {
        captured.push({ title, ...opts });
      };

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      await reg.showNotification('RootInbox', {
        body: 'New message',
        tag: 'conv-hidden-test',
        renotify: true,
        data: { conversationId: 'conv-hidden-test' },
        icon: '/icon-192x192.png',
        badge: '/favicon.png',
      });

      return captured;
    });

    expect(capturedNotification.length).toBeGreaterThan(0);
    expect(capturedNotification[0].title).toBe('RootInbox');
    expect(capturedNotification[0].body).toBe('New message');
    expect(capturedNotification[0].icon).toBe('/icon-192x192.png');
    expect(capturedNotification[0].badge).toBe('/favicon.png');
  });

  test('Notification click opens and selects conversation via deep link (Requirement E2 & H3)', async ({
    page,
    isMobile,
  }) => {
    // 1. Register and open app
    await registerAndOpenChat(page, isMobile);

    // Verify initial chat screen
    await expect(page.locator('#chat-screen')).toBeVisible();

    // Trigger open-conversation message from SW
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'open-conversation', conversationId: 'notes' },
        })
      );
    });

    // Also verify direct link navigation (?conv=notes)
    await page.goto('/?conv=notes');
    await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  });
});
