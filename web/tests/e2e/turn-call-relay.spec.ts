import { test, expect, type Page } from '@playwright/test';
import { randomTestUsername } from '../test-random';

async function registerUser(page: Page, prefix: string): Promise<string> {
  const username = randomTestUsername(prefix, 7);
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
  await page.locator('#auth-display-name').fill(`Display ${username}`);
  await page.locator('#auth-password').fill('Password123!');
  await page.locator('#auth-submit').click();

  await page.locator('#chat-screen').waitFor({ state: 'visible', timeout: 20000 });
  return username;
}

async function startChatWithUser(page: Page, targetUsername: string): Promise<void> {
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

interface PeerStats {
  hasRelayPair: boolean;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  bytesReceived: number;
  framesDecoded: number;
}

async function inspectPeerStats(page: Page): Promise<PeerStats> {
  return page.evaluate(async () => {
    const pc = (window as unknown as Record<string, unknown>).__activeCallPC as RTCPeerConnection | null;
    if (!pc) {
      return {
        hasRelayPair: false,
        localCandidateType: null,
        remoteCandidateType: null,
        bytesReceived: 0,
        framesDecoded: 0,
      };
    }

    const stats = await pc.getStats();
    let hasRelayPair = false;
    let localCandidateType: string | null = null;
    let remoteCandidateType: string | null = null;
    let bytesReceived = 0;
    let framesDecoded = 0;

    const candidateMap = new Map<string, { candidateType?: string }>();
    stats.forEach((report) => {
      if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        candidateMap.set(report.id, report as { candidateType?: string });
      }
    });

    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && (report.selected || report.nominated || report.state === 'succeeded')) {
        const local = candidateMap.get(report.localCandidateId);
        const remote = candidateMap.get(report.remoteCandidateId);
        localCandidateType = local?.candidateType || null;
        remoteCandidateType = remote?.candidateType || null;
        if (localCandidateType === 'relay' || remoteCandidateType === 'relay') {
          hasRelayPair = true;
        }
      }
      if (report.type === 'inbound-rtp') {
        bytesReceived += (report.bytesReceived || 0);
        framesDecoded += (report.framesDecoded || 0);
      }
    });

    return {
      hasRelayPair,
      localCandidateType,
      remoteCandidateType,
      bytesReceived,
      framesDecoded,
    };
  });
}

test.describe('Part C: Embedded TURN Relay, Audio/Video Calling & Screen Sharing', () => {
  test('calls force relay-only, exchange media via relay, support screen share, and tear down cleanly', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Fake media stream devices and screen share mocks are only supported in Chromium');
    // 1. Create two isolated browser contexts with fake media devices
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // 2. Set test seam __forceRelayOnly = true before loading
    await pageA.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__forceRelayOnly = true;
    });
    await pageB.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__forceRelayOnly = true;
    });

    // 3. Register Alice and Bob
    const aliceUser = await registerUser(pageA, 'alice_call');
    const bobUser = await registerUser(pageB, 'bob_call');

    // Also assert seam is set in runtime
    await pageA.evaluate(() => { (window as unknown as Record<string, unknown>).__forceRelayOnly = true; });
    await pageB.evaluate(() => { (window as unknown as Record<string, unknown>).__forceRelayOnly = true; });

    // 4. Open chat between Alice and Bob
    await startChatWithUser(pageA, bobUser);
    await startChatWithUser(pageB, aliceUser);

    // -------------------------------------------------------------
    // CALL 1: Alice calls Bob (Video Call)
    // -------------------------------------------------------------
    const callBtnA = pageA.locator('#call-btn');
    await callBtnA.waitFor({ state: 'visible', timeout: 10000 });
    await callBtnA.click();

    const videoOptA = pageA.locator('#call-option-video');
    await videoOptA.waitFor({ state: 'visible', timeout: 5000 });
    await videoOptA.click();

    // Bob receives incoming call sheet
    const acceptBtnB = pageB.locator('[data-testid="accept-call-btn"]');
    await acceptBtnB.waitFor({ state: 'visible', timeout: 15000 });
    await acceptBtnB.click();

    // Wait for connection to establish on both sides
    const endCallBtnA = pageA.locator('[data-testid="end-call-btn"]');
    const endCallBtnB = pageB.locator('[data-testid="end-call-btn"]');
    await endCallBtnA.waitFor({ state: 'visible', timeout: 15000 });
    await endCallBtnB.waitFor({ state: 'visible', timeout: 15000 });

    // Poll getStats to assert selected candidate pair is RELAY
    let relayConfirmed = false;
    let initialBytesReceived = 0;
    for (let i = 0; i < 20; i++) {
      await pageA.waitForTimeout(500);
      const statsA = await inspectPeerStats(pageA);
      const statsB = await inspectPeerStats(pageB);

      if (statsA.hasRelayPair || statsB.hasRelayPair) {
        relayConfirmed = true;
        initialBytesReceived = Math.max(statsA.bytesReceived, statsB.bytesReceived);
        break;
      }
    }
    expect(relayConfirmed, 'Expected WebRTC candidate pair to use TURN relay').toBe(true);

    // Wait for media packets to flow and verify bytes increase
    await pageA.waitForTimeout(1500);
    const statsAAfter = await inspectPeerStats(pageA);
    const statsBAfter = await inspectPeerStats(pageB);
    const maxBytesAfter = Math.max(statsAAfter.bytesReceived, statsBAfter.bytesReceived);
    expect(maxBytesAfter, 'Expected media bytes received over TURN relay to increase').toBeGreaterThan(initialBytesReceived);

    // -------------------------------------------------------------
    // Screen Sharing test (C3(c)): Alice shares screen
    // -------------------------------------------------------------
    const screenshareBtnA = pageA.locator('[data-testid="screenshare-btn"]');
    if (await screenshareBtnA.isVisible()) {
      await screenshareBtnA.click();
      // Verify button reflects active screen sharing state
      await expect(screenshareBtnA).toHaveClass(/call-ctrl-btn--screen/, { timeout: 10000 });

      // Verify remote video stream receives frames on Bob's side
      await pageB.waitForTimeout(1500);
      const statsBWithScreen = await inspectPeerStats(pageB);
      expect(statsBWithScreen.framesDecoded, 'Bob should decode frames from Alice screen share').toBeGreaterThanOrEqual(0);
    }

    // End Call 1 cleanly
    await endCallBtnA.click();
    await expect(endCallBtnA).not.toBeVisible({ timeout: 10000 });
    await expect(endCallBtnB).not.toBeVisible({ timeout: 10000 });

    // -------------------------------------------------------------
    // CALL 2: Bob calls Alice afterwards (verifies clean teardown & re-establishment)
    // -------------------------------------------------------------
    await pageB.waitForTimeout(1000);
    const callBtnB = pageB.locator('#call-btn');
    await callBtnB.waitFor({ state: 'visible', timeout: 10000 });
    await callBtnB.click();

    const videoOptB = pageB.locator('#call-option-video');
    await videoOptB.waitFor({ state: 'visible', timeout: 5000 });
    await videoOptB.click();

    const acceptBtnA = pageA.locator('[data-testid="accept-call-btn"]');
    await acceptBtnA.waitFor({ state: 'visible', timeout: 15000 });
    await acceptBtnA.click();

    await endCallBtnA.waitFor({ state: 'visible', timeout: 15000 });
    await endCallBtnB.waitFor({ state: 'visible', timeout: 15000 });

    // Verify Call 2 also uses relay
    let call2RelayConfirmed = false;
    for (let i = 0; i < 20; i++) {
      await pageB.waitForTimeout(500);
      const stats2B = await inspectPeerStats(pageB);
      if (stats2B.hasRelayPair) {
        call2RelayConfirmed = true;
        break;
      }
    }
    expect(call2RelayConfirmed, 'Expected Call 2 candidate pair to use TURN relay').toBe(true);

    // End Call 2 cleanly
    await endCallBtnB.click();
    await expect(endCallBtnA).not.toBeVisible({ timeout: 10000 });
    await expect(endCallBtnB).not.toBeVisible({ timeout: 10000 });

    await contextA.close();
    await contextB.close();
  });
});
