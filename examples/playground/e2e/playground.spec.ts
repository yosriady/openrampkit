// Smoke test of the static playground: the server runs in the page, so no backend is needed.
// Playwright locators pierce the web component's Shadow DOM.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

function trackErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

test('Vietnam: VietQR compares mock providers, then the deposit completes with a signed webhook', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('/playground/')
  await expect(page.getByTestId('demo-banner')).toContainText('Demo mode: mock providers, no real money')
  const modal = page.locator('openramp-modal')
  await expect(modal).toContainText(/Most popular|Connected|Other options/)

  await modal.getByRole('tab', { name: 'Use Cash' }).click()
  await modal.getByRole('button', { name: /VietQR/ }).click()
  await modal.getByRole('textbox', { name: 'Amount' }).fill('500000')
  await modal.getByRole('button', { name: 'Continue' }).click()

  // Several providers quote the same route. The best one is first.
  const quotes = modal.getByRole('radiogroup', { name: 'Quotes' }).getByRole('radio')
  await expect(quotes.nth(1)).toBeVisible()
  expect(await quotes.count()).toBeGreaterThanOrEqual(2)
  await expect(quotes.first()).toContainText('Best price')
  await expect(modal.getByRole('radiogroup', { name: 'Quotes' })).toContainText('Mock Local Rails')
  await expect(modal.getByRole('radiogroup', { name: 'Quotes' })).toContainText('Mock Onramp A')

  await modal.getByRole('button', { name: 'Confirm' }).click()
  await expect(modal).toContainText('Scan with your banking or e-wallet app')
  await modal.getByRole('button', { name: /Simulate payment/ }).click()
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })

  await expect(page.getByTestId('events')).toContainText('COMPLETED')
  await expect(page.getByTestId('webhooks')).toContainText('session.completed')
  await expect(page.getByTestId('webhooks')).toContainText('signature ok')
  expect(errors).toEqual([])
})

test('United States: card with test card fields in the widget, quotes from several providers', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('/playground/?country=US')
  const modal = page.locator('openramp-modal')
  await modal.getByRole('tab', { name: 'Use Cash' }).click()
  await expect(modal.getByRole('button', { name: /Apple Pay/ })).toBeVisible()
  await modal.getByRole('button', { name: /^Card/ }).click()
  await modal.getByRole('textbox', { name: 'Amount' }).fill('100')
  await modal.getByRole('button', { name: 'Continue' }).click()
  const quotes = modal.getByRole('radiogroup', { name: 'Quotes' }).getByRole('radio')
  await expect(quotes.nth(1)).toBeVisible()
  expect(await quotes.count()).toBeGreaterThanOrEqual(2)
  await modal.getByRole('button', { name: 'Confirm' }).click()

  await modal.getByRole('textbox', { name: /Card number/ }).fill('4242 4242 4242 4242')
  await modal.getByRole('textbox', { name: /Expiry/ }).fill('12/30')
  await modal.getByRole('textbox', { name: 'CVC' }).fill('123')
  await modal.getByRole('button', { name: 'Pay (test mode)' }).click()
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
  expect(errors).toEqual([])
})

test('From an exchange: deposit address with network and token, then simulate the deposit', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('/playground/?country=ID')
  const modal = page.locator('openramp-modal')
  await modal.getByRole('tab', { name: 'Use Crypto' }).click()
  await modal.getByRole('button', { name: /From an exchange/ }).click()
  await expect(modal.getByRole('combobox', { name: 'Network' })).toBeVisible()
  await expect(modal.getByRole('radiogroup', { name: 'Quotes' }).getByRole('radio').first()).toBeVisible()
  await modal.getByRole('button', { name: 'Continue' }).click()
  await expect(modal).toContainText('Send from Binance, Coinbase, OKX or any exchange.')
  await expect(modal).toContainText(/Send USDC on \w+ to this address/)
  await expect(modal).toContainText('In your exchange, withdraw USDC')
  await modal.getByRole('button', { name: /Simulate deposit/ }).click()
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
  expect(errors).toEqual([])
})

test('Controls: withdraw, dark theme and modal display', async ({ page }) => {
  await page.goto('/playground/?direction=withdraw&theme=dark&display=modal&country=TH&locale=th')
  await expect(page.locator('#direction')).toHaveValue('withdraw')
  await expect(page.locator('#code')).toContainText("direction: 'withdraw'")
  await expect(page.locator('#code')).toContainText('darkTheme')
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click()
  const modal = page.locator('openramp-modal')
  await expect(modal.getByRole('dialog')).toBeVisible()
  await expect(modal.getByRole('textbox').first()).toBeVisible()
})

test('Controls: payment sources, corners and font update the widget and the code', async ({ page }) => {
  await page.goto('/playground/?country=US')
  const modal = page.locator('openramp-modal')
  await expect(modal.getByRole('tab', { name: 'Use Cash' })).toBeVisible()

  // Card off: the session allows only the other methods.
  await page.getByRole('checkbox', { name: /^Card/ }).uncheck()
  await expect(page).toHaveURL(/sources=wallet%2Ctransfer%2Cexchange%2Ccash/)
  await expect(page.locator('#code')).toContainText('allowedMethods:')
  await expect(page.locator('#code')).not.toContainText("'card'")

  // Only crypto sources: no cash tab.
  await page.getByRole('checkbox', { name: /^Local cash/ }).uncheck()
  await expect(modal.getByRole('button', { name: /From an exchange/ })).toBeVisible()
  await expect(modal.getByRole('tab', { name: 'Use Cash' })).toHaveCount(0)

  await page.locator('#radius').selectOption('none')
  await page.locator('#font').selectOption('serif')
  await page.locator('#theme').selectOption('auto')
  await expect(page.locator('#code')).toContainText("autoTheme({ accent: '#2744c4', radius: 'none', fontFamily:")
  await page.reload()
  await expect(page.locator('#radius')).toHaveValue('none')
  await expect(page.getByRole('checkbox', { name: /^Card/ })).not.toBeChecked()
})

test('Selects: no native arrow, one chevron centred 12px from the right', async ({ page }) => {
  await page.goto('/playground/')
  for (const id of ['direction', 'country', 'locale', 'display', 'theme', 'radius', 'font']) {
    const s = await page.locator(`#${id}`).evaluate((el) => {
      const cs = getComputedStyle(el)
      return { appearance: cs.appearance, x: cs.backgroundPositionX, y: cs.backgroundPositionY, image: cs.backgroundImage, height: el.getBoundingClientRect().height }
    })
    expect(s.appearance, id).toBe('none')
    expect(s.image, id).toContain('svg')
    expect(s.x, id).toMatch(/right 12px|calc\(100% - 12px\)/)
    expect(s.y, id).toMatch(/center|50%/)
    expect(s.height, id).toBeGreaterThanOrEqual(36)
  }
})
