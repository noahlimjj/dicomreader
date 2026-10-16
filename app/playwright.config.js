import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 120000,
  expect: {timeout: 20000},
  fullyParallel: false,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', {open: 'never', outputFolder: 'test-results/report'}]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
  projects: [
    {name: 'iphone-webkit', use: {...devices['iPhone 15']}},
    {name: 'android-chromium', use: {...devices['Pixel 7']}},
    {name: 'desktop-chromium', use: {...devices['Desktop Chrome'], viewport: {width: 1440, height: 900}}},
  ],
});
