/**
 * Minimal inline-free loader for RootInbox Device Pre-Check.
 * Complying with strict Content Security Policy (no inline scripts).
 * Ensures that if cryptographic or ES module chunks fail to load,
 * the page never hangs on WAIT / PENDING forever.
 */

declare global {
  interface Window {
    __deviceCheckTimer?: ReturnType<typeof setTimeout>;
    __deviceCheckComplete?: boolean;
  }
}

function failPendingChecks(reason: string) {
  const overall = document.getElementById('overall-status');
  if (overall && (overall.textContent?.trim() === 'PENDING' || overall.textContent?.trim() === 'RUNNING')) {
    overall.className = 'status-badge badge-fail';
    overall.textContent = 'FAIL';
  }

  const summary = document.getElementById('summary-counts');
  if (summary) {
    summary.textContent = `خطا: ${reason} (Script load or execution failure)`;
  }

  const badges = document.querySelectorAll('#checks-list .check-item');
  badges.forEach((item) => {
    const badge = item.querySelector('.status-badge');
    const detail = item.querySelector('.check-detail');
    if (badge && badge.textContent?.trim() === 'WAIT') {
      badge.className = 'status-badge badge-fail';
      badge.textContent = 'FAIL';
      if (detail && (detail.textContent?.trim() === '-' || detail.textContent?.trim() === 'در انتظار ماژول...')) {
        detail.textContent = reason;
      }
    }
  });

  // Enable copy button even on failure
  const copyBtn = document.getElementById('copy-report-btn');
  if (copyBtn && !copyBtn.dataset.bound) {
    copyBtn.dataset.bound = 'true';
    copyBtn.addEventListener('click', async () => {
      const lines = [
        '# RootInbox Device Diagnostic Report (FAIL / TIMEOUT)',
        `Date: ${new Date().toISOString()}`,
        `Overall Status: FAIL`,
        `Failure Reason: ${reason}`,
        '',
        '## Checks',
      ];
      document.querySelectorAll('#checks-list .check-item').forEach((it) => {
        const id = it.id;
        const b = it.querySelector('.status-badge')?.textContent?.trim() || 'UNKNOWN';
        const d = it.querySelector('.check-detail')?.textContent?.trim() || '';
        lines.push(`- **${id}**: [${b}] ${d}`);
      });
      const text = lines.join('\n');
      try {
        await navigator.clipboard.writeText(text);
        const prev = copyBtn.textContent;
        copyBtn.textContent = '✓ کپی شد (Copied!)';
        setTimeout(() => { copyBtn.textContent = prev; }, 2000);
      } catch (err: unknown) {
        alert('Could not copy report: ' + String(err));
      }
    });
  }
}

// 1. Error event listener for script tag loading failures
window.addEventListener('error', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && target.tagName === 'SCRIPT') {
    const src = (target as HTMLScriptElement).src || 'module script';
    failPendingChecks(`اسکریپت ماژول بارگذاری نشد: ${src}`);
  }
}, true);

// 2. Global uncaught exception / rejection listener
window.addEventListener('unhandledrejection', (event) => {
  if (!window.__deviceCheckComplete) {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || 'Unhandled rejection');
    // Log for debugging
    console.error('[DeviceCheck Loader] Unhandled rejection:', reason);
  }
});

// 3. Fallback timeout: turn WAIT into FAIL if checks do not complete within 12 seconds
window.__deviceCheckTimer = setTimeout(() => {
  if (!window.__deviceCheckComplete) {
    failPendingChecks('مهلت اجرای ماژول‌های تشخیصی به پایان رسید (Timeout after 12s)');
  }
}, 12000);
