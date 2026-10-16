// "Your deposit address" with a standing bank account: the demo's mock adapter gives test standing
// addresses and bank accounts (options `standing` and `standingBank`, playground `?standing=1`). Axe in
// the light and the dark theme, copy buttons only where the provider allows them, and the copy result
// is announced through a status region.
import { expect, test, type Page } from '@playwright/test'
import { expectAccessible } from './a11y'

async function openDepositAddress(page: Page, theme: 'light' | 'dark') {
  await page.goto('/?standing=1')
  await page.locator('#country').selectOption('US')
  await page.locator('#destination').selectOption('base')
  await page.locator('#wallet').selectOption('none')
  await page.locator('#theme').selectOption(theme)
  const m = page.locator('openramp-modal')
  await m.getByRole('tab', { name: 'Use Crypto' }).click()
  await m.getByRole('button', { name: /^Your deposit address/ }).click()
  await expect(m.getByRole('tab', { name: 'Crypto' })).toHaveAttribute('aria-selected', 'true')
  await expect(m.getByRole('img', { name: 'Address' })).toBeVisible()
  return m
}

for (const theme of ['light', 'dark'] as const) {
  test(`standing bank account: ${theme} theme passes axe, a copy is announced`, async ({ page }) => {
    const m = await openDepositAddress(page, theme)
    await expectAccessible(page, `${theme}: standing deposit address`)

    await m.getByRole('tab', { name: 'Bank account' }).click()
    await expect(m.getByRole('tab', { name: 'Bank account' })).toHaveAttribute('aria-selected', 'true')
    await expect(m).toContainText('Routing number')
    await expect(m).toContainText('Send USD by bank transfer to this account.')
    // Copy buttons only where the adapter allows them
    await expect(m.getByRole('button', { name: /^Copy / })).toHaveCount(3)
    await expect(m.getByRole('button', { name: 'Copy Bank' })).toHaveCount(0)
    await expectAccessible(page, `${theme}: standing bank account`)

    await m.getByRole('button', { name: 'Copy Account number' }).click()
    await expect(m.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1)
    await expectAccessible(page, `${theme}: standing bank account after a copy`)

    // Another currency
    await m.getByRole('combobox', { name: 'Currency' }).selectOption('EUR')
    await expect(m).toContainText('IBAN')
    await expect(m).toContainText('Send EUR by bank transfer to this account.')

    // Back to crypto: the address and its QR code
    await m.getByRole('tab', { name: 'Crypto' }).click()
    await expect(m.getByRole('img', { name: 'Address' })).toBeVisible()
  })
}
