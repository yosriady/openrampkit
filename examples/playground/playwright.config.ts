import { defineConfig, devices } from '@playwright/test'

const CI = !!process.env.CI

// Tests the static build, served by `vite preview` at the same base path as on GitHub Pages.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: 'http://localhost:5175', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:5175/playground/',
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { DOCS_BASE: '/' },
  },
})
