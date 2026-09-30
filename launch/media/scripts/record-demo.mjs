// Run from examples/playground (it resolves @playwright/test there), with `pnpm preview` serving on :5175.
// node ../../launch/media/scripts/record-demo.mjs [mobile]
import { chromium, devices } from '@playwright/test'
import fs from 'node:fs'
const OUT = '/Users/yos/openrampkit/launch/media'
const MOBILE = process.argv[2] === 'mobile'
const vp = MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 }
const vdir = `${OUT}/.video-${MOBILE ? 'm' : 'd'}`
fs.rmSync(vdir, { recursive: true, force: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: vp,
  deviceScaleFactor: 1,
  ...(MOBILE ? { isMobile: true, hasTouch: false, userAgent: devices['iPhone 14'].userAgent } : {}),
  recordVideo: { dir: vdir, size: vp },
})
const p = await ctx.newPage()
p.setDefaultTimeout(20000)
const t0 = Date.now()
const marks = []
const mark = (label) => { const s = ((Date.now() - t0) / 1000).toFixed(1); marks.push(`${s}s ${label}`); console.log(s, label) }
const wait = (ms) => p.waitForTimeout(ms)
let shotN = 0
const shot = async (name) => { if (MOBILE) return; shotN++; await p.screenshot({ path: `${OUT}/frame-${String(shotN).padStart(2, '0')}-${name}.png` }) }

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
const caption = (text) => p.evaluate((t) => { const c = document.getElementById('__caption'); if (!c) return; c.textContent = t; c.style.opacity = t ? '1' : '0' }, text).catch(() => {})
let mx = vp.width / 2, my = vp.height / 2
async function moveTo(loc) {
  await loc.scrollIntoViewIfNeeded()
  const b = await loc.boundingBox()
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  await p.mouse.move(x, y, { steps: 25 })
  mx = x; my = y
  await wait(350)
}
async function click(loc) { await moveTo(loc); await loc.click(); await wait(300) }
async function typeSlow(loc, text) { await click(loc); await loc.fill(''); await loc.pressSequentially(text, { delay: 140 }) }
async function select(id, value) { const s = p.locator(`#${id}`); await moveTo(s); await s.selectOption(value); await wait(300) }
const smoothScroll = (y) => p.evaluate((y) => new Promise((r) => { window.scrollTo({ top: y, behavior: 'smooth' }); setTimeout(r, 900) }), y)

// Title card
const card = (sub) => `<body style="margin:0;background:#10163A;color:#fff;font-family:Inter,-apple-system,'Helvetica Neue',Arial,sans-serif;height:100vh;display:grid;place-items:center;text-align:center">
<div><svg viewBox="0 0 64 64" width="${MOBILE ? 88 : 120}" height="${MOBILE ? 88 : 120}"><rect width="64" height="64" rx="15" fill="#2BE3A0"/><path d="M10 51 L54 51 L54 20 Z" fill="#10163A"/><circle cx="32.5" cy="25.5" r="7" fill="#10163A"/><circle cx="32.5" cy="25.5" r="3" fill="#2BE3A0"/></svg>
<div style="font-size:${MOBILE ? 40 : 76}px;letter-spacing:-2px;margin-top:24px"><b>OpenRamp</b>Kit</div>
<div style="font-size:${MOBILE ? 20 : 32}px;font-weight:600;margin-top:18px;padding:0 20px">${sub}</div></div></body>`
await p.setContent(card('The RainbowKit for onramps and deposits'))
mark('title card')
await wait(5000)

const URL = 'http://localhost:5175/playground/'
await p.goto(URL)
const m = p.locator('openramp-modal')
await m.getByRole('tab', { name: 'Use Cash' }).waitFor()
mark('playground loaded')
await caption('Playground: the real OpenRampKit server runs in the browser, with mock providers')
await wait(3500)

// a. Vietnam deposit with VietQR
await caption('Deposit from Vietnam')
await moveTo(p.locator('#country'))
await wait(1500)
await click(m.getByRole('tab', { name: 'Use Cash' }))
mark('Use Cash: local methods for Vietnam')
await caption('Local cash methods for the user country')
await wait(2500)
await shot('methods-vietnam')
await click(m.getByRole('button', { name: /VietQR/ }))
mark('VietQR selected')
await caption('Pay with VietQR')
await wait(1200)
await typeSlow(m.getByRole('textbox', { name: 'Amount' }), '500000')
await wait(1500)
await shot('amount')
await click(m.getByRole('button', { name: 'Continue' }))
mark('quotes shown')
await caption('Quotes from connected providers, best price first')
await wait(3500)
await shot('quotes')
await click(m.getByRole('button', { name: 'Confirm' }))
await m.getByRole('button', { name: /Simulate payment/ }).waitFor()
mark('QR screen')
await caption('Scan the VietQR code with any Vietnamese banking app')
await wait(4500)
await shot('vietqr')
await caption('Test mode: simulate the bank payment')
await click(m.getByRole('button', { name: /Simulate payment/ }))
mark('simulate payment')
await wait(1200)
await caption('Payment received, settling to USDC on Base')
await m.getByRole('heading', { name: 'Deposit complete' }).waitFor({ timeout: 30000 })
mark('deposit complete')
await caption('Deposit complete')
await wait(3000)
await shot('deposit-complete')
// Event and webhook logs
await caption('Widget events and signed webhooks to your backend')
if (MOBILE) {
  await p.locator('#events').scrollIntoViewIfNeeded()
} else {
  await smoothScroll(420)
}
mark('event and webhook logs')
await moveTo(p.getByTestId('webhooks').locator('li').first())
await wait(4500)
await shot('events-webhooks')
await smoothScroll(0)
await wait(800)

// b. Indonesia QRIS, Thailand PromptPay
await caption('Switch country: Indonesia')
await select('country', 'ID')
await m.getByRole('tab', { name: 'Use Cash' }).waitFor()
await wait(800)
if (MOBILE) await p.locator('#widget').scrollIntoViewIfNeeded()
await click(m.getByRole('tab', { name: 'Use Cash' }))
mark('Indonesia: QRIS')
await caption('Indonesia: QRIS, GoPay, DANA, bank transfer')
await wait(3500)
await shot('indonesia-qris')
await caption('Switch country: Thailand')
await select('country', 'TH')
await m.getByRole('tab', { name: 'Use Cash' }).waitFor()
await wait(800)
if (MOBILE) await p.locator('#widget').scrollIntoViewIfNeeded()
await click(m.getByRole('tab', { name: 'Use Cash' }))
mark('Thailand: PromptPay')
await caption('Thailand: PromptPay')
await wait(3500)

// c. Withdraw to a bank account
await caption('Withdraw: USDC out to a Thai bank account')
await select('direction', 'withdraw')
await m.getByRole('tab', { name: 'To cash' }).waitFor()
mark('withdraw flow')
await wait(1500)
if (MOBILE) await p.locator('#widget').scrollIntoViewIfNeeded()
await click(m.getByRole('tab', { name: 'To cash' }))
await wait(2000)
await click(m.getByRole('button', { name: /Bank transfer/ }))
await wait(800)
await typeSlow(m.getByRole('textbox', { name: /Amount/ }), '25')
await wait(1200)
await click(m.getByRole('button', { name: 'Continue' }))
mark('withdraw quote')
await caption('Payout quote in THB')
await wait(3000)
await click(m.getByRole('button', { name: 'Confirm' }))
await caption('Payout details')
const ins = m.locator('input')
await ins.first().waitFor()
await typeSlow(ins.nth(0), 'Somchai Jaidee')
await typeSlow(ins.nth(1), 'Kasikornbank')
await typeSlow(ins.nth(2), '1234567890')
await wait(800)
await shot('withdraw-payout')
await click(m.getByRole('button', { name: 'Continue' }))
await caption('Approve one transaction in the wallet')
await wait(2000)
await click(m.getByRole('button', { name: 'Confirm in wallet' }))
mark('withdraw sending')
await caption('Sending')
await m.getByRole('heading', { name: 'Withdrawal complete' }).waitFor({ timeout: 30000 })
mark('withdrawal complete')
await caption('Withdrawal complete')
await wait(3000)
await shot('withdraw-complete')

// d. Code sample panel
await caption('A few lines of code: create a session on your server, open the widget on your page')
await select('direction', 'deposit')
await wait(500)
const code = p.locator('#code')
await moveTo(code)
mark('code panel')
await wait(3000)
await caption('Theme it to match your app')
await select('theme', 'dark')
mark('dark theme')
await moveTo(code)
await wait(4000)
await shot('code-dark')
await caption('')

// Explorer: one settlement transaction on Arbitrum Sepolia
let explorerOk = true
try {
  await p.goto('https://arbitrum-sepolia.blockscout.com/tx/0x7e6a3848d92ea11ae833d05b9584f3f83481b9bb4f3ed849843b2ffffeea87ac', { waitUntil: 'domcontentloaded', timeout: 30000 })
  mark('explorer tx page')
  await caption('Live on Arbitrum Sepolia: settle into a vault in one transaction')
  await wait(4000)
  const logsTab = p.getByText('Logs', { exact: true }).first()
  try { await moveTo(logsTab); await logsTab.click(); await wait(1500) } catch {}
  if (!/tab=logs/.test(p.url())) await p.goto(p.url().split('?')[0] + '?tab=logs', { waitUntil: 'domcontentloaded' })
  const settled = p.getByText(/^Settled\(/).first()
  await settled.waitFor({ timeout: 20000 })
  await wait(1000)
  const y = await settled.evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 180)
  for (let i = 1; i <= 6; i++) { await p.evaluate((v) => window.scrollTo({ top: v, behavior: 'smooth' }), (y * i) / 6); await wait(450) }
  mark('Settled event visible')
  await caption('OpenRampSettlement emits Settled')
  await moveTo(settled)
  await wait(8000)
  await shot('explorer-settled')
} catch (e) {
  explorerOk = false
  console.log('explorer failed:', e.message)
}

await p.setContent(card('Open-source deposit infrastructure for crypto apps<br><span style="color:#2BE3A0;font-weight:500">github.com/yosriady/openrampkit · MIT</span>'))
mark('end card')
await wait(6000)
mark('end')
const video = p.video()
await ctx.close()
const src = await video.path()
const dest = `${OUT}/${MOBILE ? 'demo-draft-iphone14' : 'demo-draft'}.webm`
fs.renameSync(src, dest)
fs.rmSync(vdir, { recursive: true, force: true })
fs.writeFileSync(`/tmp/demo-marks-${MOBILE ? 'm' : 'd'}.txt`, marks.join('\n') + `\nexplorerOk=${explorerOk}\n`)
await browser.close()
console.log('saved', dest)
