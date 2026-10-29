import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUserPort } from '../../src/infrastructure/adapters';

describe('UserPort - Avatar methods', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('getAvatarUrl formats URL correctly with and without timestamp', () => {
    const port = createUserPort();

    expect(port.getAvatarUrl('usr-123')).toBe('/api/v1/users/usr-123/avatar');
    expect(port.getAvatarUrl('usr-123', 1700000000)).toBe('/api/v1/users/usr-123/avatar?t=1700000000');
  });

  it('uploadAvatar sends blob via POST /api/v1/users/me/avatar', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        data: {
          avatar_url: '/api/v1/users/u1/avatar',
          avatar_updated_at: 1700000500,
        },
      }),
    });
    globalThis.fetch = mockFetch;

    const port = createUserPort();
    const blob = new Blob(['fake image data'], { type: 'image/png' });
    const res = await port.uploadAvatar(blob);

    expect(res.avatar_url).toBe('/api/v1/users/u1/avatar');
    expect(res.avatar_updated_at).toBe(1700000500);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/users/me/avatar',
      expect.objectContaining({
        method: 'POST',
        body: blob,
        headers: expect.objectContaining({
          'Content-Type': 'image/png',
        }),
      }),
    );
  });

  it('deleteAvatar sends DELETE /api/v1/users/me/avatar', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        data: { deleted: true },
      }),
    });
    globalThis.fetch = mockFetch;

    const port = createUserPort();
    await port.deleteAvatar();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/users/me/avatar',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });
});
