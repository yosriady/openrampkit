// Captures screenshots of the key flows for docs. Run: npx playwright test e2e/screens.spec.ts
import { expect, test, type Page } from '@playwright/test'

const out = (name: string) => `e2e/screens/${name}.png`

async function setup(page: Page, o: { country: string; destination: string; wallet?: string; theme?: string }) {
  await page.goto('/')
  await page.locator('#country').selectOption(o.country)
  await page.locator('#destination').selectOption(o.destination)
  await page.locator('#wallet').selectOption(o.wallet ?? 'none')
  if (o.theme) await page.locator('#theme').selectOption(o.theme)
  await expect(page.locator('openramp-modal')).toContainText(/Most popular|Connected|Other options/)
  return page.locator('openramp-modal')
}

const amount = (page: Page) => page.locator('openramp-modal').getByRole('textbox', { name: 'Amount' })

test('flow: Vietnam VietQR to Monad', async ({ page }) => {
  const m = await setup(page, { country: 'VN', destination: 'monad' })
  await page.getByRole('tab', { name: 'Use Cash' }).click()
  await m.screenshot({ path: out('01-vn-cash-methods') })
  await m.getByRole('button', { name: /VietQR/ }).click()
  await amount(page).fill('500000')
  await m.screenshot({ path: out('02-vn-amount') })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(m).toContainText('Best price')
  await m.screenshot({ path: out('03-vn-quote') })
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(m).toContainText('Scan with your banking or e-wallet app')
  await m.screenshot({ path: out('04-vn-qr') })
  await page.getByRole('button', { name: /Simulate payment/ }).click()
  await expect(m).toContainText('Processing')
  await m.screenshot({ path: out('05-vn-processing') })
  await expect(m).toContainText('Deposit complete', { timeout: 30_000 })
  await m.screenshot({ path: out('06-vn-complete') })
  await expect(page.getByTestId('webhooks')).toContainText('session.succeeded', { timeout: 30_000 })
  await page.screenshot({ path: out('00-playground') })
})

test('flow: crypto tab, wallet pay with mock wallet', async ({ page }) => {
  const m = await setup(page, { country: 'US', destination: 'base', wallet: 'mock' })
  await page.getByRole('tab', { name: 'Use Crypto' }).click()
  await m.screenshot({ path: out('10-crypto-methods') })
  await m.getByRole('button', { name: /Pay with wallet/ }).click()
  await amount(page).fill('25')
  await m.screenshot({ path: out('11-wallet-amount') })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('button', { name: 'Confirm in wallet' })).toBeVisible()
  await m.screenshot({ path: out('12-wallet-confirm') })
})

test('flow: transfer crypto, deposit address', async ({ page }) => {
  const m = await setup(page, { country: 'DE', destination: 'base' })
  await page.getByRole('tab', { name: 'Use Crypto' }).click()
  await m.getByRole('button', { name: /Transfer crypto/ }).click()
  await expect(m).toContainText('Send from')
  await m.screenshot({ path: out('20-transfer-pick') })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(m).toContainText('Send USDC on')
  await m.screenshot({ path: out('21-transfer-address') })
})

test('flow: card redirect and hosted checkout', async ({ page, context }) => {
  const m = await setup(page, { country: 'SG', destination: 'base' })
  await page.getByRole('tab', { name: 'Use Cash' }).click()
  await m.getByRole('button', { name: /^Card/ }).click()
  await amount(page).fill('100')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('button', { name: /Continue to/ })).toBeVisible()
  await m.screenshot({ path: out('30-card-redirect') })
  const popupP = context.waitForEvent('page')
  await page.getByRole('button', { name: /Continue to/ }).click()
  const popup = await popupP
  await popup.waitForLoadState()
  await popup.screenshot({ path: out('31-card-checkout') })
})

test('flow: Indonesia merchant QRIS, dark theme', async ({ page }) => {
  const m = await setup(page, { country: 'ID', destination: 'merchant', theme: 'dark' })
  await m.screenshot({ path: out('40-merchant-methods-dark') })
  await m.getByRole('button', { name: /QRIS/ }).click()
  await amount(page).fill('150000')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(m).toContainText('Scan with your banking or e-wallet app')
  await m.screenshot({ path: out('41-merchant-qr-dark') })
})

test('flow: phone width, modal as bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/')
  await page.locator('#country').selectOption('PH')
  await page.locator('#embedded').uncheck()
  await page.getByRole('button', { name: 'Deposit' }).click()
  await expect(page.locator('openramp-modal')).toContainText(/Most popular|Other options/)
  await page.getByRole('tab', { name: 'Use Cash' }).click()
  await page.waitForTimeout(300) // let the tab highlight transition finish
  await page.screenshot({ path: out('50-mobile-sheet') })
})
