// End-to-end tests in a real Grafana (docker compose up -d in datasource/): npm run e2e
import { defineConfig } from '@playwright/test';

import config from './.config/playwright.config';

export default defineConfig({
  ...config,
  testDir: './tests/e2e',
  reporter: process.env.CI ? 'github' : 'list',
  // every page loads the whole Grafana frontend; more parallel browsers only slow each other down
  workers: 2,
  timeout: 60_000,
  // panels fill only after every query of the dashboard returned
  expect: { timeout: 20_000 },
});
