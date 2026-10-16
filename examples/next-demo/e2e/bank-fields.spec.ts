// Bank fields (BANK_FIELDS surface): bank details with copy buttons. The demo's mock adapter shows bank
// transfer deposits this way (option `bankFields`). Axe in the light and the dark theme, and the copy
// result is announced through a status region.
import { expect, test, type Page } from '@playwright/test'
import { expectAccessible } from './a11y'

async function openBankFields(page: Page, theme: 'light' | 'dark') {
  await page.goto('/')
  await page.locator('#country').selectOption('TH')
  await page.locator('#destination').selectOption('base')
  await page.locator('#wallet').selectOption('none')
  await page.locator('#theme').selectOption(theme)
  const m = page.locator('openramp-modal')
  await m.getByRole('tab', { name: 'Use Cash' }).click()
  await m.getByRole('button', { name: /^Bank transfer/ }).click()
  await m.getByRole('textbox', { name: 'Amount' }).fill('1000')
  await m.getByRole('button', { name: 'Continue' }).click()
  await expect(m).toContainText('Best price')
  await m.getByRole('button', { name: 'Confirm' }).click()
  await expect(m).toContainText('Account number')
  return m
}

for (const theme of ['light', 'dark'] as const) {
  test(`bank fields: ${theme} theme passes axe, a copy is announced`, async ({ page }) => {
    const m = await openBankFields(page, theme)
    await expect(m).toContainText('000123456789')
    await expect(m).toContainText('1000 THB')
    // Copy buttons only where the adapter allows them
    await expect(m.getByRole('button', { name: /^Copy / })).toHaveCount(3)
    await expect(m.getByRole('button', { name: 'Copy Bank' })).toHaveCount(0)
    await expectAccessible(page, `${theme}: bank fields`)

    await m.getByRole('button', { name: 'Copy Account number' }).click()
    // The copy result is announced through a status region
    await expect(m.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1)
    await expectAccessible(page, `${theme}: bank fields after a copy`)

    // The test payment still completes the deposit
    await m.getByRole('button', { name: /Simulate payment/ }).click()
    await expect(m).toContainText('Deposit complete', { timeout: 30_000 })
  })
}
