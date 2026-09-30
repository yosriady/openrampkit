// Smoke test of the static playground: the server runs in the page, so no backend is needed.
// Playwright locators pierce the web component's Shadow DOM.
import { expect, test } from '@playwright/test'

test('Vietnam: mock VietQR deposit completes, with a signed webhook', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/playground/')
  await expect(page.getByTestId('demo-banner')).toContainText('Demo mode: mock providers, no real money')
  const modal = page.locator('openramp-modal')
  await expect(modal).toContainText(/Most popular|Connected|Other options/)

  await modal.getByRole('tab', { name: 'Use Cash' }).click()
  await modal.getByRole('button', { name: /VietQR/ }).click()
  await modal.getByRole('textbox', { name: 'Amount' }).fill('500000')
  await modal.getByRole('button', { name: 'Continue' }).click()
  await modal.getByRole('button', { name: 'Confirm' }).click()
  await expect(modal).toContainText('Scan with your banking or e-wallet app')
  await modal.getByRole('button', { name: /Simulate payment/ }).click()
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })

  await expect(page.getByTestId('events')).toContainText('COMPLETED')
  await expect(page.getByTestId('webhooks')).toContainText('session.completed')
  await expect(page.getByTestId('webhooks')).toContainText('signature ok')
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
