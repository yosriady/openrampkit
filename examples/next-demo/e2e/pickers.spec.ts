// The token picker ("Send from") and the exchange picker ("From an exchange") at phone width, in
// Chromium, WebKit and Firefox: no horizontal overflow, the letter shows when a logo does not load
// (blocked by the page's CSP, or a failed request), keyboard use, and axe.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectAccessible } from './a11y'

test.use({ viewport: { width: 360, height: 740 } })

/** Logo hosts: the page's CSP allows the first and blocks the second. Neither is a real host. */
const ALLOWED = 'https://logos-allowed.openrampkit.test'
const BLOCKED = 'https://logos-blocked.openrampkit.test'
/** A 1x1 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

type Token = { chain: string; token: string; symbol: string; decimals: number; name?: string; logoUrl?: string }
const EXTRA = ['DAI', 'WETH', 'AERO', 'DEGEN', 'USDT', 'CBETH']

/**
 * Give the source list logos: USDC from the blocked host, the native token from the allowed host, and
 * six more tokens on each EVM chain (more than six tokens shows the search field). The server's
 * default list has no logos.
 */
async function sourcesWithLogos(page: Page) {
  await page.route('**/api/openramp/sessions/*/sources*', async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as { chains: Array<{ chain: string; tokens: Token[] }> }
    for (const c of body.chains) {
      if (!c.chain.startsWith('eip155:')) continue
      c.tokens = c.tokens.map((t) => ({ ...t, logoUrl: `${t.symbol === 'USDC' ? BLOCKED : ALLOWED}/${t.symbol.toLowerCase()}.png` }))
      EXTRA.forEach((symbol, i) =>
        c.tokens.push({ chain: c.chain, token: `0x${String(i + 1).padStart(40, 'a')}`, symbol, decimals: 18, name: `${symbol} token`, logoUrl: `${i % 2 ? BLOCKED : ALLOWED}/${symbol.toLowerCase()}.png` }),
      )
    }
    await route.fulfill({ response: res, json: body })
  })
  await page.route(`${ALLOWED}/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
}

/** Serve the playground page with a CSP that allows images from this origin and ALLOWED only */
async function withImageCsp(page: Page) {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const res = await route.fetch()
      await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': `img-src 'self' data: blob: ${ALLOWED}` } })
    },
  )
}

async function setup(page: Page, path = '/') {
  await page.goto(path)
  await page.locator('#country').selectOption('DE')
  await page.locator('#destination').selectOption('base')
  await page.locator('#wallet').selectOption('none')
  await page.locator('#embedded').uncheck()
  // Open with the keyboard: Safari does not focus a clicked button, so focus could not return to it
  const deposit = page.getByRole('button', { name: 'Deposit', exact: true })
  await deposit.focus()
  await page.keyboard.press('Enter')
  const m = page.locator('openramp-modal')
  await expect(m.getByRole('dialog')).toBeVisible()
  await expect(m.getByRole('tab', { name: 'Use Crypto' })).toBeVisible()
  return { m, deposit }
}

/** Nothing in the page or the dialog is wider than the viewport */
async function expectNoHorizontalOverflow(page: Page, screen: string) {
  const problems = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const out: string[] = []
    if (document.documentElement.scrollWidth > vw) out.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`)
    const root = document.querySelector('openramp-modal')?.shadowRoot
    const card = root?.querySelector<HTMLElement>('.card')
    if (!root || !card) return ['no dialog']
    if (card.scrollWidth > card.clientWidth + 1) out.push(`card scrollWidth ${card.scrollWidth} > ${card.clientWidth}`)
    for (const el of root.querySelectorAll<HTMLElement>('.card *')) {
      if (!el.getClientRects().length) continue
      const r = el.getBoundingClientRect()
      if (r.width && (r.left < -1 || r.right > vw + 1)) out.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`)
    }
    return out.slice(0, 10)
  })
  expect(problems, `horizontal overflow on the "${screen}" screen`).toEqual([])
}

/** The logo state of a `.token-logo`: its letter, whether the letter shows, and whether an image shows */
async function logoState(logo: Locator) {
  return logo.evaluate((el) => {
    const img = el.querySelector('img')
    const imageShows = !!img && !img.hidden && img.complete && img.naturalWidth > 0 && getComputedStyle(img).display !== 'none'
    return { letter: el.getAttribute('data-letter'), before: getComputedStyle(el, '::before').content, imageShows }
  })
}

/** Name of the focused element, looking through open Shadow DOM roots */
async function focusedName(page: Page) {
  return page.evaluate(() => {
    let a: Element | null = document.activeElement
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
    return (a?.getAttribute('aria-label') || a?.textContent || '').replace(/\s+/g, ' ').trim()
  })
}

/** Press Tab until the focused element's name matches. Fails when it never does. */
async function tabTo(page: Page, name: RegExp, max = 30) {
  const seen: string[] = []
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const f = await focusedName(page)
    seen.push(f)
    if (name.test(f)) return
  }
  throw new Error(`Tab never reached ${name}. Focus went: ${seen.join(' | ')}`)
}

/** Use Crypto with the arrow keys on the tab list, then open a method row with Enter */
async function openCryptoMethod(page: Page, m: Locator, row: RegExp) {
  await tabTo(page, /^Use (Crypto|Cash)$/)
  if ((await focusedName(page)) !== 'Use Crypto') await page.keyboard.press('ArrowLeft')
  await expect(m.getByRole('tab', { name: 'Use Crypto' })).toHaveAttribute('aria-selected', 'true')
  await tabTo(page, row)
  await page.keyboard.press('Enter')
}

test('token picker: phone layout, a logo blocked by CSP shows the letter, keyboard, axe', async ({ page }) => {
  await withImageCsp(page)
  await sourcesWithLogos(page)
  // The blocked host would serve the logo: only the CSP stops it
  await page.route(`${BLOCKED}/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  const { m, deposit } = await setup(page)
  await openCryptoMethod(page, m, /^Transfer crypto/)
  await expect(m).toContainText('Send from')

  // USDC is first: its logo host is blocked by the CSP, so the button shows the letter
  const button = m.getByRole('button', { name: 'Token' })
  await expect(button).toContainText('USDC')
  await expect.poll(() => logoState(button.locator('.token-logo'))).toEqual({ letter: 'U', before: '"U"', imageShows: false })
  await expectNoHorizontalOverflow(page, 'send from')

  // Keyboard: Enter opens the list, type in the search field, Tab to a token, Enter picks it
  await tabTo(page, /^Token$/)
  await page.keyboard.press('Enter')
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const list = m.getByRole('radiogroup', { name: 'Token' })
  await expect(list.getByRole('radio')).toHaveCount(2 + EXTRA.length)
  await expect(list.getByRole('radio', { name: /^USDC/ })).toHaveAttribute('aria-checked', 'true')

  // Logos in the open list: blocked ones show the letter, allowed ones show the image
  await expect.poll(() => logoState(list.getByRole('radio', { name: /^DEGEN/ }).locator('.token-logo'))).toEqual({ letter: 'D', before: '"D"', imageShows: false })
  await expect.poll(async () => (await logoState(list.getByRole('radio', { name: /^AERO/ }).locator('.token-logo'))).imageShows).toBe(true)
  await expectNoHorizontalOverflow(page, 'token list')
  await expectAccessible(page, 'token list')

  await tabTo(page, /^Search tokens$/)
  await page.keyboard.type('aero')
  await expect(list.getByRole('radio')).toHaveCount(1)
  await tabTo(page, /^AERO/)
  await page.keyboard.press('Enter')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await expect(button).toContainText('AERO')
  await expect.poll(async () => (await logoState(button.locator('.token-logo'))).imageShows).toBe(true)

  // A search with no match says so
  await tabTo(page, /^Token$/)
  await page.keyboard.press('Enter')
  await tabTo(page, /^Search tokens$/)
  await page.keyboard.type('zzz')
  await expect(m.getByRole('radiogroup', { name: 'Token' })).toContainText('No token found')
  await expectAccessible(page, 'token list with no match')

  // Escape closes the dialog and focus returns to the opener
  await page.keyboard.press('Escape')
  await expect(m.getByRole('dialog')).toBeHidden()
  await expect(deposit).toBeFocused()
})

test('token picker: a logo that fails to load shows the letter', async ({ page }) => {
  await sourcesWithLogos(page)
  // No CSP here: the request goes out and fails
  await page.route(`${BLOCKED}/**`, (route) => route.abort('failed'))
  const { m } = await setup(page)
  await m.getByRole('tab', { name: 'Use Crypto' }).click()
  await m.getByRole('button', { name: /^Transfer crypto/ }).click()
  const button = m.getByRole('button', { name: 'Token' })
  await expect.poll(() => logoState(button.locator('.token-logo'))).toEqual({ letter: 'U', before: '"U"', imageShows: false })
  await button.click()
  const list = m.getByRole('radiogroup', { name: 'Token' })
  for (const [symbol, failed] of [['USDC', true], ['DAI', false], ['WETH', true], ['USDT', false], ['CBETH', true]] as const) {
    const logo = list.getByRole('radio', { name: new RegExp(`^${symbol}`) }).locator('.token-logo')
    await expect.poll(async () => (await logoState(logo)).imageShows, `${symbol} logo`).toBe(!failed)
    if (failed) expect(await logoState(logo)).toEqual({ letter: symbol[0], before: `"${symbol[0]}"`, imageShows: false })
  }
  await expectNoHorizontalOverflow(page, 'token list')
})

test('exchange picker: phone layout, letter logos, keyboard, axe', async ({ page }) => {
  // `?extras=1`: the demo also offers the exchange methods, so "From an exchange" opens the picker
  const { m, deposit } = await setup(page, '/?extras=1')
  await openCryptoMethod(page, m, /^From an exchange/)
  const list = m.getByRole('list', { name: 'Choose your exchange' })
  await expect(list).toBeVisible()
  const rows = list.getByRole('button')
  await expect(rows).toHaveText([/Binance/, /Coinbase/, /OKX/, /Bybit/, /Kraken/, /Other exchange/])

  // No exchange has a logo image: each row shows its first letter
  for (const [name, letter] of [['Binance', 'B'], ['Coinbase', 'C'], ['OKX', 'O'], ['Bybit', 'B'], ['Kraken', 'K']] as const) {
    expect(await logoState(rows.filter({ hasText: name }).locator('.token-logo'))).toEqual({ letter, before: `"${letter}"`, imageShows: false })
  }
  await expectNoHorizontalOverflow(page, 'exchange picker')
  await expectAccessible(page, 'exchange picker')

  // Keyboard: Tab to an exchange, Enter picks it (Binance: send from the exchange to a deposit address)
  await tabTo(page, /^Binance/)
  await page.keyboard.press('Enter')
  await expect(m).toContainText('Send from')
  await expectNoHorizontalOverflow(page, 'send from an exchange')

  // Back returns to the picker; Escape closes the dialog and focus returns to the opener
  await tabTo(page, /^Back$/)
  await page.keyboard.press('Enter')
  await expect(list).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(m.getByRole('dialog')).toBeHidden()
  await expect(deposit).toBeFocused()
})
