import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Share the developer's .env. Variables already set (as in CI) take priority.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Needs a migrated database and a prior `npm run build`.
  webServer: [
    {
      command: 'npm run start -w @pulseboard/api',
      url: 'http://127.0.0.1:4000/api/ready',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run start -w @pulseboard/web',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
