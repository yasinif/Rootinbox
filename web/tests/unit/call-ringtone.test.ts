import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCallRingtone } from '../../src/presentation/hooks/useCallRingtone';

describe('useCallRingtone hook', () => {
  let mockVibrate: ReturnType<typeof vi.fn>;
  let mockResume: ReturnType<typeof vi.fn>;
  let mockSuspend: ReturnType<typeof vi.fn>;
  let mockCreateOscillator: ReturnType<typeof vi.fn>;
  let mockCreateGain: ReturnType<typeof vi.fn>;
  let originalAudioContext: typeof window.AudioContext;

  beforeEach(() => {
    mockVibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', {
      value: mockVibrate,
      writable: true,
      configurable: true,
    });

    mockResume = vi.fn().mockResolvedValue(undefined);
    mockSuspend = vi.fn().mockResolvedValue(undefined);

    const mockOscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
      onended: null,
    };
    const mockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    mockCreateOscillator = vi.fn().mockReturnValue(mockOscillator);
    mockCreateGain = vi.fn().mockReturnValue(mockGain);

    originalAudioContext = window.AudioContext;
    function MockAudioContext(this: any) {
      this.state = 'running';
      this.currentTime = 10;
      this.destination = {};
      this.resume = mockResume;
      this.suspend = mockSuspend;
      this.createOscillator = mockCreateOscillator;
      this.createGain = mockCreateGain;
    }
    (window as any).AudioContext = vi.fn().mockImplementation(function (this: any) {
      return new (MockAudioContext as any)();
    });
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
    vi.restoreAllMocks();
  });

  it('triggers ringtone and vibration when enabled is true', () => {
    const { unmount } = renderHook(({ enabled }) => useCallRingtone(enabled), {
      initialProps: { enabled: true },
    });

    expect(mockVibrate).toHaveBeenCalledWith([400, 200, 400, 2000]);
    expect(window.AudioContext).toHaveBeenCalled();
    expect(mockCreateOscillator).toHaveBeenCalled();
    expect(mockCreateGain).toHaveBeenCalled();

    unmount();
    expect(mockVibrate).toHaveBeenCalledWith(0);
  });

  it('stops ringtone and cancels vibration when enabled transitions to false', () => {
    const { rerender } = renderHook(({ enabled }) => useCallRingtone(enabled), {
      initialProps: { enabled: true },
    });

    expect(mockVibrate).toHaveBeenCalledWith([400, 200, 400, 2000]);

    rerender({ enabled: false });

    expect(mockVibrate).toHaveBeenCalledWith(0);
    expect(mockSuspend).toHaveBeenCalled();
  });

  it('handles suspended AudioContext by resuming it', () => {
    function MockSuspendedAudioContext(this: any) {
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = {};
      this.resume = mockResume;
      this.suspend = mockSuspend;
      this.createOscillator = mockCreateOscillator;
      this.createGain = mockCreateGain;
    }
    (window as any).AudioContext = vi.fn().mockImplementation(function (this: any) {
      return new (MockSuspendedAudioContext as any)();
    });

    renderHook(() => useCallRingtone(true));

    expect(mockResume).toHaveBeenCalled();
  });
});
