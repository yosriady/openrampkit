// Keyboard only: a full mock deposit with Tab, Shift+Tab, Enter, Space and Escape. No mouse, no typing.
import { expect, test, type Page } from '@playwright/test'

/** Name of the focused element, looking through open Shadow DOM roots, and whether it shows a focus ring. */
async function focused(page: Page) {
  return page.evaluate(() => {
    let a: Element | null = document.activeElement
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
    if (!a) return { name: '', ring: false }
    const name = (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim()
    const style = getComputedStyle(a)
    return { name, ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 }
  })
}

/** Press Tab (or Shift+Tab) until the focused element's name matches. Fails when it never does. */
async function tabTo(page: Page, name: RegExp, key: 'Tab' | 'Shift+Tab' = 'Tab', max = 30) {
  const seen: string[] = []
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key)
    const f = await focused(page)
    seen.push(f.name)
    if (name.test(f.name)) {
      expect(f.ring, `visible focus ring on "${f.name}"`).toBe(true)
      return
    }
  }
  throw new Error(`${key} never reached ${name}. Focus went: ${seen.join(' | ')}`)
}

async function openModal(page: Page) {
  const deposit = page.getByRole('button', { name: 'Deposit', exact: true })
  await deposit.focus()
  await page.keyboard.press('Enter')
  const dialog = page.locator('openramp-modal').getByRole('dialog')
  await expect(dialog).toBeVisible()
  // Focus starts on the dialog title
  await expect.poll(async () => (await focused(page)).name).toBe('Deposit')
  return { deposit, dialog }
}

test.beforeEach(async ({ page }) => {
  // Setup of the playground itself (not the widget)
  await page.goto('/')
  await page.locator('#country').selectOption('ID')
  await page.locator('#destination').selectOption('merchant')
  await page.locator('#wallet').selectOption('none')
  await page.locator('#embedded').uncheck()
})

test('keyboard only: QRIS deposit from the method list to Done, focus returns to the opener', async ({ page }) => {
  const { deposit, dialog } = await openModal(page)
  const modal = page.locator('openramp-modal')
  await expect(modal).toContainText('QRIS')

  // Method list
  await tabTo(page, /^QRIS/)
  await page.keyboard.press('Enter')

  // Amount: pick a preset with Space, then Continue
  await expect(modal.getByRole('textbox', { name: /Amount/ })).toBeVisible()
  await tabTo(page, /^(IDR|Rp) ?100/)
  await page.keyboard.press('Space')
  await expect(modal.getByRole('textbox', { name: /Amount/ })).not.toHaveValue('')
  await tabTo(page, /^Continue$/)
  await page.keyboard.press('Enter')

  // Quotes: Shift+Tab from the title wraps to the last control, Confirm
  await expect(modal).toContainText('Best price')
  await tabTo(page, /^Confirm$/, 'Shift+Tab')
  await page.keyboard.press('Enter')

  // QR payment
  await expect(modal).toContainText('Scan with your banking or e-wallet app')
  await tabTo(page, /Simulate payment/)
  await page.keyboard.press('Enter')

  // Success
  await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
  await tabTo(page, /^Done$/)
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(deposit).toBeFocused()
})

test('keyboard only: Tab stays inside the dialog, Escape closes it and focus returns', async ({ page }) => {
  const { deposit, dialog } = await openModal(page)
  // Tab through more controls than the dialog has: focus must never reach the page behind it
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab')
    const inside = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() === 'openramp-modal')
    expect(inside).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(deposit).toBeFocused()
})
