import { test, expect, Page } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT_DIR = path.resolve(__dirname, '../../..');

async function waitForServerReady(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.ok) return;
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} failed to become ready within ${timeoutMs}ms`);
}

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

test.describe('Server Relocation Test Harness (A3)', () => {
  let serverAProcess: ChildProcess | null = null;
  let serverBProcess: ChildProcess | null = null;
  let tempBase: string;
  let serverABin: string;

  test.beforeAll(async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rootinbox-reloc-'));
    const binExt = process.platform === 'win32' ? '.exe' : '';
    serverABin = path.join(tempBase, `rootinbox-server${binExt}`);

    // Build the Go binary if not already built
    console.log(`[Relocation] Building rootinbox binary -> ${serverABin}`);
    const buildRes = require('child_process').spawnSync('go', ['build', '-o', serverABin, './cmd/rootinbox'], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    });
    if (buildRes.status !== 0) {
      throw new Error(`Failed to compile Go server binary: exit code ${buildRes.status}`);
    }
  });

  test.afterEach(async () => {
    if (serverAProcess && !serverAProcess.killed) {
      serverAProcess.kill('SIGKILL');
      serverAProcess = null;
    }
    if (serverBProcess && !serverBProcess.killed) {
      serverBProcess.kill('SIGKILL');
      serverBProcess = null;
    }
  });

  test.afterAll(() => {
    try {
      if (tempBase && fs.existsSync(tempBase)) {
        fs.rmSync(tempBase, { recursive: true, force: true });
      }
    } catch {
      // best effort cleanup
    }
  });

  test('Server A -> Server B relocation preserves message history in a fresh browser context', async ({ browser }) => {
    console.log('================================================================================');
    console.log(' ROOTINBOX RELOCATION HARNESS EXECUTION');
    console.log('================================================================================');

    const portA = 18081;
    const portB = 18082;
    const originA = `http://127.0.0.1:${portA}`;
    const originB = `http://127.0.0.1:${portB}`;

    const dataDirA = path.join(tempBase, 'data-a');
    const mediaDirA = path.join(dataDirA, 'media');
    fs.mkdirSync(mediaDirA, { recursive: true });
    const dbPathA = path.join(dataDirA, 'app.db');

    const dataDirB = path.join(tempBase, 'data-b');
    const mediaDirB = path.join(dataDirB, 'media');
    const dbPathB = path.join(dataDirB, 'app.db');

    // H3 / Deployment Secret for Server A
    const secretA = 'server_a_ip_hash_secret_32bytes_long_entropy!';
    // When relocated to Server B, the deployment origin and secrets represent the new host
    const secretB = 'server_b_ip_hash_secret_32bytes_long_entropy!';

    // ─── Phase 1: Start Server A ──────────────────────────────────────────────
    console.log(`[Phase 1] Launching Server A on ${originA}...`);
    const logFileA = fs.openSync(path.join(tempBase, 'server-a.log'), 'w');
    serverAProcess = spawn(serverABin, [], {
      env: {
        ...process.env,
        PORT: String(portA),
        SERVER_HOST: '127.0.0.1',
        APP_ORIGIN: originA,
        INSECURE_DEV_MODE: 'true',
        IP_HASH_SECRET: secretA,
        DB_PATH: dbPathA,
        MEDIA_PATH: mediaDirA,
        LOG_LEVEL: 'info',
        PUSH_ENABLED: 'false',
      },
      stdio: ['ignore', logFileA, logFileA],
    });

    await waitForServerReady(originA);
    console.log(`[Phase 1] Server A is ready on ${originA}`);

    // ─── Phase 2: Register Users & Exchange Messages on Server A ─────────────
    console.log('[Phase 2] Registering Alice and Bob on Server A...');
    const contextAliceA = await browser.newContext();
    const pageAliceA = await contextAliceA.newPage();

    const usernameAlice = `alice_${Math.random().toString(36).substring(2, 8)}`;
    const usernameBob = `bob_${Math.random().toString(36).substring(2, 8)}`;
    const testPassword = 'Password12345!';

    // Register Alice
    await pageAliceA.goto(originA);
    await pageAliceA.locator('#auth-tab-register').click();
    await pageAliceA.locator('#auth-display-name').fill('Alice Reloc');
    await pageAliceA.locator('#auth-username').fill(usernameAlice);
    await pageAliceA.locator('#auth-password').fill(testPassword);
    await pageAliceA.locator('#auth-submit').click();
    await pageAliceA.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    console.log(`[Phase 2] Alice registered: @${usernameAlice}`);

    // Register Bob in separate context
    const contextBobA = await browser.newContext();
    const pageBobA = await contextBobA.newPage();
    await pageBobA.goto(originA);
    await pageBobA.locator('#auth-tab-register').click();
    await pageBobA.locator('#auth-display-name').fill('Bob Reloc');
    await pageBobA.locator('#auth-username').fill(usernameBob);
    await pageBobA.locator('#auth-password').fill(testPassword);
    await pageBobA.locator('#auth-submit').click();
    await pageBobA.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    console.log(`[Phase 2] Bob registered: @${usernameBob}`);

    // Alice initiates conversation with Bob
    console.log(`[Phase 2] Alice starting 1:1 conversation with Bob (@${usernameBob})...`);
    await pageAliceA.locator('#user-search-input').fill(usernameBob);
    const msgBtn = pageAliceA.locator(`#search-msg-${usernameBob}`);
    await msgBtn.waitFor({ state: 'visible', timeout: 10000 });
    await msgBtn.click();
    await pageAliceA.locator('#chat-input').waitFor({ state: 'visible', timeout: 10000 });

    const msgEnglish = `Relocation Alpha Message - Origin A Verification [${Date.now()}]`;
    const msgPersian = `پیام آزمایشی جابجایی سرور - تایید مبدا [${Date.now()}]`;

    // Alice sends messages
    await pageAliceA.locator('#chat-input').fill(msgEnglish);
    await pageAliceA.locator('#chat-send-btn').click();
    await pageAliceA.locator('.bubble', { hasText: msgEnglish }).first().waitFor({ state: 'visible', timeout: 10000 });

    await pageAliceA.locator('#chat-input').fill(msgPersian);
    await pageAliceA.locator('#chat-send-btn').click();
    await pageAliceA.locator('.bubble', { hasText: msgPersian }).first().waitFor({ state: 'visible', timeout: 10000 });
    console.log('[Phase 2] Messages successfully sent and displayed on Server A.');

    // Close browser contexts for Server A
    await contextAliceA.close();
    await contextBobA.close();

    // ─── Phase 3: Stop Server A & Copy /data to Server B ───────────────────────
    console.log('[Phase 3] Shutting down Server A...');
    serverAProcess.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 1000));
    if (!serverAProcess.killed) {
      serverAProcess.kill('SIGKILL');
    }
    serverAProcess = null;

    console.log(`[Phase 3] Copying /data from Server A (${dataDirA}) -> Server B (${dataDirB})...`);
    copyDirRecursive(dataDirA, dataDirB);

    // ─── Phase 4: Start Server B on a Different Origin ────────────────────────
    console.log(`[Phase 4] Launching Server B on ${originB}...`);
    const logFileB = fs.openSync(path.join(tempBase, 'server-b.log'), 'w');
    serverBProcess = spawn(serverABin, [], {
      env: {
        ...process.env,
        PORT: String(portB),
        SERVER_HOST: '127.0.0.1',
        APP_ORIGIN: originB,
        INSECURE_DEV_MODE: 'true',
        IP_HASH_SECRET: secretB,
        DB_PATH: dbPathB,
        MEDIA_PATH: mediaDirB,
        LOG_LEVEL: 'info',
        PUSH_ENABLED: 'false',
      },
      stdio: ['ignore', logFileB, logFileB],
    });

    await waitForServerReady(originB);
    console.log(`[Phase 4] Server B is ready on ${originB}`);

    // ─── Phase 5: Fresh Browser Context Signs In on Server B ───────────────────
    console.log('[Phase 5] Opening FRESH browser context on Server B (no cookies, no IndexedDB)...');
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();

    await freshPage.goto(originB);

    // On fresh context, should land on AuthScreen
    await freshPage.locator('#auth-screen').waitFor({ state: 'visible', timeout: 15000 });

    console.log(`[Phase 5] Signing in as Alice (@${usernameAlice}) on Server B...`);
    const signinTab = freshPage.locator('#auth-tab-login');
    if (await signinTab.isVisible().catch(() => false)) {
      await signinTab.click();
    }
    await freshPage.locator('#auth-username').fill(usernameAlice);
    await freshPage.locator('#auth-password').fill(testPassword);
    await freshPage.locator('#auth-submit').click();

    await freshPage.locator('#chat-screen').waitFor({ state: 'visible', timeout: 15000 });
    console.log('[Phase 5] Alice successfully authenticated on Server B.');

    // ─── Phase 6: Check Conversation History Visibility ───────────────────────
    console.log('[Phase 6] Checking whether conversation history with Bob is visible on Server B...');

    // Look for conversation with Bob in sidebar
    const convItem = freshPage.locator('button.conv-item-btn', { hasText: usernameBob }).first();
    const hasConvItem = await convItem.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);

    let englishVisible = false;
    let persianVisible = false;
    let diagnosticDetails = '';

    if (!hasConvItem) {
      diagnosticDetails = `Conversation with @${usernameBob} not found in sidebar list on Server B.`;
    } else {
      await convItem.click();
      await freshPage.waitForTimeout(1000);

      englishVisible = await freshPage.locator('.bubble', { hasText: msgEnglish }).first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      persianVisible = await freshPage.locator('.bubble', { hasText: msgPersian }).first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (!englishVisible || !persianVisible) {
        const bubbleTexts = await freshPage.locator('.bubble').allInnerTexts().catch(() => []);
        diagnosticDetails = `Conversation loaded, but message bubbles missing or undecryptable. Visible bubbles count: ${bubbleTexts.length}. Content: ${JSON.stringify(bubbleTexts)}`;
      }
    }

    const baselinePassed = englishVisible && persianVisible;
    console.log('\n================================================================================');
    console.log(` RELOCATION VERIFICATION RESULT: ${baselinePassed ? 'PASS' : 'FAIL (EXPECTED BASELINE FAILURE)'}`);
    console.log('================================================================================');
    console.log(`Server A Origin:  ${originA}`);
    console.log(`Server B Origin:  ${originB}`);
    console.log(`User:             @${usernameAlice}`);
    console.log(`Peer:             @${usernameBob}`);
    console.log(`English Message:  ${englishVisible ? 'VISIBLE' : 'MISSING / UNDECRYPTABLE'}`);
    console.log(`Persian Message:  ${persianVisible ? 'VISIBLE' : 'MISSING / UNDECRYPTABLE'}`);
    if (diagnosticDetails) {
      console.log(`Diagnosis:        ${diagnosticDetails}`);
    }
    console.log(`Root Cause:       Current Stage 0 lacks cross-origin sealed vault sync;`);
    console.log(`                  IndexedDB session keys are origin-bound to ${originA};`);
    console.log(`                  Server B's IP_HASH_SECRET differs and server holds at-rest encryption.`);
    console.log('================================================================================\n');

    await freshContext.close();

    // Baseline expectation: EXPECTED TO FAIL TODAY
    expect(baselinePassed, `Relocation Baseline: History is NOT visible on Server B due to origin-bound keys and missing sealed vault. Details: ${diagnosticDetails}`).toBe(true);
  });
});
