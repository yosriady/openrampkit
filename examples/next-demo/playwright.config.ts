import { defineConfig, devices } from '@playwright/test'

const CI = !!process.env.CI
// PORT lets several checkouts run the suite at the same time. Default: 3000.
const PORT = Number(process.env.PORT ?? 3000)

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    // Phones: Android Chrome and iPhone Safari (WebKit). Screenshot capture runs on desktop only.
    { name: 'mobile-android', use: { ...devices['Pixel 7'] }, testIgnore: /screens\.spec/ },
    { name: 'mobile-iphone', use: { ...devices['iPhone 14'] }, testIgnore: /screens\.spec/ },
  ],
  webServer: {
    command: CI ? `pnpm build && pnpm exec next start -p ${PORT}` : `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    // Webhooks and hosted checkout links point back at this server
    env: { PUBLIC_URL: process.env.PUBLIC_URL ?? `http://localhost:${PORT}` },
    reuseExistingServer: !CI,
    timeout: 240_000,
  },
})
