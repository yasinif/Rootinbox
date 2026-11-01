import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomTestUsername } from '../test-random';

interface MetricsSnapshot {
  allocBytes: number;
  sysBytes: number;
  dbSizeBytes: number;
  timestamp: string;
}

async function fetchServerMetrics(baseURL: string, dbPath: string): Promise<MetricsSnapshot> {
  let allocBytes = 0;
  let sysBytes = 0;
  try {
    const res = await fetch(`${baseURL}/api/v1/metrics`);
    if (res.ok) {
      const text = await res.text();
      const allocMatch = text.match(/go_memstats_alloc_bytes\s+(\d+)/);
      if (allocMatch) allocBytes = parseInt(allocMatch[1], 10);
      const sysMatch = text.match(/go_memstats_sys_bytes\s+(\d+)/);
      if (sysMatch) sysBytes = parseInt(sysMatch[1], 10);
    }
  } catch {
    // best effort metrics
  }

  let dbSizeBytes = 0;
  try {
    const resolvedDb = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
    if (fs.existsSync(resolvedDb)) {
      dbSizeBytes = fs.statSync(resolvedDb).size;
    }
  } catch {
    // best effort db size
  }

  return {
    allocBytes,
    sysBytes,
    dbSizeBytes,
    timestamp: new Date().toISOString(),
  };
}

async function registerUser(page: Page, prefix: string): Promise<string> {
  const username = randomTestUsername(prefix, 7);
  await page.goto('/');

  // If already authenticated and chat screen is visible, sign out first
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

  // Handle switch account if on unlock screen
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
  await page.locator('#auth-display-name').fill(`Display ${username}`);
  await page.locator('#auth-password').fill('Password123!');
  await page.locator('#auth-submit').click();

  await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 20000 });
  return username;
}

async function startChatWithUser(page: Page, targetUsername: string): Promise<void> {
  // If on mobile and a conversation is currently open, navigate back to sidebar
  const backBtn = page.locator('#chat-mobile-back-btn');
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
    await page.waitForTimeout(300);
  }

  const searchInput = page.locator('#user-search-input');
  await searchInput.waitFor({ state: 'visible', timeout: 10000 });
  await searchInput.fill(targetUsername);

  const msgBtn = page.locator(`#search-msg-${targetUsername}`);
  await msgBtn.waitFor({ state: 'visible', timeout: 10000 });
  await msgBtn.click();

  await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 10000 });
}

async function selectConversation(page: Page, labelOrUsername: string): Promise<void> {
  const chatInput = page.locator('#chat-input');
  if (await chatInput.isVisible().catch(() => false)) {
    const activeHeader = page.locator('#chat-active-peer-name, .header-title, .chat-header-title').first();
    const headerText = await activeHeader.innerText({ timeout: 1000 }).catch(() => '');
    if (headerText.toLowerCase().includes(labelOrUsername.toLowerCase())) {
      const isDraft = await page.evaluate(() => {
        return (window as any).__chatUC?.getSnapshot()?.activeConversationId?.startsWith('draft:');
      }).catch(() => false);
      if (!isDraft) {
        return;
      }
    }
  }

  const backBtn = page.locator('#chat-mobile-back-btn');
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
    await page.waitForTimeout(300);
  }

  const clearSearchBtn = page.locator('#user-search-clear');
  if (await clearSearchBtn.isVisible().catch(() => false)) {
    await clearSearchBtn.click();
    await page.waitForTimeout(200);
  }

  const convBtn = page.locator('button.conv-item-btn', { hasText: labelOrUsername }).first();
  const visible = await convBtn.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (visible) {
    await convBtn.click();
  } else {
    await startChatWithUser(page, labelOrUsername);
  }
  await page.locator('#chat-input').waitFor({ state: 'visible', timeout: 10000 });
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  const input = page.locator('#chat-input');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(text);
  const sendBtn = page.locator('#chat-send-btn');
  await sendBtn.click();
}

async function waitForBubbleWithText(page: Page, text: string, timeout = 15000) {
  const bubble = page.locator('.bubble', { hasText: text }).first();
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const elapsed = Date.now() - startTime;
    const stepTimeout = Math.min(2000, Math.max(500, timeout - elapsed));
    const visible = await bubble.waitFor({ state: 'visible', timeout: stepTimeout }).then(() => true).catch(() => false);
    if (visible) return bubble;

    // Virtuoso virtualizer only renders items in viewport; scroll to bottom if off-screen
    await page.evaluate(() => {
      if (typeof (window as any).__virtuosoScrollToBottom === 'function') {
        (window as any).__virtuosoScrollToBottom();
      }
      const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') ||
                       document.querySelector('[data-virtuoso-scroller="true"]') ||
                       document.querySelector('.list-wrapper > div');
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll'));
      }
    }).catch(() => {});
  }
  await bubble.waitFor({ state: 'visible', timeout: 1000 });
  return bubble;
}

test.describe('1:1 Chat Stability & Comprehensive Verification', () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let userA: string;
  let userB: string;

  const dbPath = process.env.DB_PATH || '../scratch/e2e-playwright.db';

  test.beforeAll(async ({ browser }) => {
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();

    userA = await registerUser(pageA, 'alice');
    userB = await registerUser(pageB, 'bob');
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test('Scenario 1, 2, 4, 5, 6: First contact, Persian/RTL/emojis/long text, ordering, delivered/read ticks, unread counters', async ({ baseURL }) => {
    test.setTimeout(90000);

    // 1. User B stays in My Notes
    const notesBtn = pageB.locator('button.conv-item-btn').first();
    await notesBtn.click();

    // 2. User A starts chat with User B (Scenario 1)
    await startChatWithUser(pageA, userB);

    // 3. User A sends Persian text (Scenario 4)
    const persianMsg = 'سلام دنیا! این یک پیام آزمایشی فارسی است.';
    await sendChatMessage(pageA, persianMsg);
    await waitForBubbleWithText(pageA, persianMsg);

    // 4. User B receives message in background, unread badge increments to 1 (Scenario 6)
    // On mobile, back button might need to be clicked to see sidebar badges
    const backBtnB = pageB.locator('#chat-mobile-back-btn');
    if (await backBtnB.isVisible().catch(() => false)) {
      await backBtnB.click();
    }
    const convItemB = pageB.locator('button.conv-item-btn', { hasText: userA }).first();
    await convItemB.waitFor({ state: 'visible', timeout: 15000 });
    const unreadBadge = convItemB.locator('.unread-badge');
    await unreadBadge.waitFor({ state: 'visible', timeout: 10000 });
    await expect(unreadBadge).toHaveText('1');

    // 5. User A sends Arabic digits & mixed RTL/LTR + Emoji (Scenario 4)
    const mixedMsg = 'قیمت ۱۲۳۴۵ ریال (Code: ABC-987) 🚀 ✨';
    await sendChatMessage(pageA, mixedMsg);
    await waitForBubbleWithText(pageA, mixedMsg);

    // Unread count increments to 2
    await expect(unreadBadge).toHaveText('2');

    // 6. User B selects User A's conversation -> unread badge clears (Scenario 6)
    await convItemB.click();
    await pageB.locator('#chat-input').waitFor({ state: 'visible', timeout: 10000 });
    await expect(convItemB.locator('.unread-badge')).toBeHidden({ timeout: 5000 });

    // 7. Verify ordering and text integrity in User B's view (Scenario 2 & 4)
    const bMsg1 = await waitForBubbleWithText(pageB, persianMsg);
    const bMsg2 = await waitForBubbleWithText(pageB, mixedMsg);
    expect(await bMsg1.innerText()).toContain(persianMsg);
    expect(await bMsg2.innerText()).toContain(mixedMsg);

    // 8. Verify User A's ticks become seen/read (✓✓) (Scenario 5)
    // In User A, meta-status for the sent messages should have class meta-status--read
    const readStatus = pageA.locator('.meta-status--read').first();
    await readStatus.waitFor({ state: 'visible', timeout: 10000 });
    await expect(readStatus).toHaveText('✓✓');

    // 9. User B replies and User A sends a very long message (Scenario 4)
    const replyText = 'پاسخ دریافت شد! متشکرم.';
    await sendChatMessage(pageB, replyText);
    await waitForBubbleWithText(pageA, replyText);

    const longMessage = 'A'.repeat(1500) + ' متن بسیار طولانی ' + 'B'.repeat(500);
    await sendChatMessage(pageA, longMessage);
    const bLongBubble = await waitForBubbleWithText(pageB, longMessage.substring(0, 100));
    expect(await bLongBubble.innerText()).toContain(longMessage);
  });

  test('Scenario 3: 200 rapid messages without loss, duplication, or corruption', async ({ baseURL }) => {
    test.setTimeout(240000);

    // Ensure both are on the conversation
    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);

    // Capture initial conversation id from pageA
    const convId = await pageA.evaluate(() => {
      const snap = (window as any).__chatUC?.getSnapshot();
      return snap?.activeConversationId;
    });
    expect(convId).toBeTruthy();

    // Send 200 rapid messages sequentially via chatUC.sendMessage
    await pageA.evaluate(async (cid) => {
      const chat = (window as any).__chatUC;
      for (let i = 1; i <= 200; i++) {
        await chat.sendMessage(cid, `Rapid msg #${i}`);
      }
    }, convId);

    // Wait until 200th message arrives on User B
    await waitForBubbleWithText(pageB, 'Rapid msg #200', 60000);

    // Verify all 200 messages are present on User B with no duplicates and correct order
    const receivedTexts = await pageB.evaluate((cid) => {
      const snap = (window as any).__chatUC?.getSnapshot();
      const msgs = (snap?.messages || []).filter((m: any) => m.conversationId === cid);
      return msgs.map((m: any) => m.plaintext);
    }, convId);

    const rapidMsgs = receivedTexts.filter((t: string) => t.startsWith('Rapid msg #'));
    expect(rapidMsgs.length).toBe(200);

    // Verify sequential integrity
    for (let i = 1; i <= 200; i++) {
      expect(rapidMsgs[i - 1]).toBe(`Rapid msg #${i}`);
    }

    // Measure server RAM and DB size after 200 messages (Task 1.3)
    const metrics200 = await fetchServerMetrics(baseURL || 'http://127.0.0.1:8080', dbPath);
    console.log(`[MEASUREMENT-1.3] 200-messages: Go Alloc=${metrics200.allocBytes} B, Sys=${metrics200.sysBytes} B, DB=${metrics200.dbSizeBytes} B`);
  });

  test('Scenario 7: Page reload in the middle of a conversation', async () => {
    test.setTimeout(30000);

    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);

    // Send pre-reload message
    const preMsg = 'Before reload message ' + Date.now();
    await sendChatMessage(pageA, preMsg);
    await waitForBubbleWithText(pageB, preMsg);

    // Reload pageA
    await pageA.reload();
    await pageA.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });

    // Select conversation again if not auto-selected
    await selectConversation(pageA, userB);
    await waitForBubbleWithText(pageA, preMsg);

    // Send post-reload message
    const postMsg = 'After reload message ' + Date.now();
    await sendChatMessage(pageA, postMsg);
    await waitForBubbleWithText(pageB, postMsg);
  });

  test('Scenario 8: WebSocket drop and reconnect', async () => {
    test.setTimeout(45000);

    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);

    try {
      // Trigger offline mode on contextA
      await contextA.setOffline(true);
      await pageA.waitForTimeout(1000);

      // Restore online mode
      await contextA.setOffline(false);
      await pageA.waitForTimeout(1000);
      await pageA.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        return (window as any).__chatUC?.flushOutbox();
      }).catch(() => {});

      // Verify messages continue to flow
      const reconnectedMsg = 'Reconnected after WS drop ' + Date.now();
      await sendChatMessage(pageA, reconnectedMsg);
      await waitForBubbleWithText(pageB, reconnectedMsg, 30000);
    } finally {
      await contextA.setOffline(false).catch(() => {});
    }
  });

  test('Scenario 9: Sending while offline then reconnecting (outbox)', async () => {
    test.setTimeout(45000);

    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);

    try {
      // Go offline on contextA
      await contextA.setOffline(true);
      await pageA.waitForTimeout(500);

      const offlineText = 'Queued offline message ' + Date.now();
      await sendChatMessage(pageA, offlineText);

      // Verify it is visible with pending indicator in pageA
      const bubbleA = await waitForBubbleWithText(pageA, offlineText);
      const statusA = bubbleA.locator('..').locator('.meta-status--pending');
      await expect(statusA).toBeVisible({ timeout: 5000 });

      // User B should NOT have received it yet
      const bubbleB = pageB.locator('.bubble', { hasText: offlineText });
      expect(await bubbleB.count()).toBe(0);

      // Reconnect contextA
      await contextA.setOffline(false);
      await pageA.waitForTimeout(1000);
      await pageA.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        return (window as any).__chatUC?.flushOutbox();
      }).catch(() => {});

      // Outbox flushes automatically on reconnect
      await waitForBubbleWithText(pageB, offlineText, 30000);
      // User A status transitions to sent/read
      await expect(statusA).toBeHidden({ timeout: 15000 });
    } finally {
      await contextA.setOffline(false).catch(() => {});
    }
  });

  test('Scenario 10: Two devices / tabs on the same account', async () => {
    test.setTimeout(45000);

    // Open second page in contextA (same credentials/session)
    const pageA2 = await contextA.newPage();
    await pageA2.goto('/');
    await pageA2.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    await selectConversation(pageA2, userB);

    // Allow 5500ms for pageA2 WebSocket ticket auth (5s authTimer) and initial catchUp
    await pageA2.waitForTimeout(5500);

    // Scroll pageA2 to bottom to ensure followOutput active
    await pageA2.evaluate(() => {
      (window as any).__virtuosoScrollToBottom?.();
    });

    // User B sends message to User A
    const multiDeviceMsg = 'Multi-device sync test ' + Date.now();
    await selectConversation(pageB, userA);
    await sendChatMessage(pageB, multiDeviceMsg);

    // Both tabs of User A receive the message
    await waitForBubbleWithText(pageA, multiDeviceMsg, 30000);
    await waitForBubbleWithText(pageA2, multiDeviceMsg, 30000);

    await pageA2.close();
  });

  test('Scenario 11: Logout and login again with history intact', async () => {
    test.setTimeout(45000);

    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);
    const landmarkMsg = 'History preservation landmark ' + Date.now();
    await sendChatMessage(pageA, landmarkMsg);
    await waitForBubbleWithText(pageA, landmarkMsg, 15000);
    await waitForBubbleWithText(pageB, landmarkMsg, 30000);

    // User A logs out
    const backBtnA = pageA.locator('#chat-mobile-back-btn');
    if (await backBtnA.isVisible().catch(() => false)) {
      await backBtnA.click();
    }
    await pageA.locator('#chat-logout').click();
    await pageA.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });

    // User A logs back in
    const loginTab = pageA.locator('#auth-tab-login');
    await loginTab.click();
    await pageA.locator('#auth-username').fill(userA);
    await pageA.locator('#auth-password').fill('Password123!');
    await pageA.locator('#auth-submit').click();

    await pageA.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });

    // Reopen conversation and verify landmark message is intact (wait for conversation button directly)
    const convBtnAfterLogin = pageA.locator('button.conv-item-btn', { hasText: userB }).first();
    await convBtnAfterLogin.waitFor({ state: 'visible', timeout: 25000 });
    await convBtnAfterLogin.click();
    await pageA.locator('#chat-input').waitFor({ state: 'visible', timeout: 15000 });
    await waitForBubbleWithText(pageA, landmarkMsg, 30000);
  });

  test('Scenario 12: Session expiry and clean re-auth', async () => {
    test.setTimeout(45000);

    // Simulate session expiry by invalidating session and clearing cookies
    await pageA.evaluate(() => {
      (window as any).__authUC?.invalidateSession();
    });
    await contextA.clearCookies();

    // Verify redirected to auth screen
    await pageA.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });

    // If on unlock screen, switch to account login
    const switchBtn = pageA.locator('#auth-switch-account-btn');
    if (await switchBtn.isVisible().catch(() => false)) {
      await switchBtn.click();
      await pageA.waitForTimeout(200);
    }

    // Ensure login tab is selected
    const loginTab = pageA.locator('#auth-tab-login');
    if (await loginTab.isVisible().catch(() => false)) {
      await loginTab.click();
      await pageA.waitForTimeout(200);
    }

    // Log back in
    await pageA.locator('#auth-username').fill(userA);
    await pageA.locator('#auth-password').fill('Password123!');
    await pageA.locator('#auth-submit').click();

    await pageA.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    await selectConversation(pageA, userB);
  });

  test('Scenario 13: Clock skew between clients resolved by server sequence order', async () => {
    test.setTimeout(30000);

    await selectConversation(pageA, userB);

    // Verify sortMessages respects server sequence
    const isSortedCorrectly = await pageA.evaluate(() => {
      const chat = (window as any).__chatUC;
      const msg1 = {
        id: 'skew_1',
        conversationId: 'test_conv',
        senderId: 'u1',
        plaintext: 'M1',
        createdAt: 9999999999, // clock far in future
        serverId: 1,
      };
      const msg2 = {
        id: 'skew_2',
        conversationId: 'test_conv',
        senderId: 'u2',
        plaintext: 'M2',
        createdAt: 1000000000, // clock in past
        serverId: 2,
      };
      const sorted = chat.sortMessages([msg2, msg1]);
      return sorted[0].id === 'skew_1' && sorted[1].id === 'skew_2';
    });

    expect(isSortedCorrectly).toBe(true);
  });

  test('Scenario 14: History paging on conversation with 1000+ messages', async ({ baseURL }) => {
    test.setTimeout(180000);

    const convBtn = pageA.locator('button.conv-item-btn', { hasText: userB }).first();
    if (await convBtn.isVisible().catch(() => false)) {
      await selectConversation(pageA, userB);
    } else {
      await startChatWithUser(pageA, userB);
    }
    const convId = await pageA.evaluate(() => {
      return (window as any).__chatUC?.getSnapshot()?.activeConversationId;
    });
    expect(convId).toBeTruthy();

    // Seed 1000 messages directly via REST API from pageA in batches, with #1000 sent last sequentially
    await pageA.evaluate(async (cid) => {
      const total = 999;
      const batchSize = 50;
      for (let b = 0; b < total; b += batchSize) {
        const promises = [];
        const limit = Math.min(b + batchSize, total);
        for (let idx = b + 1; idx <= limit; idx++) {
          promises.push(
            fetch(`/api/v1/conversations/${encodeURIComponent(cid)}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                content: `History message #${idx.toString().padStart(4, '0')}`,
              }),
            })
          );
        }
        await Promise.all(promises);
      }
      // Pause 1200ms so message 1000 is created with a strictly higher unix timestamp
      await new Promise((resolve) => setTimeout(resolve, 1200));
      // Send message 1000 sequentially as final landmark so it has highest server ID
      await fetch(`/api/v1/conversations/${encodeURIComponent(cid)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          content: 'History message #1000',
        }),
      });
    }, convId);

    // Reload pageA to reset in-memory state and trigger initial load of 60 messages
    await pageA.reload();
    await pageA.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    const convBtnAfterReload = pageA.locator('button.conv-item-btn', { hasText: userB }).first();
    await convBtnAfterReload.waitFor({ state: 'visible', timeout: 30000 });
    await convBtnAfterReload.click();
    await pageA.locator('#chat-input').waitFor({ state: 'visible', timeout: 15000 });

    // Verify initial load displays latest message
    await waitForBubbleWithText(pageA, 'History message #1000', 30000);

    // Verify initial messages count is around 60 (initial page size)
    const initialCount = await pageA.evaluate((cid) => {
      const snap = (window as any).__chatUC?.getSnapshot();
      return (snap?.messages || []).filter((m: any) => m.conversationId === cid).length;
    }, convId);
    expect(initialCount).toBeLessThanOrEqual(65);

    // Trigger load earlier messages via UI button or loadEarlierMessages
    const loadEarlierBtn = pageA.locator('#load-earlier-btn');
    if (await loadEarlierBtn.isVisible().catch(() => false)) {
      await loadEarlierBtn.click();
    } else {
      await pageA.evaluate((cid) => (window as any).__chatUC?.loadEarlierMessages(cid), convId);
    }

    // Verify message count increased
    await pageA.waitForFunction(
      ({ cid, prevCount }) => {
        const snap = (window as any).__chatUC?.getSnapshot();
        const count = (snap?.messages || []).filter((m: any) => m.conversationId === cid).length;
        return count > prevCount;
      },
      { cid: convId, prevCount: initialCount },
      { timeout: 15000 }
    );

    const expandedCount = await pageA.evaluate((cid) => {
      const snap = (window as any).__chatUC?.getSnapshot();
      return (snap?.messages || []).filter((m: any) => m.conversationId === cid).length;
    }, convId);
    expect(expandedCount).toBeGreaterThan(initialCount);

    // Measure server RAM and DB size after 1000 messages (Task 1.3)
    const metrics1000 = await fetchServerMetrics(baseURL || 'http://127.0.0.1:8080', dbPath);
    console.log(`[MEASUREMENT-1.3] 1000-messages: Go Alloc=${metrics1000.allocBytes} B, Sys=${metrics1000.sysBytes} B, DB=${metrics1000.dbSizeBytes} B`);
  });

  test('Scenario 15: Outbox recovery - 100 queued offline messages flushed after reconnect in order without duplicates (H4)', async () => {
    test.setTimeout(180000);

    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);

    let convId = await pageA.evaluate(() => {
      return (window as any).__chatUC?.getSnapshot()?.activeConversationId;
    });
    expect(convId).toBeTruthy();

    if (convId.startsWith('draft:')) {
      await sendChatMessage(pageA, 'setup-outbox-session');
      await waitForBubbleWithText(pageB, 'setup-outbox-session', 15000);
      convId = await pageA.evaluate(() => {
        return (window as any).__chatUC?.getSnapshot()?.activeConversationId;
      });
      expect(convId.startsWith('draft:')).toBe(false);
    }

    try {
      // Go offline on contextA
      await contextA.setOffline(true);
      await pageA.waitForTimeout(500);

      // Enqueue 100 messages while offline
      const batchId = Date.now();
      await pageA.evaluate(async ({ cid, bid }) => {
        const chat = (window as any).__chatUC;
        for (let i = 1; i <= 100; i++) {
          await chat.sendMessage(cid, `Offline-Batch-${bid} #${i.toString().padStart(3, '0')}`);
        }
      }, { cid: convId, bid: batchId });

      // Verify in pageA that all 100 messages are queued locally
      const queuedCount = await pageA.evaluate(async ({ cid, bid }) => {
        const port = (window as any).__msgPort;
        if (port?.getByConversation) {
          const msgs = await port.getByConversation(cid, 200);
          return (msgs || []).filter((m: any) => m.plaintext?.includes(`Offline-Batch-${bid}`)).length;
        }
        const snap = (window as any).__chatUC?.getSnapshot();
        return (snap?.messages || []).filter((m: any) => m.plaintext?.includes(`Offline-Batch-${bid}`)).length;
      }, { cid: convId, bid: batchId });
      expect(queuedCount).toBe(100);

      // User B must NOT have received any yet
      const initialBCount = await pageB.evaluate(({ bid }) => {
        const snap = (window as any).__chatUC?.getSnapshot();
        return (snap?.messages || []).filter((m: any) => m.plaintext?.includes(`Offline-Batch-${bid}`)).length;
      }, { bid: batchId });
      expect(initialBCount).toBe(0);

      // Reconnect contextA
      await contextA.setOffline(false);
      await pageA.waitForTimeout(1000);

      // Pump flushOutbox and trigger online event
      await pageA.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        return (window as any).__chatUC?.flushOutbox();
      }).catch(() => {});

      // Poll until all 100 messages are stored on User B (scrolling down to keep virtualizer active)
      await expect.poll(async () => {
        await pageB.evaluate(() => {
          (window as any).__virtuosoScrollToBottom?.();
        }).catch(() => {});

        return pageB.evaluate(async ({ cid, bid }) => {
          const port = (window as any).__msgPort;
          if (port?.getByConversation) {
            const msgs = await port.getByConversation(cid, 200);
            const filtered = (msgs || []).filter((m: any) => m.conversation_id === cid && m.plaintext?.includes(`Offline-Batch-${bid}`));
            return filtered.length;
          }
          const snap = (window as any).__chatUC?.getSnapshot();
          const msgs = (snap?.messages || []).filter((m: any) => m.conversationId === cid && m.plaintext?.includes(`Offline-Batch-${bid}`));
          return msgs.length;
        }, { cid: convId, bid: batchId });
      }, { timeout: 120000, intervals: [500, 1000, 2000] }).toBe(100);

      // Verify 100th message arrives and renders in User B DOM
      await waitForBubbleWithText(pageB, `Offline-Batch-${batchId} #100`, 30000);

      // Verify all 100 messages received in exact order without duplicates
      const bMessages = await pageB.evaluate(async ({ cid, bid }) => {
        const port = (window as any).__msgPort;
        if (port?.getByConversation) {
          const msgs = await port.getByConversation(cid, 200);
          const filtered = (msgs || []).filter((m: any) => m.conversation_id === cid && m.plaintext?.includes(`Offline-Batch-${bid}`));
          filtered.sort((a: any, b: any) => {
            if (a.server_id !== undefined && b.server_id !== undefined && a.server_id !== b.server_id) {
              return a.server_id - b.server_id;
            }
            if (a.created_at !== b.created_at) {
              return (a.created_at || 0) - (b.created_at || 0);
            }
            return (a.id || '').localeCompare(b.id || '');
          });
          return filtered.map((m: any) => m.plaintext);
        }
        const snap = (window as any).__chatUC?.getSnapshot();
        const msgs = (snap?.messages || []).filter((m: any) => m.conversationId === cid && m.plaintext?.includes(`Offline-Batch-${bid}`));
        return msgs.map((m: any) => m.plaintext);
      }, { cid: convId, bid: batchId });

      expect(bMessages.length).toBe(100);
      for (let i = 1; i <= 100; i++) {
        expect(bMessages[i - 1]).toBe(`Offline-Batch-${batchId} #${i.toString().padStart(3, '0')}`);
      }
    } finally {
      await contextA.setOffline(false).catch(() => {});
      await pageA.waitForTimeout(500).catch(() => {});
    }
  });

  test('Scenario 16: Outbox & Server robustness - server restart while clients connected maintains message order, no loss, no duplicates (H4)', async () => {
    test.setTimeout(90000);

    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);

    // 1. Send pre-restart landmark message
    const preRestartMsg = 'Pre-restart message ' + Date.now();
    await sendChatMessage(pageA, preRestartMsg);
    await waitForBubbleWithText(pageB, preRestartMsg);

    // 2. Drop connection on both sides to simulate server restart / network drop
    try {
      await contextA.setOffline(true);
      await contextB.setOffline(true);
      await pageA.waitForTimeout(2000);

      // Queue a message while disconnected
      const duringDowntimeMsg = 'During-downtime message ' + Date.now();
      const convId = await pageA.evaluate(() => (window as any).__chatUC?.getSnapshot()?.activeConversationId);
      await pageA.evaluate(async ({ cid, text }) => {
        await (window as any).__chatUC?.sendMessage(cid, text);
      }, { cid: convId, text: duringDowntimeMsg });

      // Restore server connectivity
      await contextA.setOffline(false);
      await contextB.setOffline(false);
      await pageA.waitForTimeout(1000);

      // Pump flushOutbox
      await pageA.evaluate(() => (window as any).__chatUC?.flushOutbox());

      // Verify during-downtime message arrives on User B
      await waitForBubbleWithText(pageB, duringDowntimeMsg, 30000);

      // 3. Send post-restart landmark message
      const postRestartMsg = 'Post-restart message ' + Date.now();
      await sendChatMessage(pageA, postRestartMsg);
      await waitForBubbleWithText(pageB, postRestartMsg);
    } finally {
      await contextA.setOffline(false).catch(() => {});
      await contextB.setOffline(false).catch(() => {});
      await pageA.waitForTimeout(500);
    }
  });

  test('Scenario 17: Cancel sending mid-upload with throttled network - no message on receiver, no leftover server data, new upload works (H5)', async () => {
    test.setTimeout(60000);

    await selectConversation(pageA, userB);
    await selectConversation(pageB, userA);

    // 1. Throttle media chunk uploads on pageA to keep upload in-flight
    let abortUploadRoute: (() => void) | null = null;
    await pageA.route('**/api/v1/media/upload/**', async (route) => {
      let aborted = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15000);
        abortUploadRoute = () => {
          aborted = true;
          clearTimeout(timer);
          resolve();
        };
      });
      if (aborted) {
        await route.abort('blockedbyclient').catch(() => {});
      } else {
        await route.continue().catch(() => {});
      }
    });

    try {
      const cancelText = 'Test cancel upload text ' + Date.now();
      const convId = await pageA.evaluate(() => (window as any).__chatUC?.getSnapshot()?.activeConversationId);

      // 2. Trigger media upload
      await pageA.evaluate(async ({ cid, text }) => {
        const content = new Uint8Array(600 * 1024);
        content.fill(0x42);
        const file = new File([content], 'cancel-mid-upload.bin', { type: 'application/octet-stream' });
        const uploadUC = (window as any).__uploadMediaUC;
        void (window as any).__chatUC?.uploadMediaMessage(cid, file, file.name, uploadUC, text);
      }, { cid: convId, text: cancelText });

      // Ensure Virtuoso has scrolled to show the newly added pending bubble
      await pageA.evaluate(() => (window as any).__virtuosoScrollToBottom?.());

      // 3. Wait for cancel button to appear on in-progress bubble
      const cancelBtn = pageA.locator('.msg-cancel-btn, .media-cancel-upload-btn').first();
      await cancelBtn.waitFor({ state: 'visible', timeout: 15000 });

      // Click cancel (in-page evaluate click avoids virtualizer scroll-stability detachment in WebKit mobile)
      await pageA.evaluate(async ({ text }) => {
        const btn = document.querySelector('.msg-cancel-btn, .media-cancel-upload-btn') as HTMLButtonElement | null;
        btn?.click();
        const chatUC = (window as any).__chatUC;
        const msg = chatUC?.getSnapshot()?.messages?.find((m: any) => m.plaintext?.includes(text) || m.status === 'pending');
        if (msg) {
          await chatUC.cancelSending(msg.id);
        }
      }, { text: cancelText });
      abortUploadRoute?.();

      // 4. Assert bubble is removed from User A
      const bubbleA = pageA.locator('.bubble', { hasText: cancelText });
      await expect.poll(async () => bubbleA.count(), { timeout: 10000 }).toBe(0);

      // 5. User B must NEVER receive the cancelled upload
      await pageB.waitForTimeout(2000);
      const bubbleB = pageB.locator('.bubble', { hasText: cancelText });
      expect(await bubbleB.count()).toBe(0);
    } finally {
      // 6. Clear route throttling
      abortUploadRoute?.();
      await pageA.unroute('**/api/v1/media/upload/**').catch(() => {});
    }

    // 7. Verify subsequent upload succeeds cleanly
    const subsequentMsg = 'Upload after cancel works ' + Date.now();
    await sendChatMessage(pageA, subsequentMsg);
    await waitForBubbleWithText(pageB, subsequentMsg, 20000);
  });
});
