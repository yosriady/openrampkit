// Withdraw flows in the playground, with the mock wallet and the mock offramp.
// Playwright locators pierce the web component's Shadow DOM.
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const ARB_ADDRESS = '0x2222222222222222222222222222222222222222'

async function setup(page: Page, opts: { country: string; wallet?: 'none' | 'mock' }) {
  await page.goto('/')
  await page.locator('#direction').selectOption('withdraw')
  await page.locator('#country').selectOption(opts.country)
  await page.locator('#wallet').selectOption(opts.wallet ?? 'mock')
  // The embedded widget restarts with a new session on each change; wait for the "To wallet" form.
  await expect(page.locator('openramp-modal').getByRole('textbox', { name: 'Wallet address' })).toBeVisible()
}

/** Screenshots: every step on desktop, the first screen on phones. */
async function shot(page: Page, info: TestInfo, name: string, phone = false) {
  if (info.project.name === 'desktop-chrome') await page.screenshot({ path: `e2e/screens/withdraw-${name}.png` })
  else if (phone && info.project.name === 'mobile-iphone') await page.screenshot({ path: `e2e/screens/withdraw-mobile-${name}.png` })
}

async function waitForWebhook(page: Page, type: string) {
  await expect(page.getByTestId('webhooks')).toContainText(type, { timeout: 30_000 })
}

test('To wallet: USDC on Base to an Arbitrum address, signed by the mock wallet', async ({ page }, info) => {
  await setup(page, { country: 'US' })
  const modal = page.locator('openramp-modal')
  await expect(modal.getByRole('heading', { name: 'Withdraw' })).toBeVisible()
  await expect(modal.getByRole('tab', { name: 'To wallet' })).toHaveAttribute('aria-selected', 'true')
  await expect(modal.getByRole('tab', { name: 'To cash' })).toBeVisible()
  const address = modal.getByRole('textbox', { name: 'Wallet address' })
  // Prefilled with the connected (mock) wallet
  await expect(address).toHaveValue('0x1111111111111111111111111111111111111111')

  await modal.getByRole('combobox', { name: 'Network' }).selectOption('eip155:42161')
  await expect(modal.getByRole('combobox', { name: 'Token' })).toHaveValue('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
  await address.fill('0x1234')
  await expect(modal).toContainText('Enter a valid address for this network.')
  await expect(modal.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await address.fill(ARB_ADDRESS)
  await shot(page, info, '01-to-wallet', true)
  await modal.getByRole('button', { name: 'Continue' }).click()

  await expect(modal.getByRole('heading', { name: 'Amount to withdraw' })).toBeVisible()
  await expect(modal).toContainText('Available: 40 USDC')
  await expect(modal).toContainText(/To 0x2222.*2222 on Arbitrum/)
  await modal.getByRole('textbox', { name: 'Amount' }).fill('25')
  await shot(page, info, '02-amount')
  await modal.getByRole('button', { name: 'Continue' }).click()

  await expect(modal).toContainText('You send 25 USDC')
  await shot(page, info, '03-quote')
  await modal.getByRole('button', { name: 'Confirm', exact: true }).click()

  await expect(modal.getByRole('heading', { name: 'Confirm withdrawal' })).toBeVisible()
  await expect(modal).toContainText('Approve 1 transaction on Base.')
  await shot(page, info, '04-confirm-in-wallet')
  await modal.getByRole('button', { name: 'Confirm in wallet' }).click()

  await expect(modal).toContainText('Withdrawal complete', { timeout: 30_000 })
  await shot(page, info, '05-wallet-done')
  await waitForWebhook(page, 'withdrawal.completed')
})

test('To cash: GCash payout in the Philippines through the mock offramp', async ({ page }, info) => {
  await setup(page, { country: 'PH' })
  const modal = page.locator('openramp-modal')
  await modal.getByRole('tab', { name: 'To cash' }).click()
  await expect(modal).toContainText('Paid out in PHP')
  await expect(modal).toContainText('Most popular')
  await expect(modal).not.toContainText('MoMo') // Vietnam only
  await shot(page, info, '10-cash-methods', true)
  await modal.getByRole('button', { name: /GCash/ }).click()

  await expect(modal).toContainText('GCash · Paid out in PHP')
  await modal.getByRole('textbox', { name: 'Amount' }).fill('20')
  await modal.getByRole('button', { name: 'Continue' }).click()
  await expect(modal).toContainText('₱1,131.43')
  await expect(modal).toContainText('You send 20 USDC')
  await shot(page, info, '11-cash-quote')
  await modal.getByRole('button', { name: 'Confirm', exact: true }).click()

  await expect(modal.getByRole('heading', { name: 'Payout details' })).toBeVisible()
  await modal.getByRole('textbox', { name: 'Account holder name' }).fill('Juan Dela Cruz')
  await modal.getByRole('textbox', { name: 'GCash phone number' }).fill('0917 123 4567')
  await shot(page, info, '12-payout-details')
  await modal.getByRole('button', { name: 'Continue' }).click()

  await expect(modal.getByRole('heading', { name: 'Confirm withdrawal' })).toBeVisible()
  await shot(page, info, '13-send-usdc')
  await modal.getByRole('button', { name: 'Confirm in wallet' }).click()

  await expect(modal).toContainText('Withdrawal complete', { timeout: 30_000 })
  await expect(modal).toContainText('You get about ₱1,131.43')
  await shot(page, info, '14-cash-done')
  await waitForWebhook(page, 'withdrawal.completed')
})

test('Address screening: the burn address is refused', async ({ page }) => {
  await setup(page, { country: 'US' })
  const modal = page.locator('openramp-modal')
  await modal.getByRole('textbox', { name: 'Wallet address' }).fill('0x000000000000000000000000000000000000dEaD')
  await modal.getByRole('button', { name: 'Continue' }).click()
  await expect(modal).toContainText('This address cannot receive withdrawals.')
})
