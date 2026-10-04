import { defineConfig, devices } from '@playwright/test'

const CI = !!process.env.CI
/** Set PLAYGROUND_PORT when 5175 is taken, for example by another checkout's preview server */
const PORT = Number(process.env.PLAYGROUND_PORT ?? 5175)

// Tests the static build, served by `vite preview` at the same base path as on GitHub Pages.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `pnpm build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/playground/`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { DOCS_BASE: '/' },
  },
})
