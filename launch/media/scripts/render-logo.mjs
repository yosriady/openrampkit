// Run from examples/playground: node ../../launch/media/scripts/render-logo.mjs
import { chromium } from '@playwright/test'
import fs from 'node:fs'
const dir = '/Users/yos/openrampkit/launch/media'
const mark = fs.readFileSync(`${dir}/logo-mark.svg`, 'utf8')
const browser = await chromium.launch()
async function shot(w, h, html, out, scale = 1) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale })
  await p.setContent(html)
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${out.startsWith("/") ? out : dir + "/" + out}` })
  await p.close()
}
const base = `<style>html,body{margin:0}body{font-family:Inter,'SF Pro Display','Helvetica Neue',Arial,sans-serif}</style>`
// 512 square: mark on solid navy background
await shot(512, 512, `${base}<body style="background:#10163A;width:512px;height:512px;display:grid;place-items:center">
<svg viewBox="4 6 60 52" width="440" height="381"><path d="M10 51 L54 51 L54 20 Z" fill="#2BE3A0"/><circle cx="32.5" cy="25.5" r="7" fill="#2BE3A0"/><circle cx="32.5" cy="25.5" r="3" fill="#10163A"/></svg></body>`, 'logo-512.png')
// social card
await shot(1200, 630, `${base}<body style="background:#10163A;width:1200px;height:630px;color:#fff;position:relative;overflow:hidden">
<svg viewBox="0 0 64 64" width="620" height="620" style="position:absolute;right:-200px;bottom:-230px;opacity:.10"><path d="M10 51 L54 51 L54 20 Z" fill="#2BE3A0"/><circle cx="32.5" cy="25.5" r="7" fill="#2BE3A0"/></svg>
<div style="position:absolute;left:96px;top:150px">
 <div style="display:flex;align-items:center;gap:28px">
  <svg viewBox="0 0 64 64" width="120" height="120"><rect width="64" height="64" rx="15" fill="#2BE3A0"/><path d="M10 51 L54 51 L54 20 Z" fill="#10163A"/><circle cx="32.5" cy="25.5" r="7" fill="#10163A"/><circle cx="32.5" cy="25.5" r="3" fill="#2BE3A0"/></svg>
  <div style="font-size:92px;letter-spacing:-2.5px;line-height:1"><b style="font-weight:800">OpenRamp</b><span style="font-weight:400">Kit</span></div>
 </div>
 <div style="font-size:46px;font-weight:600;margin-top:56px;letter-spacing:-0.8px">The RainbowKit for onramps and deposits</div>
 <div style="font-size:26px;margin-top:22px;color:#2BE3A0">Open-source deposit infrastructure for crypto apps</div>
</div></body>`, 'logo-1200x630.png')
// previews of the svg files at 32px and full
await shot(360, 120, `${base}<body style="background:#fff;padding:12px;display:flex;gap:16px;align-items:center">${mark.replace('width="64" height="64"','width="32" height="32"')}${mark.replace('width="64" height="64"','width="16" height="16"')}${fs.readFileSync(`${dir}/logo-wordmark.svg`,'utf8').replace('width="360" height="64"','width="240" height="43"')}</body>`, '/tmp/logo-small.png', 2)
await browser.close()
