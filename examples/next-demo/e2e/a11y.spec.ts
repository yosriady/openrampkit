// Accessibility: dark theme, failure screen, touch target size on phones and reduced motion.
// deposit.spec.ts and withdraw.spec.ts also run axe on each key screen in the light theme.
import { expect, test, type Page } from '@playwright/test'
import { expectAccessible } from './a11y'

async function setup(page: Page, o: { country: string; destination?: string; wallet?: string; theme?: string; direction?: string }) {
  await page.goto('/')
  if (o.direction) await page.locator('#direction').selectOption(o.direction)
  await page.locator('#country').selectOption(o.country)
  if (o.destination) await page.locator('#destination').selectOption(o.destination)
  await page.locator('#wallet').selectOption(o.wallet ?? 'none')
  if (o.theme) await page.locator('#theme').selectOption(o.theme)
  return page.locator('openramp-modal')
}

test('dark theme: deposit screens pass axe', async ({ page }) => {
  const m = await setup(page, { country: 'VN', destination: 'monad', wallet: 'mock', theme: 'dark' })
  await expect(m).toContainText(/Most popular|Connected/)
  await expectAccessible(page, 'dark: method list')
  await m.getByRole('tab', { name: 'Use Cash' }).click()
  await m.getByRole('button', { name: /VietQR/ }).click()
  await m.getByRole('button', { name: /^₫500/ }).click()
  await expectAccessible(page, 'dark: amount with a chip selected')
  await m.getByRole('button', { name: 'Continue' }).click()
  await expect(m).toContainText('Best price')
  await expectAccessible(page, 'dark: quotes')
  await m.getByRole('button', { name: 'Confirm' }).click()
  await expect(m).toContainText('Scan with your banking or e-wallet app')
  await expectAccessible(page, 'dark: QR')
  await m.getByRole('button', { name: /Simulate payment/ }).click()
  await expect(m.getByRole('list', { name: 'Progress' })).toBeVisible()
  await expectAccessible(page, 'dark: progress')
  await expect(m).toContainText('Deposit complete', { timeout: 30_000 })
  await expectAccessible(page, 'dark: success')
})

test('dark theme: deposit address and withdraw target pass axe', async ({ page }) => {
  const m = await setup(page, { country: 'DE', destination: 'base', theme: 'dark' })
  await expect(m).toContainText(/Most popular|Other options/)
  await m.getByRole('tab', { name: 'Use Crypto' }).click()
  await m.getByRole('button', { name: /Transfer crypto/ }).click()
  await m.getByRole('button', { name: 'Continue' }).click()
  await expect(m).toContainText('Send USDC on')
  await m.getByRole('button', { name: /^Copy Address/ }).click()
  // The copy result is announced through a status region
  await expect(m.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1)
  await expectAccessible(page, 'dark: deposit address')

  await page.locator('#direction').selectOption('withdraw')
  await page.locator('#wallet').selectOption('mock')
  const address = m.getByRole('textbox', { name: 'Wallet address' })
  await expect(address).toBeVisible()
  await address.fill('0x1234')
  await expectAccessible(page, 'dark: withdraw target with an invalid address')
})

test('declined card payment: the failure screen passes axe and is announced', async ({ page, context }) => {
  const m = await setup(page, { country: 'SG', destination: 'base' })
  await m.getByRole('tab', { name: 'Use Cash' }).click()
  await m.getByRole('button', { name: /^Card/ }).click()
  await m.getByRole('textbox', { name: 'Amount' }).fill('100')
  await m.getByRole('button', { name: 'Continue' }).click()
  await m.getByRole('button', { name: 'Confirm' }).click()
  const popupPromise = context.waitForEvent('page')
  await m.getByRole('button', { name: /Continue to/ }).click()
  const popup = await popupPromise
  await popup.getByRole('button', { name: 'Decline payment' }).click()
  await expect(m.getByRole('heading', { name: 'Payment failed' }).last()).toBeVisible({ timeout: 30_000 })
  await expect(m.getByRole('status').first()).toHaveText(/Payment failed|did not go through/)
  await expectAccessible(page, 'failure')
})

test('phones: controls are at least 44 by 44 px', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chrome', 'touch target size applies to phones')
  await page.goto('/')
  await page.locator('#country').selectOption('DE')
  await page.locator('#wallet').selectOption('none')
  await page.locator('#embedded').uncheck()
  await page.getByRole('button', { name: 'Deposit', exact: true }).click()
  const m = page.locator('openramp-modal')
  await expect(m.getByRole('dialog')).toBeVisible()
  await page.waitForTimeout(300) // bottom sheet animation

  const small = async (screen: string) => {
    const sizes = await m.evaluate((el) =>
      [...el.shadowRoot!.querySelectorAll<HTMLElement>('button, [role="tab"], select, input, a[href]')]
        .filter((b) => b.getClientRects().length > 0)
        .map((b) => {
          const r = b.getBoundingClientRect()
          return { name: (b.getAttribute('aria-label') || b.textContent || b.tagName).trim(), w: Math.round(r.width), h: Math.round(r.height) }
        }),
    )
    return sizes.filter((s) => s.w < 44 || s.h < 44).map((s) => `${screen}: ${s.name} ${s.w}x${s.h}`)
  }

  const problems = [...(await small('methods'))]
  await m.getByRole('tab', { name: 'Use Cash' }).click()
  await m.getByRole('button', { name: /^Card/ }).click()
  await expect(m.getByRole('textbox', { name: 'Amount' })).toBeVisible()
  problems.push(...(await small('amount')))
  await m.getByRole('button', { name: 'Back' }).click()
  await m.getByRole('tab', { name: 'Use Crypto' }).click()
  await m.getByRole('button', { name: /Transfer crypto/ }).click()
  await expect(m).toContainText('Send from')
  problems.push(...(await small('transfer')))
  await m.getByRole('button', { name: 'Continue' }).click()
  await expect(m).toContainText('Send USDC on')
  problems.push(...(await small('deposit address')))
  expect(problems).toEqual([])
})

test('reduced motion: no entry animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.locator('#embedded').uncheck()
  await page.getByRole('button', { name: 'Deposit', exact: true }).click()
  const m = page.locator('openramp-modal')
  await expect(m.getByRole('dialog')).toBeVisible()
  const names = await m.evaluate((el) => {
    const root = el.shadowRoot!
    return ['.overlay', '.card'].map((s) => getComputedStyle(root.querySelector(s)!).animationName)
  })
  expect(names).toEqual(['none', 'none'])
})
