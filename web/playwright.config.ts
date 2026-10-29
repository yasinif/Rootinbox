import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: {
          args: [
            ...(process.env.SPKI_PIN ? [`--ignore-certificate-errors-spki-list=${process.env.SPKI_PIN}`] : []),
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
    },
    {
      name: 'pixel-7',
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          args: [
            ...(process.env.SPKI_PIN ? [`--ignore-certificate-errors-spki-list=${process.env.SPKI_PIN}`] : []),
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
    {
      name: 'iphone-14',
      use: {
        ...devices['iPhone 14'],
        browserName: 'webkit',
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'go run ../cmd/rootinbox',
    url: 'http://127.0.0.1:8080/health/ready',
    reuseExistingServer: true,
    env: {
      PORT: '8080',
      SERVER_HOST: '127.0.0.1',
      APP_ORIGIN: 'http://127.0.0.1:8080',
      INSECURE_DEV_MODE: 'true',
      IP_HASH_SECRET: '12345678901234567890123456789012',
      DB_PATH: '../scratch/e2e-playwright.db',
      MEDIA_PATH: '../scratch/e2e-playwright-media',
      LOG_LEVEL: 'warn',
      PUSH_ENABLED: 'true',
      PUSH_VAPID_ENCRYPTION_KEY: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
      PUSH_VAPID_SUBJECT: 'mailto:test@example.com',
      TURN_ENABLED: 'true',
      TURN_ACTIVE_SECRET: 'turn_active_secret_32_bytes_long_123',
      TURN_RELAY_IP: '127.0.0.1',
      TURN_MIN_PORT: '50000',
      TURN_MAX_PORT: '50100',
    },
    timeout: 30000,
  },
});
