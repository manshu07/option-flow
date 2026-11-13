import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const root = process.cwd();
const recordedDir = path.join(root, 'data', 'recorded');
const safeEnv = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI', 'SYSTEMROOT', 'SystemRoot', 'WINDIR']);
const inheritedEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => safeEnv.has(key) && value != null),
) as Record<string, string>;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5195',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-edge', use: { ...devices['Desktop Chrome'], channel: 'msedge' } },
    { name: 'phone-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node tests/e2e/start.mjs',
    url: 'http://127.0.0.1:5195',
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...inheritedEnv,
      // Deliberately construct the server environment without inherited Dhan credentials.
      MF_PROVIDER: 'recorded',
      MF_RECORDED_DIR: recordedDir,
      MF_RECORDED_DATE: '2026-10-30',
      HOST: '127.0.0.1',
      PORT: '8787',
    },
  },
});
