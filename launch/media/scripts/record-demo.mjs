// Records the demo video from the playground, timed to the voiceover clips.
//
// 1. bash launch/media/scripts/tts.sh            (voice clips + .vo/durations.json)
// 2. pnpm playground:build, then serve it:      (cd examples/playground && npx vite preview --port 5188 --strictPort)
// 3. cd examples/playground && node ../../launch/media/scripts/record-demo.mjs [baseUrl]
// 4. bash launch/media/scripts/mix-demo.sh       (voiceover mix + final encodes)
//
// Each scene is a "beat" with one voiceover line (scripts/demo-lines.json). A beat lasts at least as long as its clip.
// The start time of each beat goes to .vo/marks.json, so the mix places each clip at its beat.
import fs from 'node:fs'
import { createRequire } from 'node:module'

// Resolve Playwright from the working directory (examples/playground), not from this file.
const { chromium } = createRequire(`${process.cwd()}/`)('@playwright/test')

const OUT = '/Users/yos/openrampkit/launch/media'
const VO = `${OUT}/.vo`
const BASE = process.argv[2] ?? 'http://localhost:5188/playground/'
const DUR = JSON.parse(fs.readFileSync(`${VO}/durations.json`, 'utf8'))
const PAD = 450 // ms of quiet after each line
const vp = { width: 1280, height: 800 }
const vdir = `${OUT}/.video-d`
fs.rmSync(vdir, { recursive: true, force: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: vp } })

// A visible cursor and a caption bar, because headless video has no cursor.
await ctx.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div')
    c.id = '__cursor'
    c.style.cssText = 'position:fixed;left:-50px;top:-50px;width:22px;height:22px;border-radius:50%;background:rgba(43,227,160,.55);border:2px solid #10163A;z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);transition:transform .12s'
    document.documentElement.appendChild(c)
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', () => { c.style.transform = 'translate(-50%,-50%) scale(.7)' }, true)
    addEventListener('mouseup', () => { c.style.transform = 'translate(-50%,-50%)' }, true)
    const cap = document.createElement('div')
    cap.id = '__caption'
    cap.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:92vw;background:#10163A;color:#fff;font:600 16px/1.3 -apple-system,Segoe UI,sans-serif;padding:10px 18px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:2147483646;pointer-events:none;opacity:0;transition:opacity .3s;text-align:center'
    document.documentElement.appendChild(cap)
  })
})

const p = await ctx.newPage()
const t0 = Date.now() // the video starts with the page; mix-demo.sh measures the small offset
p.setDefaultTimeout(20000)
const now = () => Date.now() - t0
const wait = (ms) => p.waitForTimeout(ms)
const marks = {}
const caption = (text) => p.evaluate((t) => { const c = document.getElementById('__caption'); if (!c) return; c.textContent = t; c.style.opacity = t ? '1' : '0' }, text).catch(() => {})

/** One scene with one voiceover line. It lasts at least as long as the clip plus PAD. */
async function beat(id, cap, fn) {
  if (!(id in DUR)) throw new Error(`no clip for ${id}`)
  const start = now()
  marks[id] = start / 1000
  console.log((start / 1000).toFixed(1), id)
  if (cap !== undefined) await caption(cap)
  await fn()
  const rest = DUR[id] * 1000 + PAD - (now() - start)
  if (rest > 0) await wait(rest)
}

let shotN = 0
const shot = async (name) => { shotN++; await p.screenshot({ path: `${OUT}/frame-${String(shotN).padStart(2, '0')}-${name}.png` }) }

async function moveTo(loc) {
  await loc.scrollIntoViewIfNeeded()
  const b = await loc.boundingBox()
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 22 })
  await wait(300)
}
async function click(loc) { await moveTo(loc); await loc.click(); await wait(250) }
async function typeSlow(loc, text, delay = 110) { await click(loc); await loc.fill(''); await loc.pressSequentially(text, { delay }) }
async function select(id, value) { const s = p.locator(`#${id}`); await moveTo(s); await s.selectOption(value); await wait(350) }
async function check(name, on) { const b = p.getByRole('checkbox', { name }); await moveTo(b); on ? await b.check() : await b.uncheck(); await wait(350) }
const smoothScroll = (y) => p.evaluate((y) => new Promise((r) => { window.scrollTo({ top: y, behavior: 'smooth' }); setTimeout(r, 900) }), y)

const LOGO = (s) => `<svg viewBox="0 0 64 64" width="${s}" height="${s}"><rect width="64" height="64" rx="15" fill="#2BE3A0"/><path d="M10 51 L54 51 L54 20 Z" fill="#10163A"/><circle cx="32.5" cy="25.5" r="7" fill="#10163A"/><circle cx="32.5" cy="25.5" r="3" fill="#2BE3A0"/></svg>`
const card = (inner) => `<body style="margin:0;background:#10163A;color:#fff;font-family:Inter,-apple-system,'Helvetica Neue',Arial,sans-serif;height:100vh;display:grid;place-items:center;text-align:center"><div>${inner}</div></body>`
const WORDMARK = `<div style="font-size:76px;letter-spacing:-2px;margin-top:24px"><b>OpenRamp</b>Kit</div>`

// 1. Title card
await beat('01-title', undefined, async () => {
  await p.setContent(card(`${LOGO(120)}${WORDMARK}
<div style="font-size:34px;font-weight:600;margin-top:18px">Unified deposits and withdrawals for any app</div>
<div style="font-size:24px;color:#2BE3A0;margin-top:14px">The RainbowKit for onramps and deposits</div>`))
  await wait(300)
  await shot('title')
})

const m = p.locator('openramp-modal')
const amount = () => m.getByRole('textbox', { name: /Amount/ })

// 2. Playground
await beat('02-intro', 'Playground: the OpenRampKit server runs in the browser, with four mock providers', async () => {
  await p.goto(BASE)
  await m.getByRole('tab', { name: 'Use Cash' }).waitFor()
  await wait(4000)
  await moveTo(p.getByTestId('demo-banner'))
  await wait(3000)
  await moveTo(p.locator('#country'))
})

// 3. Vietnam: VietQR
await beat('03-vn', 'Vietnam: local cash methods', async () => {
  await click(m.getByRole('tab', { name: 'Use Cash' }))
  await wait(1500)
  await shot('vn-methods')
  await click(m.getByRole('button', { name: /VietQR/ }))
  await caption('Pay with VietQR: 500,000 VND')
  await typeSlow(amount(), '500000')
  await wait(500)
})

// 4. Quotes
await beat('04-quotes', 'Three mock providers quote the same route. Best price first.', async () => {
  await click(m.getByRole('button', { name: 'Continue' }))
  const quotes = m.getByRole('radiogroup', { name: 'Quotes' }).getByRole('radio')
  await quotes.nth(1).waitFor()
  await wait(1200)
  await moveTo(quotes.first())
  await wait(1200)
  await shot('vn-quotes')
  await moveTo(quotes.nth(2))
  await wait(1000)
})

// 5. VietQR code and simulated bank payment
await beat('05-qr', 'Scan with any Vietnamese banking app', async () => {
  await click(m.getByRole('button', { name: 'Confirm' }))
  const sim = m.getByRole('button', { name: /Simulate payment/ })
  await sim.waitFor()
  await wait(2800)
  await shot('vn-vietqr')
  await caption('Test mode: simulate the bank payment')
  await click(sim)
})

// 6. Deposit complete, events and signed webhook
await beat('06-webhook', 'Widget events on your page. Signed webhooks to your backend.', async () => {
  await m.getByRole('heading', { name: 'Deposit complete' }).waitFor({ timeout: 30000 })
  await wait(1200)
  await shot('vn-complete')
  await smoothScroll(420)
  const ok = p.getByTestId('webhooks').getByText('signature ok').first()
  await moveTo(ok)
  await wait(1500)
  await shot('events-webhooks')
})

// 7. United States: card, quotes
await beat('07-us', 'United States: card, Apple Pay and Google Pay', async () => {
  await smoothScroll(0)
  await select('country', 'US')
  await m.getByRole('tab', { name: 'Use Cash' }).waitFor()
  await click(m.getByRole('tab', { name: 'Use Cash' }))
  await m.getByRole('button', { name: /Apple Pay/ }).waitFor()
  await wait(1200)
  await shot('us-methods')
  await click(m.getByRole('button', { name: /^Card/ }))
  await typeSlow(amount(), '100')
  await click(m.getByRole('button', { name: 'Continue' }))
  await m.getByRole('radiogroup', { name: 'Quotes' }).getByRole('radio').nth(1).waitFor()
  await wait(1200)
})

// 8. Test card in the widget
await beat('08-card', 'Test card 4242 4242 4242 4242, right in the widget', async () => {
  await click(m.getByRole('button', { name: 'Confirm' }))
  await typeSlow(m.getByRole('textbox', { name: /Card number/ }), '4242 4242 4242 4242', 40)
  await typeSlow(m.getByRole('textbox', { name: /Expiry/ }), '12/30', 80)
  await typeSlow(m.getByRole('textbox', { name: 'CVC' }), '123', 80)
  await wait(400)
  await shot('us-card')
  await click(m.getByRole('button', { name: 'Pay (test mode)' }))
  await m.getByRole('heading', { name: 'Deposit complete' }).waitFor({ timeout: 30000 })
  await caption('Deposit complete')
  await wait(1200)
})

// 9. From an exchange
await beat('09-exchange', 'Use Crypto: from an exchange', async () => {
  await p.goto(`${BASE}?country=US`) // a new session
  await m.getByRole('tab', { name: 'Use Crypto' }).waitFor()
  await wait(500)
  await click(m.getByRole('tab', { name: 'Use Crypto' }))
  await wait(800)
  await click(m.getByRole('button', { name: /From an exchange/ }))
  await m.getByRole('combobox', { name: 'Network' }).waitFor()
  await wait(1000)
  await click(m.getByRole('button', { name: 'Continue' }))
  await caption('A deposit address, with the network and the token')
  await m.getByText(/Send USDC on \w+ to this address/).waitFor()
  await wait(3000)
  await shot('exchange-address')
  await click(m.getByRole('button', { name: /Simulate deposit/ }))
  await m.getByRole('heading', { name: 'Deposit complete' }).waitFor({ timeout: 30000 })
  await smoothScroll(0)
})

// 10. Customization: payment sources, theme, corners, font
await beat('10-custom', 'Choose payment sources. Match your brand.', async () => {
  await check(/^Card/, false)
  await wait(1500)
  const cashTab = m.getByRole('tab', { name: 'Use Cash' })
  if (await cashTab.count()) await click(cashTab)
  await wait(1200)
  await select('theme', 'dark')
  await wait(500)
  await select('radius', 'small')
  await wait(500)
  await select('font', 'rounded')
  await wait(600)
  await p.mouse.move(490, 300, { steps: 20 })
  await shot('custom-dark')
})

// 11. Withdraw to a bank account: quote
await beat('11-withdraw', 'Withdraw: USDC to a bank account in Vietnam', async () => {
  await check(/^Card/, true)
  await select('country', 'VN')
  await select('direction', 'withdraw')
  await m.getByRole('tab', { name: 'To cash' }).waitFor()
  await click(m.getByRole('tab', { name: 'To cash' }))
  await wait(700)
  await click(m.getByRole('button', { name: /Bank transfer/ }))
  await typeSlow(amount(), '25')
  await click(m.getByRole('button', { name: 'Continue' }))
  await caption('Payout quotes in VND')
  await m.getByRole('radiogroup', { name: 'Quotes' }).getByRole('radio').first().waitFor()
  await wait(1500)
  await shot('withdraw-quote')
})

// 12. Payout details, wallet approval, done
await beat('12-withdraw-done', 'Bank details, then one wallet approval', async () => {
  await click(m.getByRole('button', { name: 'Confirm' }))
  const ins = m.locator('input')
  await ins.first().waitFor()
  await typeSlow(ins.nth(0), 'Nguyen Van An', 45)
  await typeSlow(ins.nth(1), 'Vietcombank', 45)
  await typeSlow(ins.nth(2), '0123456789', 45)
  await click(m.getByRole('button', { name: 'Continue' }))
  await click(m.getByRole('button', { name: 'Confirm in wallet' }))
  await m.getByRole('heading', { name: 'Withdrawal complete' }).waitFor({ timeout: 30000 })
  await caption('Withdrawal complete')
  await wait(1000)
  await shot('withdraw-complete')
})

// 13. Code
await beat('13-code', 'A few lines: create a session on your server, open the widget on your page', async () => {
  await select('direction', 'deposit')
  await wait(400)
  const code = p.locator('#code')
  await moveTo(code)
  await p.mouse.move(900, 180, { steps: 20 })
  await wait(1500)
  await p.mouse.move(900, 420, { steps: 30 })
  await wait(800)
  await shot('code')
})

// 14 and 15. Explorer: the Settled event on Arbitrum Sepolia
const TX = 'https://arbitrum-sepolia.blockscout.com/tx/0x7e6a3848d92ea11ae833d05b9584f3f83481b9bb4f3ed849843b2ffffeea87ac'
let explorerOk = true
await beat('14-explorer', '10 provider adapters. Self-hosted, next to your backend.', async () => {
  await caption('')
  try {
    await p.goto(TX, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await caption('10 provider adapters. Self-hosted, next to your backend.')
    await wait(2500)
  } catch (e) {
    explorerOk = false
    console.log('explorer failed:', e.message)
  }
})
await beat('15-settled', 'Live on Arbitrum Sepolia: OpenRampSettlement emits Settled', async () => {
  try {
    if (!explorerOk) throw new Error('explorer page did not load')
    if (!/tab=logs/.test(p.url())) {
      const logsTab = p.getByText('Logs', { exact: true }).first()
      try { await moveTo(logsTab); await logsTab.click(); await wait(1200) } catch {}
    }
    if (!/tab=logs/.test(p.url())) await p.goto(p.url().split('?')[0] + '?tab=logs', { waitUntil: 'domcontentloaded' })
    await caption('Live on Arbitrum Sepolia: OpenRampSettlement emits Settled')
    const settled = p.getByText(/^Settled\(/).first()
    await settled.waitFor({ timeout: 20000 })
    await wait(600)
    const y = await settled.evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 180)
    for (let i = 1; i <= 6; i++) { await p.evaluate((v) => window.scrollTo({ top: v, behavior: 'smooth' }), (y * i) / 6); await wait(350) }
    await moveTo(settled)
    await wait(1500)
    await shot('explorer-settled')
  } catch (e) {
    explorerOk = false
    console.log('explorer failed:', e.message)
    // Fallback: the last good screenshot of the same transaction.
    const img = fs.readFileSync(`${OUT}/frame-explorer-fallback.png`).toString('base64')
    await p.setContent(`<body style="margin:0;background:#fff"><img src="data:image/png;base64,${img}" style="width:100vw;height:100vh;object-fit:contain"></body>`)
    await caption('Live on Arbitrum Sepolia: OpenRampSettlement emits Settled')
  }
})

// 16. End card
await beat('16-end', undefined, async () => {
  await p.setContent(card(`${LOGO(100)}${WORDMARK}
<div style="font-size:30px;font-weight:600;margin-top:16px">Open-source, unified deposit infrastructure for crypto apps</div>
<div style="font-size:22px;margin-top:14px;opacity:.85">10 provider adapters · Pathway planner · Self-hosted · AI agents via MCP · MIT</div>
<div style="font-size:26px;color:#2BE3A0;font-weight:600;margin-top:30px">github.com/yosriady/openrampkit</div>
<div style="font-size:24px;color:#2BE3A0;margin-top:8px">openrampkit-getformo.vercel.app</div>`))
  await wait(300)
  await shot('end')
})
await wait(800)
marks.end = now() / 1000

const video = p.video()
await ctx.close()
fs.renameSync(await video.path(), `${OUT}/demo-raw.webm`)
fs.rmSync(vdir, { recursive: true, force: true })
fs.writeFileSync(`${VO}/marks.json`, JSON.stringify({ ...marks, explorerOk }, null, 2))
await browser.close()
console.log('saved', `${OUT}/demo-raw.webm`, 'length', marks.end.toFixed(1), 's', 'explorerOk', explorerOk)
