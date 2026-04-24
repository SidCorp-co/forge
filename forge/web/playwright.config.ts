import { defineConfig, devices as pwDevices } from '@playwright/test';

/**
 * Phase 2.6-F4: one-spec happy-path harness. Chromium only, single worker,
 * under-60s wall clock target. The webServer boots `next start` on the
 * prebuilt app; the core backend must already be running on the port
 * named in `NEXT_PUBLIC_API_URL`. In CI, a Next.js rewrite (see
 * next.config.ts once E2E lands) proxies `/api/*` to core so cookies stay
 * same-origin and SameSite=Lax works without adjustment.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...pwDevices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_SKIP_WEB_SERVER
    ? undefined
    : {
        command: 'npm run start',
        url: process.env.E2E_WEB_URL ?? 'http://localhost:3000',
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },
});
