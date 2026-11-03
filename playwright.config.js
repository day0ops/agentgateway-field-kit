import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e/wizard',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.WIZARD_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
