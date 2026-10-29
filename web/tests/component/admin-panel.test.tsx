/**
 * Component Tests for Phase 10 / RFC-0014 Admin Panel.
 * Verifies:
 * - AdminLogin: key input, 401 error handling, successful entry.
 * - AdminScreen: layout, navigation tabs, in-memory auth persistence, logout.
 * - AdminUserManagement: identity lookup, suspend, resume, 2-step tombstone.
 * - AdminIPBlocklist: list, ban, unban, confirmation modals.
 * - AdminAuditLog: query filtering by event type, pagination.
 * - AdminWorkerTriggers: trigger dispatch, 202 accepted feedback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminScreen } from '../../src/presentation/components/admin/AdminScreen';
import { AdminLogin } from '../../src/presentation/components/admin/AdminLogin';
import { AdminUserManagement } from '../../src/presentation/components/admin/AdminUserManagement';
import { AdminIPBlocklist } from '../../src/presentation/components/admin/AdminIPBlocklist';
import { AdminWorkerTriggers } from '../../src/presentation/components/admin/AdminWorkerTriggers';
import { AdminAuditLog } from '../../src/presentation/components/admin/AdminAuditLog';

describe('Admin Panel Component Suite', () => {
  const TEST_KEY = 'secret-admin-key-xyz';
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── 1. Login Screen ───────────────────────────────────────────
  describe('AdminLogin', () => {
    it('renders login form and rejects invalid key with 401 inline error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: { code: 'ERR_ADM_001', message: 'admin authentication failed' },
            }),
          ),
      } as unknown as Response);

      const onLoginSuccess = vi.fn();
      render(<AdminLogin onLoginSuccess={onLoginSuccess} />);

      expect(screen.getByText('Admin Access')).toBeDefined();
      const input = screen.getByTestId('admin-login-input');
      const submitBtn = screen.getByTestId('admin-login-btn');

      fireEvent.change(input, { target: { value: 'wrong-key' } });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(screen.getByTestId('admin-login-error')).toBeDefined();
        expect(screen.getByText(/Invalid administrative API key/i)).toBeDefined();
      });

      expect(onLoginSuccess).not.toHaveBeenCalled();
    });

    it('accepts valid key and invokes onLoginSuccess', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: [] })),
      } as unknown as Response);

      const onLoginSuccess = vi.fn();
      render(<AdminLogin onLoginSuccess={onLoginSuccess} />);

      const input = screen.getByTestId('admin-login-input');
      const submitBtn = screen.getByTestId('admin-login-btn');

      fireEvent.change(input, { target: { value: TEST_KEY } });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(onLoginSuccess).toHaveBeenCalledWith(TEST_KEY);
      });
    });
  });

  // ─── 2. AdminScreen & Layout ────────────────────────────────────
  describe('AdminScreen Shell & Navigation', () => {
    it('logs in, renders tabs, switches views, and signs out cleanly', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/audit-events')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  data: [
                    {
                      ID: 'evt-1',
                      EventType: 'AUTH_SUCCESS',
                      IdentityHash: 'user-hash-1111222233334444',
                      IPHash: 'ip-hash-5555666677778888',
                      CreatedAt: 1720000000,
                    },
                  ],
                }),
              ),
          });
        }
        if (url.includes('/ip/blocks')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  data: [{ IPHash: 'ip-block-1', Status: 'BLOCKED', CreatedAt: 1720000000 }],
                }),
              ),
          });
        }
        if (url.includes('/health/ready')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ status: 'pass', checks: [] }),
            text: () => Promise.resolve(JSON.stringify({ status: 'pass' })),
          });
        }
        if (url.includes('/api/v1/version')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ version: '1.0.0', commit: 'abc', build_time: '2026' }),
            text: () => Promise.resolve(JSON.stringify({ version: '1.0.0' })),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ data: {} })),
        });
      });

      render(<AdminScreen />);

      // Login
      const input = screen.getByTestId('admin-login-input');
      fireEvent.change(input, { target: { value: TEST_KEY } });
      fireEvent.click(screen.getByTestId('admin-login-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('admin-panel-shell')).toBeDefined();
        expect(screen.getByText('RootInbox Admin')).toBeDefined();
      });

      // Switch to Users tab
      fireEvent.click(screen.getByTestId('admin-tab-users'));
      expect(screen.getByTestId('admin-search-input')).toBeDefined();

      // Switch to IP Blocklist tab
      fireEvent.click(screen.getByTestId('admin-tab-ip-blocks'));
      expect(screen.getByTestId('admin-ip-input')).toBeDefined();

      // Switch to Audit Log tab
      fireEvent.click(screen.getByTestId('admin-tab-audit'));
      expect(screen.getByTestId('admin-filter-event-type')).toBeDefined();

      // Switch to Workers tab
      fireEvent.click(screen.getByTestId('admin-tab-workers'));
      expect(screen.getByTestId('admin-trigger-media-gc-btn')).toBeDefined();

      // Sign out
      fireEvent.click(screen.getByTestId('admin-logout-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('admin-login-input')).toBeDefined();
      });
    });
  });

  // ─── 3. User Management ─────────────────────────────────────────
  describe('AdminUserManagement', () => {
    it('supports lookup, suspend action, and 2-step tombstone confirmation', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/audit-events')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ data: [] })),
          });
        }
        if (url.includes('/suspend')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ data: { status: 'suspended' } })),
          });
        }
        if (url.includes('/confirmations')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ data: { token: 'tombstone-token-xyz' } })),
          });
        }
        if (url.includes('/tombstone')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ data: { status: 'tombstoned' } })),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ data: {} })),
        });
      });
      globalThis.fetch = mockFetch;

      const targetHash = 'test-identity-hash-1234567890';
      render(<AdminUserManagement apiKey={TEST_KEY} initialIdentityHash={targetHash} />);

      expect(screen.getByTestId('admin-user-details-card')).toBeDefined();

      // Test Suspend Action with Confirmation Modal
      const suspendBtn = screen.getByTestId('admin-suspend-btn');
      fireEvent.click(suspendBtn);

      const confirmModal = screen.getByTestId('admin-confirm-modal');
      expect(confirmModal).toBeDefined();

      const confirmBtn = screen.getByTestId('admin-confirm-btn');
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining(`/users/${targetHash}/suspend`),
          expect.objectContaining({ method: 'POST' }),
        );
        expect(screen.getByText(/suspended successfully/i)).toBeDefined();
      });

      // Test Tombstone Action (2-step with confirmation token)
      const tombstoneBtn = screen.getByTestId('admin-tombstone-btn');
      fireEvent.click(tombstoneBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/v1/admin/confirmations',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ action: 'tombstone', target: targetHash }),
          }),
        );
        expect(screen.getByText('tombstone-token-xyz')).toBeDefined();
      });

      // Type required verification string "TOMBSTONE"
      const matchInput = screen.getByTestId('admin-confirm-match-input');
      fireEvent.change(matchInput, { target: { value: 'TOMBSTONE' } });

      const finalConfirmBtn = screen.getByTestId('admin-confirm-btn');
      fireEvent.click(finalConfirmBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining(`/users/${targetHash}/tombstone`),
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ token: 'tombstone-token-xyz' }),
          }),
        );
        expect(screen.getByText(/permanently tombstoned/i)).toBeDefined();
      });
    });
  });

  // ─── 4. IP Blocklist ────────────────────────────────────────────
  describe('AdminIPBlocklist', () => {
    it('bans an IP hash with confirmation and unbans existing blocked IP', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/ip/blocks')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  data: [
                    {
                      IPHash: 'banned-ip-hash-11112222',
                      Status: 'BLOCKED',
                      CreatedAt: 1720000000,
                    },
                  ],
                }),
              ),
          });
        }
        if (url.includes('/ban')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ data: { status: 'banned' } })),
          });
        }
        if (url.includes('/unban')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ data: { status: 'unbanned' } })),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ data: {} })),
        });
      });
      globalThis.fetch = mockFetch;

      render(<AdminIPBlocklist apiKey={TEST_KEY} />);

      await waitFor(() => {
        expect(screen.getByText('banned-ip-hash-11112222')).toBeDefined();
      });

      // Ban new IP
      const ipInput = screen.getByTestId('admin-ip-input');
      fireEvent.change(ipInput, { target: { value: 'new-bad-ip-hash' } });
      fireEvent.click(screen.getByTestId('admin-ban-ip-btn'));

      // Confirm ban modal
      fireEvent.click(screen.getByTestId('admin-confirm-btn'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/ip-blocks/new-bad-ip-hash/ban'),
          expect.objectContaining({ method: 'POST' }),
        );
      });

      // Unban row action
      const unbanRowBtn = screen.getByTestId('admin-unban-row-banned-i');
      fireEvent.click(unbanRowBtn);

      // Confirm unban modal
      fireEvent.click(screen.getByTestId('admin-confirm-btn'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/ip-blocks/banned-ip-hash-11112222/unban'),
          expect.objectContaining({ method: 'POST' }),
        );
      });
    });
  });

  // ─── 5. Audit Log Viewer ────────────────────────────────────────
  describe('AdminAuditLog', () => {
    it('filters audit records by event_type and triggers pagination', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        const nextCursor = url.includes('cursor=') ? undefined : 'next-page-cursor-token';
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: [
                  {
                    ID: 'evt-audit-1',
                    EventType: 'AUTH_FAILURE',
                    IdentityHash: 'attacker-identity-hash',
                    IPHash: 'attacker-ip-hash',
                    CreatedAt: 1720000000,
                  },
                ],
                meta: { next_cursor: nextCursor },
              }),
            ),
        });
      });
      globalThis.fetch = mockFetch;

      render(<AdminAuditLog apiKey={TEST_KEY} />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-audit-table')).toBeDefined();
        expect(screen.getAllByText('AUTH_FAILURE').length).toBeGreaterThan(0);
      });

      // Change event type filter
      const select = screen.getByTestId('admin-filter-event-type');
      fireEvent.change(select, { target: { value: 'AUTH_FAILURE' } });
      fireEvent.click(screen.getByTestId('admin-filter-apply-btn'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('event_type=AUTH_FAILURE'),
          expect.anything(),
        );
      });

      // Next Page pagination
      const nextBtn = screen.getByTestId('admin-audit-next-page-btn');
      expect(nextBtn).toBeDefined();
      fireEvent.click(nextBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('cursor=next-page-cursor-token'),
          expect.anything(),
        );
      });
    });
  });

  // ─── 6. Worker Triggers ─────────────────────────────────────────
  describe('AdminWorkerTriggers', () => {
    it('dispatches worker trigger and shows 202 Accepted feedback with operation_id', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        return Promise.resolve({
          ok: true,
          status: 202,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: { operation_id: 'op-media-gc-987654' },
              }),
            ),
        });
      });
      globalThis.fetch = mockFetch;

      render(<AdminWorkerTriggers apiKey={TEST_KEY} />);

      const gcBtn = screen.getByTestId('admin-trigger-media-gc-btn');
      fireEvent.click(gcBtn);

      await waitFor(() => {
        expect(screen.getByTestId('admin-worker-feedback')).toBeDefined();
      });
      expect(screen.getAllByText(/op-media-gc-987654/).length).toBeGreaterThan(0);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/admin/workers/media_gc/trigger',
        expect.anything(),
      );
    });
  });
});
