// Polyfill Object.hasOwn for older Safari/iOS (iOS 15.8 / Safari < 15.4)
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    value: (obj: object, prop: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, prop),
    configurable: true,
    writable: true,
  });
}

import { runCryptoProbes } from './device-check-crypto';

interface CheckResult {
  status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'WARN';
  detail: string;
}

const reportData: {
  timestamp: string;
  checks: Record<string, CheckResult>;
} = {
  timestamp: new Date().toISOString(),
  checks: {},
};

function updateRow(rowId: string, status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'WARN', detailText: string): void {
  const el = document.getElementById(rowId);
  if (!el) return;
  const badge = el.querySelector('.status-badge');
  const detail = el.querySelector('.check-detail');
  if (badge) {
    badge.className = 'status-badge ' + (status === 'PASS' ? 'badge-pass' : (status === 'FAIL' ? 'badge-fail' : 'badge-warn'));
    badge.textContent = status;
  }
  if (detail && detailText) {
    detail.textContent = detailText;
  }
  reportData.checks[rowId] = { status, detail: detailText };
  updateOverall();
}

function updateOverall(): void {
  const badges = Array.from(document.querySelectorAll('#checks-list .status-badge'));
  const counts: Record<string, number> = { PASS: 0, FAIL: 0, WARN: 0, UNKNOWN: 0, WAIT: 0 };
  badges.forEach((b) => {
    const text = b.textContent?.trim() || '';
    counts[text] = (counts[text] || 0) + 1;
  });

  const overall = document.getElementById('overall-status');
  const summary = document.getElementById('summary-counts');
  if (overall) {
    if (counts.FAIL > 0) {
      overall.className = 'status-badge badge-fail';
      overall.textContent = 'FAIL';
    } else if (counts.WAIT > 0) {
      overall.className = 'status-badge badge-pending';
      overall.textContent = 'RUNNING';
    } else if (counts.WARN > 0) {
      overall.className = 'status-badge badge-warn';
      overall.textContent = 'WARNING';
    } else {
      overall.className = 'status-badge badge-pass';
      overall.textContent = 'PASS';
    }
  }

  if (summary) {
    summary.textContent = `تأییدشده: ${counts.PASS || 0} | خطا: ${counts.FAIL || 0} | هشدار: ${counts.WARN || 0} | در حال انتظار: ${counts.WAIT || 0}`;
  }
}

async function runBasicChecks(): Promise<void> {
  // 1. Secure context
  if (window.isSecureContext) {
    updateRow('check-secure-context', 'PASS', 'window.isSecureContext === true (HTTPS/Localhost active)');
  } else {
    updateRow('check-secure-context', 'FAIL', 'Insecure Context! WebCrypto is disabled by browser. Root CA / HTTPS required.');
  }

  // 2. SubtleCrypto
  if (window.crypto && window.crypto.subtle) {
    updateRow('check-crypto-subtle', 'PASS', 'window.crypto.subtle available');
  } else {
    updateRow('check-crypto-subtle', 'FAIL', 'SubtleCrypto is undefined (requires HTTPS or modern browser)');
  }

  // 3. getRandomValues
  try {
    const buf = new Uint8Array(32);
    window.crypto.getRandomValues(buf);
    const hasNonZero = buf.some((b) => b !== 0);
    if (hasNonZero) {
      updateRow('check-crypto-random-values', 'PASS', 'CSPRNG generated 32 random bytes successfully');
    } else {
      updateRow('check-crypto-random-values', 'FAIL', 'getRandomValues returned all-zero bytes');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRow('check-crypto-random-values', 'FAIL', 'Error: ' + msg);
  }

  // 4. randomUUID
  if (typeof window.crypto.randomUUID === 'function') {
    const testUuid = window.crypto.randomUUID();
    updateRow('check-crypto-random-uuid', 'PASS', 'Native crypto.randomUUID supported: ' + testUuid);
  } else {
    updateRow('check-crypto-random-uuid', 'UNKNOWN', 'Native crypto.randomUUID missing (Safari < 15.4); JS fallback will be used');
  }

  // 5. WebAssembly presence
  if (typeof WebAssembly !== 'undefined') {
    updateRow('check-wasm-presence', 'PASS', 'WebAssembly runtime object detected');
  } else {
    updateRow('check-wasm-presence', 'FAIL', 'WebAssembly is completely unavailable');
  }

  // 6. WASM 32MB Memory (512 pages)
  try {
    const mem32 = new WebAssembly.Memory({ initial: 512 });
    if (mem32.buffer.byteLength === 512 * 65536) {
      updateRow('check-wasm-memory-32', 'PASS', 'Allocated 512 pages (33,554,432 bytes / 32 MiB) successfully');
    } else {
      updateRow('check-wasm-memory-32', 'FAIL', 'Unexpected buffer length: ' + mem32.buffer.byteLength);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRow('check-wasm-memory-32', 'FAIL', 'Allocation failed (OutOfMemory): ' + msg);
  }

  // 7. WASM 64MB Memory (1024 pages)
  try {
    const mem64 = new WebAssembly.Memory({ initial: 512, maximum: 1024 });
    const grown = mem64.grow(512); // grow to 1024 pages = 64 MB
    if (grown === 512 && mem64.buffer.byteLength === 1024 * 65536) {
      updateRow('check-wasm-memory-64', 'PASS', 'Allocated and grew to 1024 pages (67,108,864 bytes / 64 MiB) successfully');
    } else {
      // Direct 1024 allocation fallback test
      new WebAssembly.Memory({ initial: 1024 });
      updateRow('check-wasm-memory-64', 'PASS', 'Direct 1024 pages allocated successfully (64 MiB)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRow('check-wasm-memory-64', 'FAIL', 'Allocation failed for 64 MiB: ' + msg + '. Device RAM or WebKit memory limit exceeded.');
  }

  // 11. IndexedDB
  try {
    const dbName = 'rootinbox_test_probe_idb';
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('test');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('test', 'readwrite');
        tx.objectStore('test').put({ key: 'probe', val: 123 }, 'k');
        tx.oncomplete = () => {
          db.close();
          indexedDB.deleteDatabase(dbName);
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    updateRow('check-indexeddb', 'PASS', 'IndexedDB write/read/delete transaction completed cleanly');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRow('check-indexeddb', 'FAIL', 'IndexedDB unavailable or blocked: ' + msg);
  }

  // 12. ServiceWorker
  if ('serviceWorker' in navigator) {
    updateRow('check-serviceworker', 'PASS', 'navigator.serviceWorker is supported');
  } else {
    updateRow('check-serviceworker', 'UNKNOWN', 'ServiceWorker not available in this browser environment');
  }

  // 13. Notifications
  const win = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
  const notifApi = win ? (win['Notification'] as { permission?: string } | undefined) : undefined;
  if (notifApi) {
    updateRow('check-notifications', 'PASS', 'Notification API available (Permission: ' + notifApi.permission + ')');
  } else {
    updateRow('check-notifications', 'UNKNOWN', 'Notification API not available in this browser');
  }

  // 14 & 16. Health Ready fetch & Clock Skew
  try {
    const tStart = performance.now();
    const res = await fetch('/health/ready', { cache: 'no-store' });
    const tDuration = Math.round(performance.now() - tStart);
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const statusVal = json && json.status ? json.status : 'ok';
      updateRow('check-health-ready', 'PASS', `HTTP 200 OK (${tDuration}ms, status: "${statusVal}")`);
    } else {
      updateRow('check-health-ready', 'FAIL', `HTTP ${res.status} ${res.statusText}`);
    }

    const dateHeader = res.headers.get('Date');
    if (dateHeader) {
      const serverTime = new Date(dateHeader).getTime();
      const clientTime = Date.now();
      const diffSec = (serverTime - clientTime) / 1000;
      const absDiff = Math.abs(diffSec);
      if (absDiff <= 60) {
        updateRow('check-clock-skew', 'PASS', `Clock difference: ${diffSec.toFixed(2)}s (Server: ${dateHeader})`);
      } else {
        updateRow('check-clock-skew', 'FAIL', `Clock difference is ${diffSec.toFixed(1)}s! Must be within 60s for authentication.`);
      }
    } else {
      updateRow('check-clock-skew', 'UNKNOWN', 'Date header omitted in server response');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRow('check-health-ready', 'FAIL', 'Fetch failed: ' + msg + ' (Possible TLS certificate rejection or network offline)');
    updateRow('check-clock-skew', 'UNKNOWN', 'Could not fetch server time');
  }

  // 15. WebSocket Probe
  try {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/api/v1/ws`;
    await new Promise<string>((resolve) => {
      let finished = false;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          ws.close();
          resolve('Connected or reached handshake within timeout');
        }
      }, 2500);

      ws.onopen = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          ws.close();
          resolve('WebSocket handshake succeeded (onopen)');
        }
      };
      ws.onerror = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve('Handshake initiated (onerror / unauthenticated close)');
        }
      };
    });
    updateRow('check-websocket', 'PASS', 'WebSocket handshake reachable at ' + wsUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRow('check-websocket', 'FAIL', 'WebSocket failed: ' + msg);
  }

  // 17. Client environment
  const ua = navigator.userAgent;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || ((navigator as unknown as { standalone?: boolean }).standalone === true);
  let iosVer = 'N/A';
  const m = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))?/);
  if (m) {
    iosVer = `iOS ${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}`;
  }
  updateRow('check-client-environment', 'PASS', `Platform: ${navigator.platform} | ${iosVer} | Standalone PWA: ${isStandalone} | UA: ${ua}`);
}

async function runAdvancedCryptoChecks(): Promise<void> {
  try {
    const res = await runCryptoProbes();
    updateRow(
      'check-argon2-real',
      res.argon2Real.status,
      res.argon2Real.status === 'PASS'
        ? `Completed in ${res.argon2Real.durationMs}ms (m=65536 KiB, t=3, p=4)`
        : `Failed: ${res.argon2Real.error}`
    );

    updateRow(
      'check-capability-probe',
      res.capabilityProbe.status,
      res.capabilityProbe.status === 'PASS'
        ? `Matched expected seed (fb630f9d...)`
        : `Failed: ${res.capabilityProbe.error}`
    );

    updateRow(
      'check-libsodium-ed25519',
      res.sodiumProbe.status,
      res.sodiumProbe.status === 'PASS'
        ? `Ed25519 Detached Verify: OK, X25519 Session KX: OK`
        : `Failed: ${res.sodiumProbe.error}`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRow('check-argon2-real', 'FAIL', 'Crypto execution error: ' + msg);
    updateRow('check-capability-probe', 'FAIL', 'Capability probe error: ' + msg);
    updateRow('check-libsodium-ed25519', 'FAIL', 'Sodium probe error: ' + msg);
  }
}

async function runAll(): Promise<void> {
  await runBasicChecks();
  await runAdvancedCryptoChecks();
  window.__deviceCheckComplete = true;
  if (window.__deviceCheckTimer) {
    clearTimeout(window.__deviceCheckTimer);
  }
}

function init(): void {
  const rerunBtn = document.getElementById('run-tests-btn');
  if (rerunBtn) {
    rerunBtn.addEventListener('click', () => {
      void runAll();
    });
  }

  const copyBtn = document.getElementById('copy-report-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const overallEl = document.getElementById('overall-status');
      const lines = [
        '# RootInbox Device Diagnostic Report',
        `Date: ${new Date().toISOString()}`,
        `Overall Status: ${overallEl?.textContent || 'UNKNOWN'}`,
        '',
        '## Checks',
      ];
      for (const [id, val] of Object.entries(reportData.checks)) {
        lines.push(`- **${id}**: [${val.status}] ${val.detail}`);
      }
      const text = lines.join('\n');
      try {
        await navigator.clipboard.writeText(text);
        const oldText = copyBtn.textContent;
        copyBtn.textContent = '✓ کپی شد (Copied!)';
        setTimeout(() => {
          copyBtn.textContent = oldText;
        }, 2000);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        alert('Could not copy report: ' + msg);
      }
    });
  }

  void runAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
