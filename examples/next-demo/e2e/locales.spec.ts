// Every built-in locale fits on an iPhone: no text cut off, nothing wider than the sheet.
// Screenshots go to e2e/screens/locale-*.png for a visual check.
import { expect, test, type Locator } from '@playwright/test'

const LOCALES = ['en', 'vi', 'id', 'th', 'ms', 'fil']

/** Elements that stick out of the card, text that is cut off, and sideways scrolling. */
async function overflow(modal: Locator): Promise<string[]> {
  return modal.evaluate((host) => {
    const root = host.shadowRoot!
    const card = root.querySelector('.card')!.getBoundingClientRect()
    const issues: string[] = []
    const describe = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 40)}"`
    const body = root.querySelector('.body')!
    if (body.scrollWidth > body.clientWidth + 1) issues.push('the body scrolls sideways')
    if (card.left < -1 || card.right > window.innerWidth + 1) issues.push('the card is wider than the screen')
    // Text that must show in full. Single-line text uses an ellipsis when it is too long.
    const full = '.title, .tab, .btn, .chip, .row-title, .row-sub, .row-end, .group-label, .hint, .amount-input-wrap, .field-label, .footer'
    for (const el of root.querySelectorAll<HTMLElement>('.card *')) {
      if (el.closest('.sr-only') || el.getClientRects().length === 0 || el instanceof SVGElement) continue
      const r = el.getBoundingClientRect()
      if (r.left < card.left - 1 || r.right > card.right + 1) issues.push(`${describe(el)} sticks out of the card`)
      if (el.matches(full) && el.scrollWidth > el.clientWidth + 1) issues.push(`${describe(el)} is cut off`)
    }
    return issues
  })
}

for (const locale of LOCALES) {
  test(`${locale}: method list and amount fit on an iPhone`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile-iphone', 'locale layout is checked on the iPhone project')
    await page.goto('/')
    await page.locator('#country').selectOption('VN')
    await page.locator('#destination').selectOption('monad')
    await page.locator('#wallet').selectOption('mock')
    await page.locator('#locale').selectOption(locale)
    await page.locator('#embedded').uncheck()
    await page.getByRole('button', { name: 'Deposit', exact: true }).click()
    const modal = page.locator('openramp-modal')
    await expect(modal.locator('.card')).toHaveAttribute('lang', locale)
    await expect(modal.locator('[data-method]').first()).toBeVisible()
    await page.waitForTimeout(300) // bottom sheet animation

    const problems: string[] = []
    for (const tab of ['crypto', 'cash']) {
      await modal.locator(`#ork-tab-${tab}`).click()
      await expect(modal.locator(`#ork-tab-${tab}`)).toHaveAttribute('aria-selected', 'true')
      await page.waitForTimeout(200) // tab highlight transition, for the screenshot
      problems.push(...(await overflow(modal)).map((p) => `methods (${tab}): ${p}`))
      await page.screenshot({ path: `e2e/screens/locale-${locale}-methods-${tab}.png` })
    }

    await modal.locator('[data-method="vietqr"]').click()
    const amount = modal.locator('.amount-input')
    await expect(amount).toBeVisible()
    await amount.fill('2000000')
    await modal.locator('.chip').last().click()
    problems.push(...(await overflow(modal)).map((p) => `amount: ${p}`))
    await page.screenshot({ path: `e2e/screens/locale-${locale}-amount.png` })
    expect(problems).toEqual([])
  })
}
