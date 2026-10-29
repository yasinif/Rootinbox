import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { InstallModal } from '../../src/presentation/components/common/InstallModal';
import { AuthScreen } from '../../src/presentation/components/AuthScreen';
import { usePwaInstall, _resetPwaPromptForTesting } from '../../src/presentation/hooks/usePwaInstall';
import { AppContext } from '../../src/presentation/context';

describe('PWA Installability & Assets Conformance', () => {
  const publicDir = path.resolve(__dirname, '../../public');
  const distDir = path.resolve(__dirname, '../../dist');

  it('verifies manifest.webmanifest has all required fields for mobile & desktop installation', () => {
    const manifestPath = path.join(publicDir, 'manifest.webmanifest');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(content.name).toBe('RootInbox');
    expect(content.short_name).toBe('RootInbox');
    expect(content.start_url).toBe('/');
    expect(content.scope).toBe('/');
    expect(content.display).toBe('standalone');
    expect(content.orientation).toBe('any');
    expect(content.theme_color).toBe('#3390ec');
    expect(content.background_color).toBe('#0f172a');
    expect(Array.isArray(content.shortcuts)).toBe(true);
    expect(content.shortcuts.length).toBeGreaterThan(0);

    // Required icons for Android Chrome & Desktop installability
    expect(Array.isArray(content.icons)).toBe(true);
    expect(content.icons.length).toBeGreaterThanOrEqual(4);

    const icon192 = content.icons.find((i: any) => i.sizes === '192x192' && i.purpose === 'any');
    expect(icon192).toBeDefined();
    expect(icon192.type).toBe('image/png');

    const icon512 = content.icons.find((i: any) => i.sizes === '512x512' && i.purpose === 'any');
    expect(icon512).toBeDefined();
    expect(icon512.type).toBe('image/png');

    const maskable192 = content.icons.find((i: any) => i.sizes === '192x192' && i.purpose === 'maskable');
    expect(maskable192).toBeDefined();
    expect(maskable192.type).toBe('image/png');

    const maskable512 = content.icons.find((i: any) => i.sizes === '512x512' && i.purpose === 'maskable');
    expect(maskable512).toBeDefined();
    expect(maskable512.type).toBe('image/png');
  });

  it('verifies all icon files exist with valid signatures including favicon.ico', () => {
    const pngFiles = [
      'icon-192x192.png',
      'icon-512x512.png',
      'icon-maskable-192x192.png',
      'icon-maskable-512x512.png',
      'apple-touch-icon.png',
      'favicon.png',
    ];

    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    for (const name of pngFiles) {
      const filePath = path.join(publicDir, name);
      expect(fs.existsSync(filePath), `Icon ${name} must exist in public/`).toBe(true);
      const stat = fs.statSync(filePath);
      expect(stat.size).toBeGreaterThan(100);

      // Verify PNG magic header
      const buffer = fs.readFileSync(filePath);
      expect(buffer.subarray(0, 8).equals(pngSignature)).toBe(true);
    }

    // Verify favicon.ico exists with valid ICO header (0x00 0x00 0x01 0x00)
    const icoPath = path.join(publicDir, 'favicon.ico');
    expect(fs.existsSync(icoPath)).toBe(true);
    const icoBuffer = fs.readFileSync(icoPath);
    expect(icoBuffer.readUInt16LE(0)).toBe(0);
    expect(icoBuffer.readUInt16LE(2)).toBe(1); // ICO type = 1

    // Verify SVG icon exists
    const svgPath = path.join(publicDir, 'icon.svg');
    expect(fs.existsSync(svgPath)).toBe(true);
    const svgContent = fs.readFileSync(svgPath, 'utf8');
    expect(svgContent).toContain('<svg');
  });

  it('verifies built dist directory contains all PWA assets and sw precache', () => {
    expect(fs.existsSync(distDir)).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'manifest.webmanifest'))).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'icon-192x192.png'))).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'icon-512x512.png'))).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'sw.js'))).toBe(true);

    const swContent = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf8');
    expect(swContent).toContain('manifest.webmanifest');
    expect(swContent).toContain('icon-192x192.png');
    expect(swContent).toContain('icon-512x512.png');
  });
});

describe('InstallModal Component Tests', () => {
  beforeEach(() => {
    _resetPwaPromptForTesting(null);
  });

  it('renders modal with guidance for Android, Desktop, and iOS when open', () => {
    const onClose = vi.fn();
    render(<InstallModal isOpen={true} onClose={onClose} />);

    expect(screen.getAllByText('Install RootInbox').length).toBeGreaterThan(0);
    expect(screen.getByText(/On Android/i)).toBeDefined();
    expect(screen.getByText(/On Desktop/i)).toBeDefined();
    expect(screen.getByText(/On iOS/i)).toBeDefined();
  });

  it('calls onClose when Close button is clicked', () => {
    const onClose = vi.fn();
    render(<InstallModal isOpen={true} onClose={onClose} />);

    const closeBtn = screen.getByText('Close');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('renders Install Now button and triggers native prompt when hasNativePrompt is true', async () => {
    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeEvent = new Event('beforeinstallprompt') as any;
    fakeEvent.prompt = promptMock;
    fakeEvent.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });

    _resetPwaPromptForTesting(fakeEvent);

    const onClose = vi.fn();
    render(<InstallModal isOpen={true} onClose={onClose} />);

    const installBtn = screen.getByRole('button', { name: /Install Now/i });
    expect(installBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(installBtn);
    });

    expect(promptMock).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('usePwaInstall Hook Tests', () => {
  beforeEach(() => {
    _resetPwaPromptForTesting(null);
  });

  it('captures beforeinstallprompt dispatched BEFORE hook renders (pre-mount event)', () => {
    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeEvent = new Event('beforeinstallprompt') as any;
    fakeEvent.prompt = promptMock;
    fakeEvent.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });

    // Dispatch synthetic event to window BEFORE hook renders
    window.dispatchEvent(fakeEvent);

    // Render hook AFTER event has already occurred
    const { result } = renderHook(() => usePwaInstall());

    expect(result.current.hasNativePrompt).toBe(true);
    expect(result.current.isInstallable).toBe(true);
  });

  it('synchronizes prompt state across multiple hook instances', async () => {
    const hook1 = renderHook(() => usePwaInstall());
    const hook2 = renderHook(() => usePwaInstall());

    expect(hook1.result.current.hasNativePrompt).toBe(false);
    expect(hook2.result.current.hasNativePrompt).toBe(false);

    const promptMock = vi.fn().mockResolvedValue(undefined);
    const fakeEvent = new Event('beforeinstallprompt') as any;
    fakeEvent.prompt = promptMock;
    fakeEvent.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });

    act(() => {
      window.dispatchEvent(fakeEvent);
    });

    expect(hook1.result.current.hasNativePrompt).toBe(true);
    expect(hook2.result.current.hasNativePrompt).toBe(true);

    // Prompt from hook1 succeeds
    await act(async () => {
      const success = await hook1.result.current.promptInstall();
      expect(success).toBe(true);
    });

    // Both hooks reflect installed state
    expect(hook1.result.current.isInstalled).toBe(true);
    expect(hook2.result.current.isInstalled).toBe(true);
    expect(hook1.result.current.hasNativePrompt).toBe(false);
    expect(hook2.result.current.hasNativePrompt).toBe(false);
  });
});

describe('AuthScreen Install Trigger', () => {
  beforeEach(() => {
    _resetPwaPromptForTesting(null);
  });

  it('renders Install RootInbox App button on AuthScreen when not installed', () => {
    const authSnapshot = {
      state: 'idle',
      identityHash: null,
      userId: null,
      username: null,
      displayName: null,
      error: null,
    };
    const mockAuthUC = {
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => authSnapshot),
      register: vi.fn(),
      login: vi.fn(),
      unlock: vi.fn(),
      logout: vi.fn(),
    };

    render(
      <AppContext.Provider value={{ authUC: mockAuthUC } as any}>
        <MemoryRouter>
          <AuthScreen />
        </MemoryRouter>
      </AppContext.Provider>,
    );

    const installBtn = screen.getByRole('button', { name: /Install RootInbox App/i });
    expect(installBtn).toBeDefined();
  });
});

