// The admin dashboard: one self-contained page at `GET {baseUrl}/admin`. Inline CSS and script with a
// CSP nonce, no external requests except the admin API on the same origin. The page has no data in it:
// it asks for the admin token, keeps it in sessionStorage only, and calls `{baseUrl}/admin/*`.
//
// A same-origin parent page (for example the playground) can set `window.openrampAdminHost` to
// `{ fetch, token?, demo? }` and show the page in an iframe. A page on another origin cannot read or set
// it, and `frame-ancestors 'none'` stops other sites from framing the page served by the server.

import { randomHex } from './crypto.js'
import type { Runtime } from './runtime.js'

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f6f8;--panel:#fff;--text:#14161a;--muted:#5b6170;--line:#dfe2e8;--accent:#2952cc;--accent-text:#fff;--ok:#1d7a3e;--warn:#9a5b00;--bad:#b42318;--chip:#eef0f4;--focus:#2952cc}
:root[data-theme=dark]{--bg:#0f1115;--panel:#171a21;--text:#e9ebef;--muted:#a3a9b6;--line:#2b303b;--accent:#8aa8ff;--accent-text:#0f1115;--ok:#5cc985;--warn:#f0b35a;--bad:#ff8a80;--chip:#232833;--focus:#8aa8ff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1115;--panel:#171a21;--text:#e9ebef;--muted:#a3a9b6;--line:#2b303b;--accent:#8aa8ff;--accent-text:#0f1115;--ok:#5cc985;--warn:#f0b35a;--bad:#ff8a80;--chip:#232833;--focus:#8aa8ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:16px;margin:0}h2{font-size:15px;margin:20px 0 8px}h3{font-size:14px;margin:16px 0 6px}
main{padding:16px;max-width:1200px;margin:0 auto}
button,select,input,textarea{font:inherit;color:inherit}
button{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:6px 12px;cursor:pointer;min-height:36px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button.danger{border-color:var(--bad);color:var(--bad)}
button:disabled{opacity:.5;cursor:not-allowed}
button.link{border:0;background:none;padding:0;min-height:0;color:var(--accent);text-decoration:underline;font-family:ui-monospace,Menlo,monospace;font-size:13px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
select,input,textarea{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:6px 8px;min-height:36px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
label.inline{flex-direction:row;align-items:center;gap:6px;color:var(--text);font-size:14px}
.banner{background:var(--warn);color:#fff;padding:8px 16px;font-weight:600}
:root[data-theme=dark] .banner{color:#14161a}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.card b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.card span{color:var(--muted);font-size:12px}
.card.warn b{color:var(--warn)}.card.bad b{color:var(--bad)}
.table-wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:640px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:0}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);font-size:12px}
.chip.succeeded{color:var(--ok)}.chip.failed,.chip.canceled,.chip.refunded,.chip.reversed{color:var(--bad)}.chip.expired{color:var(--muted)}.chip.stuck,.chip.requires_action{color:var(--warn)}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;white-space:normal}
#status{min-height:20px;margin:8px 0;color:var(--muted)}
#status.error{color:var(--bad)}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);padding:0;width:min(720px,100vw);max-width:100vw;max-height:100vh;margin:0 0 0 auto;height:100vh}
dialog::backdrop{background:rgba(0,0,0,.4)}
.drawer-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}
.drawer-body{padding:0 16px 24px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:8px 0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
ol.timeline{list-style:none;padding:0;margin:0;border-left:2px solid var(--line)}
ol.timeline li{padding:4px 0 4px 12px}
.box{border:1px solid var(--line);border-radius:10px;padding:12px;margin:8px 0}
.login{max-width:420px;margin:48px auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}
.login form{display:flex;flex-direction:column;gap:12px}
textarea{min-height:72px;width:100%}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){header{padding:10px 16px}main{padding:12px 16px}dialog{width:100vw;border-radius:0}}
`

const SCRIPT = `
const cfg = JSON.parse(document.getElementById('openramp-admin').textContent)
const KEY = 'openramp-admin-token'
let host = null
try { if (window.parent !== window && window.parent.openrampAdminHost) host = window.parent.openrampAdminHost } catch (e) { host = null }
const doFetch = host && host.fetch ? host.fetch : (u, o) => fetch(u, o)
const $ = (id) => document.getElementById(id)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}
const store = {
  get() { try { return sessionStorage.getItem(KEY) || '' } catch (e) { return '' } },
  set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY) } catch (e) {} },
}
let token = store.get() || (host && host.token) || ''
let cursor = null
let current = null
function say(text, error) { const s = $('status'); s.textContent = text || ''; s.className = error ? 'error' : '' }
async function api(path, opts) {
  const res = await doFetch(cfg.api + path, { ...(opts || {}), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } })
  let body = null
  try { body = await res.json() } catch (e) { body = null }
  if (res.status === 401) { signOut('The token is wrong. Enter it again.'); throw new Error('unauthorized') }
  if (!res.ok) throw new Error((body && body.error && body.error.message) || ('HTTP ' + res.status))
  return body
}
function age(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return m + ' min'
  const hrs = Math.floor(m / 60)
  if (hrs < 48) return hrs + ' h'
  return Math.floor(hrs / 24) + ' d'
}
const time = (s) => (s ? new Date(s).toLocaleString() : '-')
const chip = (text, cls) => h('span', { class: 'chip ' + (cls || '') }, text)
function amountText(a) { if (!a) return '-'; const asset = a.asset || {}; return a.value + ' ' + (asset.currency || asset.symbol || (asset.token ? asset.token.slice(0, 10) : '')) }

function signOut(message) {
  token = ''
  store.set('')
  $('app').hidden = true
  $('login').hidden = false
  $('login-error').textContent = message || ''
  $('token').value = ''
  $('token').focus()
}
async function signIn(value) {
  token = value
  try {
    await api('/stats')
  } catch (e) {
    if (e.message !== 'unauthorized') $('login-error').textContent = e.message
    return
  }
  store.set(value)
  $('login').hidden = true
  $('app').hidden = false
  refresh()
}

function card(label, value, cls) { return h('div', { class: 'card ' + (cls || '') }, h('b', null, String(value)), h('span', null, label)) }
async function loadStats() {
  const s = await api('/stats')
  const failed = (s.byStatus.failed || 0) + (s.byStatus.refunded || 0) + (s.byStatus.canceled || 0)
  $('cards').replaceChildren(
    card('Sessions in 24 h', s.total + (s.truncated ? '+' : '')),
    card('Succeeded', s.byStatus.succeeded || 0),
    card('Open or processing', (s.byStatus.requires_payment_method || 0) + (s.byStatus.processing || 0)),
    card('Waiting for the user', s.byStatus.requires_action || 0),
    card('Stuck after ' + s.stuck.afterMinutes + ' min', s.stuck.count, s.stuck.count ? 'warn' : ''),
    card('Failed, canceled or refunded', failed, failed ? 'bad' : ''),
    card('Reversed after success', s.byStatus.reversed || 0, s.byStatus.reversed ? 'bad' : ''),
    card('Dead letters', s.outbox.deadLetters, s.outbox.deadLetters ? 'bad' : ''),
    card('Webhook failures', s.webhookFailures, s.webhookFailures ? 'warn' : ''),
    card('Outbox queue', s.outbox.queued),
    card('Deposits', s.byDirection.deposit.total),
    card('Withdrawals', s.byDirection.withdraw.total),
  )
  const vol = s.succeededVolume
  $('volume').replaceChildren(vol.length ? h('ul', null, vol.map((v) => h('li', null, v.direction + ': ' + v.amount + ' ' + v.currency + ' (' + v.count + ')'))) : h('p', { class: 'muted' }, 'No succeeded volume in 24 h.'))
}

function query() {
  const p = new URLSearchParams({ limit: '50' })
  if ($('f-direction').value) p.set('direction', $('f-direction').value)
  if ($('f-state').value) p.set('state', $('f-state').value)
  if ($('f-stuck').checked) p.set('stuck', '1')
  return p
}
function row(s) {
  return h('tr', null,
    h('td', null, h('button', { class: 'link', type: 'button', 'aria-label': 'Open session ' + s.id, onclick: () => openDrawer(s.id) }, s.id)),
    h('td', null, s.direction),
    h('td', null, chip(s.status, s.status), ' ', s.stuck ? chip('stuck', 'stuck') : '', s.resolved ? chip('resolved') : ''),
    h('td', { class: 'muted' }, s.state),
    h('td', null, s.amount ? s.amount + ' ' + (s.currency || '') : '-'),
    h('td', null, s.method || '-'),
    h('td', null, s.provider || '-'),
    h('td', null, age(s.ageMs)),
    h('td', { class: 'muted' }, time(s.updatedAt)),
    h('td', null, s.deadLetters ? chip(String(s.deadLetters), 'failed') : '0'),
  )
}
async function loadSessions(more) {
  const p = query()
  if (more && cursor) p.set('cursor', cursor)
  const r = await api('/sessions?' + p.toString())
  const body = $('rows')
  if (!more) body.replaceChildren()
  for (const s of r.sessions) body.append(row(s))
  if (!body.children.length) body.append(h('tr', null, h('td', { colspan: '10', class: 'muted' }, 'No sessions match these filters.')))
  cursor = r.nextCursor || null
  $('more').hidden = !cursor
  say('Sessions shown: ' + body.querySelectorAll('button.link').length + '.')
}
async function refresh() {
  say('Loading...')
  try {
    await Promise.all([loadStats(), loadSessions(false)])
  } catch (e) {
    if (e.message !== 'unauthorized') say(e.message, true)
  }
}

function feesText(fees) { return (fees || []).map((f) => (f.amount ? amountText(f.amount) : 'amount not given') + ' ' + f.label + (f.included ? '' : ' (on top)')).join(', ') || '-' }
function dl(pairs) { return h('dl', null, pairs.filter((p) => p[1] !== undefined && p[1] !== '').flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) }
function legsTable(p) {
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('caption', { class: 'sr' }, 'Legs of attempt ' + p.attempt),
    h('thead', null, h('tr', null, ['#', 'Adapter', 'Status', 'Input', 'Output', 'Fees', 'Ref', 'Tx'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', null, p.legs.map((l, i) => h('tr', null,
      h('td', null, String(i)), h('td', null, l.adapterId),
      h('td', null, chip(l.status, l.status), l.error ? h('div', { class: 'muted' }, l.error.code) : ''),
      h('td', null, amountText(l.input)), h('td', null, amountText(l.output), l.outputConfirmed ? '' : h('span', { class: 'muted' }, ' (quoted)'), l.delivery && l.delivery.status !== 'ok' ? h('div', null, chip(l.delivery.status === 'short' ? 'short by ' + l.delivery.shortfall : l.delivery.status.replace('_', ' '), 'failed')) : ''),
      h('td', null, feesText(l.fees)),
      h('td', { class: 'mono' }, (l.ref || '-') + (l.providerRef && l.providerRef !== l.ref ? ' / ' + l.providerRef : '')), h('td', { class: 'mono' }, (l.transactions || []).map((t) => t.role + ': ' + t.hash).join(', ') || '-'),
    ))),
  ))
}
function payment(p, title) {
  return h('div', { class: 'box' }, h('h3', null, title), dl([['Method', p.method], ['Provider', p.provider], ['Current leg', String(p.legIndex)], ['Ended', p.endedAt ? time(p.endedAt) : undefined]]), legsTable(p))
}
function renderDetail(s) {
  current = s
  $('drawer-title').textContent = s.id
  const body = $('drawer-body')
  const dead = s.outbox.filter((e) => e.dead).length
  const resolveBox = h('div', { class: 'box' },
    h('h3', null, 'Actions'),
    h('div', { class: 'row' },
      h('button', { type: 'button', id: 'replay', onclick: replay }, 'Replay webhooks (' + dead + ' dead)'),
    ),
    h('form', { id: 'resolve-form', onsubmit: (e) => { e.preventDefault(); askResolve() } },
      h('h3', null, 'Resolve'),
      h('div', { class: 'row' },
        h('label', null, 'Final state', h('select', { id: 'r-state', required: true }, ['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED'].map((v) => h('option', { value: v }, v)))),
      ),
      h('label', null, 'Audit note (required)', h('textarea', { id: 'r-note', required: true, maxlength: '500' })),
      h('div', { class: 'row', id: 'r-actions' }, h('button', { type: 'submit', class: 'danger' }, 'Resolve')),
    ),
  )
  body.replaceChildren(
    dl([
      ['Direction', s.direction], ['Status', s.status], ['State', s.state + (s.step.detail ? ' / ' + s.step.detail.code + (s.step.detail.providerStatus ? ' (' + s.step.detail.providerStatus + ')' : '') : '')],
      ['Error', s.step.error ? s.step.error.code + ': ' + s.step.error.message : undefined],
      ['Amount', s.amount ? s.amount + ' ' + (s.currency || '') : undefined], ['User', s.userId], ['Country', s.country],
      ['Created', time(s.createdAt)], ['Updated', time(s.updatedAt)], ['Expires', time(s.expiresAt)], ['Live', s.livemode ? 'yes' : 'no (test)'],
      ['Reversal', s.reversal ? 'Leg ' + s.reversal.index + ' (' + s.reversal.adapterId + ') ' + s.reversal.status + ' at ' + time(s.reversal.at) + ' (was ' + s.reversal.previous + ')' : undefined],
      ['Resolution', s.resolution ? s.resolution.state + ' at ' + time(s.resolution.at) + ' (was ' + s.resolution.previous + '): ' + s.resolution.note : undefined],
      ['Transactions', (s.transactions || []).map((t) => t.role + ' ' + t.hash + ' (' + t.chain + ', leg ' + t.legIndex + ', attempt ' + t.attempt + ')').join(', ') || undefined],
    ]),
    resolveBox,
    h('h2', null, 'Payment'),
    s.payment ? payment(s.payment, 'Active payment (attempt ' + s.payment.attempt + ')') : h('p', { class: 'muted' }, 'No payment started.'),
    s.attempts.length ? h('h2', null, 'Earlier attempts') : '',
    s.attempts.map((p) => payment(p, 'Attempt ' + p.attempt)),
    h('h2', null, 'Provider refs'),
    s.providerRefs.length ? h('ul', null, s.providerRefs.map((r) => h('li', { class: 'mono' }, r.adapterId + ': ' + r.ref + ' (attempt ' + r.attempt + (r.active ? ', active' : '') + ')'))) : h('p', { class: 'muted' }, 'None.'),
    h('h2', null, 'Outbox'),
    s.outbox.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('caption', { class: 'sr' }, 'Webhook outbox'),
      h('thead', null, h('tr', null, ['Event', 'Type', 'Attempts', 'Next', 'State'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, s.outbox.map((e) => h('tr', null, h('td', { class: 'mono' }, e.id), h('td', null, e.type), h('td', null, String(e.attempts)), h('td', null, time(e.nextAt)), h('td', null, e.dead ? chip('dead letter', 'failed') : chip('pending'))))),
    )) : h('p', { class: 'muted' }, 'Empty: every event was delivered.'),
    h('h2', null, 'Timeline'),
    s.timeline.length ? h('ol', { class: 'timeline' }, s.timeline.slice().reverse().map((t) => h('li', null, h('b', null, t.type), ' ', h('span', { class: 'muted' }, time(t.at)), t.detail ? h('div', { class: 'mono muted' }, JSON.stringify(t.detail)) : ''))) : h('p', { class: 'muted' }, 'No entries.'),
  )
}
async function openDrawer(id) {
  say('Loading ' + id + '...')
  try {
    renderDetail(await api('/sessions/' + encodeURIComponent(id)))
    const d = $('drawer')
    if (!d.open) d.showModal()
    say('')
  } catch (e) { if (e.message !== 'unauthorized') say(e.message, true) }
}
async function replay() {
  if (!current) return
  try {
    const r = await api('/sessions/' + encodeURIComponent(current.id) + '/replay', { method: 'POST', body: '{}' })
    say('Webhook events sent again: ' + r.queued + '.')
    await openDrawer(current.id)
  } catch (e) { if (e.message !== 'unauthorized') say(e.message, true) }
}
function askResolve() {
  const state = $('r-state').value
  const note = $('r-note').value.trim()
  if (!note) { $('r-note').focus(); say('Write an audit note first.', true); return }
  const actions = $('r-actions')
  const cancel = h('button', { type: 'button', onclick: () => { actions.replaceChildren(h('button', { type: 'submit', class: 'danger' }, 'Resolve')) } }, 'Cancel')
  const confirm = h('button', { type: 'button', class: 'danger', onclick: () => doResolve(state, note) }, 'Confirm: set ' + state)
  actions.replaceChildren(h('p', { role: 'alert' }, 'This sets ' + current.id + ' to ' + state + ' and sends the webhook. You cannot undo it.'), confirm, cancel)
  confirm.focus()
}
async function doResolve(state, note) {
  try {
    renderDetail(await api('/sessions/' + encodeURIComponent(current.id) + '/resolve', { method: 'POST', body: JSON.stringify({ state, note }) }))
    say('Session set to ' + state + '.')
    loadStats().catch(() => {})
    loadSessions(false).catch(() => {})
  } catch (e) { if (e.message !== 'unauthorized') say(e.message, true) }
}
async function find(e) {
  e.preventDefault()
  const v = $('find-value').value.trim()
  if (!v) return
  try {
    if (v.startsWith('ors_')) return openDrawer(v)
    const p = new URLSearchParams()
    if (/^0x[0-9a-fA-F]{64}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v)) p.set('tx', v)
    else { const i = v.indexOf(':'); if (i < 1) { say('Enter a session id, a tx hash, or provider:ref.', true); return } p.set('provider', v.slice(0, i)); p.set('ref', v.slice(i + 1)) }
    const r = await api('/find?' + p.toString())
    if (!r.sessions.length) { say('Nothing found.', true); return }
    if (r.sessions.length === 1) return openDrawer(r.sessions[0].id)
    $('rows').replaceChildren(...r.sessions.map(row)); $('more').hidden = true
    say('Sessions found: ' + r.sessions.length + '.')
  } catch (err) { if (err.message !== 'unauthorized') say(err.message, true) }
}

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
  try { localStorage.setItem('openramp-admin-theme', t || '') } catch (e) {}
  $('theme').textContent = 'Theme: ' + (t || 'auto')
}
try { setTheme(localStorage.getItem('openramp-admin-theme') || '') } catch (e) { setTheme('') }
$('theme').addEventListener('click', () => { const t = document.documentElement.dataset.theme; setTheme(t === 'light' ? 'dark' : t === 'dark' ? '' : 'light') })
if (host && host.demo) { $('demo').hidden = false; $('demo').textContent = host.demo }
$('login-form').addEventListener('submit', (e) => { e.preventDefault(); signIn($('token').value.trim()) })
$('signout').addEventListener('click', () => signOut(''))
$('refresh').addEventListener('click', refresh)
$('more').addEventListener('click', () => loadSessions(true).catch((e) => say(e.message, true)))
$('find').addEventListener('submit', find)
for (const id of ['f-direction', 'f-state', 'f-stuck']) $(id).addEventListener('change', () => loadSessions(false).catch((e) => say(e.message, true)))
$('drawer-close').addEventListener('click', () => $('drawer').close())
if (token) signIn(token); else signOut('')
`

const BODY = `<div id="demo" class="banner" role="note" hidden></div>
<header><h1>OpenRampKit admin</h1><div class="row"><button type="button" id="theme">Theme: auto</button></div></header>
<section id="login" class="login" aria-labelledby="login-title" hidden>
<h2 id="login-title">Sign in</h2>
<form id="login-form"><label for="token">Admin token<input id="token" type="password" autocomplete="off" required></label>
<button type="submit" class="primary">Sign in</button>
<p class="muted">The token stays in this browser tab (sessionStorage) and goes only to this server.</p>
<p id="login-error" role="alert"></p></form>
</section>
<main id="app" hidden>
<div class="row"><button type="button" id="refresh" class="primary">Refresh</button><button type="button" id="signout">Sign out</button></div>
<div id="status" role="status" aria-live="polite"></div>
<h2>Last 24 hours</h2>
<div id="cards" class="cards"></div>
<h3>Completed volume</h3><div id="volume"></div>
<h2>Sessions</h2>
<form id="find" class="row" role="search"><label for="find-value">Find by session id, tx hash, or provider:ref<input id="find-value" type="search" size="40"></label><button type="submit">Find</button></form>
<div class="row" role="group" aria-label="Filters">
<label for="f-direction">Direction<select id="f-direction"><option value="">All</option><option value="deposit">Deposit</option><option value="withdraw">Withdraw</option></select></label>
<label for="f-state">State<select id="f-state"><option value="">All</option><option>requires_payment_method</option><option>requires_action</option><option>processing</option><option>succeeded</option><option>failed</option><option>canceled</option><option>expired</option><option>refunded</option><option>reversed</option></select></label>
<label class="inline" for="f-stuck"><input id="f-stuck" type="checkbox">Stuck only</label>
</div>
<div class="table-wrap"><table><caption class="sr">Recent sessions, newest first</caption>
<thead><tr><th scope="col">Session</th><th scope="col">Direction</th><th scope="col">Status</th><th scope="col">State</th><th scope="col">Amount</th><th scope="col">Method</th><th scope="col">Provider</th><th scope="col">Age</th><th scope="col">Updated</th><th scope="col">Dead letters</th></tr></thead>
<tbody id="rows"></tbody></table></div>
<p><button type="button" id="more" hidden>Load more</button></p>
</main>
<dialog id="drawer" aria-labelledby="drawer-title"><div class="drawer-head"><h2 id="drawer-title" class="mono">Session</h2><button type="button" id="drawer-close">Close</button></div><div id="drawer-body" class="drawer-body"></div></dialog>`

/** JSON that is safe inside a `<script>` element */
function jsonForHtml(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

/** The dashboard HTML for one request, with a new CSP nonce */
export function adminPageHtml(rt: Runtime, nonce: string): string {
  const data = { api: `${rt.base}/admin` }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>OpenRampKit admin</title>
<style nonce="${nonce}">${STYLE}</style>
</head><body>
${BODY}
<script type="application/json" id="openramp-admin">${jsonForHtml(data)}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`
}

/** `GET {baseUrl}/admin` */
export function adminPage(rt: Runtime): Response {
  const nonce = randomHex(16)
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  return new Response(adminPageHtml(rt, nonce), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex',
      'content-security-policy': csp,
    },
  })
}
