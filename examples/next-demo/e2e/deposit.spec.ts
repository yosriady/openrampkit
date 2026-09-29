// Browser tests against the running example, with mock providers and the mock wallet.
// Playwright locators pierce the web component's Shadow DOM.
import { expect, test, type Page } from '@playwright/test'

async function setup(page: Page, opts: { country: string; destination: string; wallet?: 'none' | 'mock' }) {
  await page.goto('/')
  await page.locator('#country').selectOption(opts.country)
  await page.locator('#destination').selectOption(opts.destination)
  await page.locator('#wallet').selectOption(opts.wallet ?? 'mock')
  // Embedded widget restarts with a new session on each change; wait for the methods screen.
  await expect(page.locator('openramp-modal')).toContainText(/Most popular|Connected|Other options/)
}

async function waitForWebhook(page: Page, type: string) {
  await expect(page.getByTestId('webhooks')).toContainText(type, { timeout: 30_000 })
}

test('Vietnam: VietQR to a token on Monad (onramp, then bridge hop)', async ({ page }) => {
  await setup(page, { country: 'VN', destination: 'monad' })
  await page.getByRole('tab', { name: 'Use Cash' }).click()
  const methods = page.locator('openramp-modal')
  await expect(methods).toContainText('Most popular')
  await expect(methods).toContainText('VietQR')
  await expect(methods).not.toContainText('GCash')
  await methods.getByRole('button', { name: /VietQR/ }).click()
  await page.locator('openramp-modal').getByRole('textbox', { name: 'Amount' }).fill('500000')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(methods).toContainText('Best price')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(methods).toContainText('Scan with your banking or e-wallet app')
  await page.screenshot({ path: 'e2e/screens/vietqr-qr.png' })
  await page.getByRole('button', { name: /Simulate payment/ }).click()
  await expect(methods).toContainText('Deposit complete', { timeout: 30_000 })
  await page.screenshot({ path: 'e2e/screens/vietqr-done.png' })
  await waitForWebhook(page, 'session.completed')
})

test('Singapore: card via popup-safe redirect to the hosted checkout', async ({ page, context }) => {
  await setup(page, { country: 'SG', destination: 'base' })
  await page.getByRole('tab', { name: 'Use Cash' }).click()
  const modal = page.locator('openramp-modal')
  await modal.getByRole('button', { name: /^Card/ }).click()
  await page.locator('openramp-modal').getByRole('textbox', { name: 'Amount' }).fill('100')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  const popupPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /Continue to/ }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  await expect(popup.getByText('Test mode')).toBeVisible()
  await popup.screenshot({ path: 'e2e/screens/card-checkout.png' })
  // The host page must not navigate away.
  expect(page.url()).toBe('http://localhost:3000/')
  await popup.getByRole('button', { name: /^Pay / }).click()
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
  await waitForWebhook(page, 'session.completed')
})

test('Mock wallet: pay from a connected wallet', async ({ page }) => {
  await setup(page, { country: 'US', destination: 'base', wallet: 'mock' })
  const modal = page.locator('openramp-modal')
  await page.getByRole('tab', { name: 'Use Crypto' }).click()
  await expect(modal).toContainText('Connected')
  await modal.getByRole('button', { name: /Pay with wallet/ }).click()
  await page.locator('openramp-modal').getByRole('textbox', { name: 'Amount' }).fill('25')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByRole('button', { name: 'Confirm in wallet' }).click()
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
  await page.screenshot({ path: 'e2e/screens/wallet-done.png' })
})

test('Indonesia: merchant fiat account, QRIS pay-in (no crypto)', async ({ page }) => {
  await setup(page, { country: 'ID', destination: 'merchant', wallet: 'none' })
  const modal = page.locator('openramp-modal')
  await expect(modal).toContainText('QRIS')
  await expect(page.getByRole('tab', { name: 'Use Crypto' })).toHaveCount(0)
  await modal.getByRole('button', { name: /QRIS/ }).click()
  await page.locator('openramp-modal').getByRole('textbox', { name: 'Amount' }).fill('150000')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByRole('button', { name: /Simulate payment/ }).click()
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
})

test('Transfer crypto: shows a deposit address with a QR code', async ({ page }) => {
  await setup(page, { country: 'DE', destination: 'base', wallet: 'none' })
  const modal = page.locator('openramp-modal')
  await page.getByRole('tab', { name: 'Use Crypto' }).click()
  await modal.getByRole('button', { name: /Transfer crypto/ }).click()
  await expect(modal).toContainText('Send from')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(modal).toContainText('Send USDC on')
  await page.screenshot({ path: 'e2e/screens/transfer.png' })
})
