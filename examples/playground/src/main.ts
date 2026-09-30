import { createMockWallet } from '@openrampkit/client'
import type { OrkEvent } from '@openrampkit/core'
import { darkTheme, lightTheme, openDeposit, openWithdraw } from '@openrampkit/web'
import type { DepositHandle } from '@openrampkit/web'
import { BASE_URL, createSession, fakeFetch, onWebhook } from './server.js'

type Options = {
  direction: 'deposit' | 'withdraw'
  country: string
  locale: string
  theme: 'light' | 'dark'
  accent: string
  display: 'embedded' | 'modal'
}

const DEFAULTS: Options = { direction: 'deposit', country: 'VN', locale: 'en', theme: 'light', accent: '#2744c4', display: 'embedded' }
const KEYS = Object.keys(DEFAULTS) as Array<keyof Options>

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const control = (k: keyof Options) => $<HTMLInputElement | HTMLSelectElement>(k)

/** Options come from the URL, so a setup can be shared as a link. */
function readUrl(): Options {
  const q = new URLSearchParams(location.search)
  const o = { ...DEFAULTS }
  for (const k of KEYS) {
    const v = q.get(k)
    if (v && (k === 'accent' ? /^#[0-9a-f]{6}$/i.test(v) : [...(control(k) as HTMLSelectElement).options].some((x) => x.value === v))) {
      ;(o as Record<string, string>)[k] = v
    }
  }
  return o
}

function readControls(): Options {
  const o = {} as Record<string, string>
  for (const k of KEYS) o[k] = control(k).value
  return o as Options
}

function writeUrl(o: Options) {
  const q = new URLSearchParams()
  for (const k of KEYS) if (o[k] !== DEFAULTS[k]) q.set(k, o[k])
  const s = q.toString()
  history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}`)
}

const themeOf = (o: Options) => (o.theme === 'dark' ? darkTheme({ accent: o.accent }) : lightTheme({ accent: o.accent }))

function codeFor(o: Options): string {
  const server =
    o.direction === 'withdraw'
      ? `// Your server
const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  direction: 'withdraw',
  country: '${o.country}',
  locale: '${o.locale}',
  source: { chain: 'eip155:8453', token: USDC_BASE, custody: 'user_wallet' },
  allowedTargets: { crypto: { chains: ['eip155:8453', 'eip155:42161'] }, fiat: {} },
})`
      : `// Your server
const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  country: '${o.country}',
  locale: '${o.locale}',
  destination: {
    type: 'crypto',
    chain: 'eip155:8453', // Base
    token: USDC_BASE,
    address: user.depositAddress,
  },
})`
  const fn = o.direction === 'withdraw' ? 'openWithdraw' : 'openDeposit'
  const client = `// Your page
import { ${fn}, ${o.theme}Theme } from '@openrampkit/web'

const handle = ${fn}({
  baseUrl: '/api/openramp',
  clientSecret: () => getClientSecret(),
  theme: ${o.theme}Theme({ accent: '${o.accent}' }),
  locale: '${o.locale}',${o.display === 'embedded' ? `\n  embedded: true,\n  container: document.querySelector('#${o.direction}'),` : ''}
  onEvent: (e) => console.log(e.type),
})
const session = await handle.done`
  return `${server}\n\n${client}`
}

/** A log line from parts: [text, tag, class]. Text only, no HTML. */
function li(parts: Array<[string, 'code' | 'span' | 'small', string?]>): HTMLLIElement {
  const el = document.createElement('li')
  parts.forEach(([text, tag, cls], i) => {
    if (i) el.append(' ')
    const part = document.createElement(tag)
    part.textContent = text
    if (cls) part.className = cls
    el.append(part)
  })
  return el
}

function push(listId: string, item: HTMLLIElement) {
  const list = $(listId)
  list.prepend(item)
  while (list.children.length > 40) list.lastElementChild?.remove()
}

const logEvent = (e: OrkEvent) => {
  const state = (e.data.object as { state?: unknown } | undefined)?.state
  push('events', li(typeof state === 'string' ? [[e.type, 'code'], [state, 'small']] : [[e.type, 'code']]))
}

onWebhook((w) =>
  push('webhooks', li([[w.type, 'code'], [w.verified ? 'signature ok' : 'bad signature', 'span', w.verified ? 'ok' : 'bad'], [w.sessionId ?? '', 'small']])),
)

let current: DepositHandle | undefined

function open(o: Options, container?: HTMLElement): DepositHandle {
  const opts = {
    baseUrl: BASE_URL,
    fetch: fakeFetch,
    clientSecret: () => createSession({ direction: o.direction, country: o.country, locale: o.locale }),
    wallet: createMockWallet(),
    theme: themeOf(o),
    locale: o.locale,
    onEvent: logEvent,
    ...(container ? { container, embedded: true } : {}),
  }
  return o.direction === 'withdraw' ? openWithdraw(opts) : openDeposit(opts)
}

function render(o: Options) {
  document.body.dataset.mode = o.theme
  document.documentElement.style.setProperty('--accent', o.accent)
  $('code').textContent = codeFor(o)
  current?.close()
  current = undefined
  const btn = $<HTMLButtonElement>('open')
  btn.textContent = o.direction === 'withdraw' ? 'Withdraw' : 'Deposit'
  btn.hidden = o.display !== 'modal'
  if (o.display === 'embedded') current = open(o, $('widget'))
}

$('open').addEventListener('click', () => {
  current?.close()
  current = open(readControls())
})

const initial = readUrl()
for (const k of KEYS) control(k).value = initial[k]
render(initial)

let prev = initial
for (const k of KEYS) {
  control(k).addEventListener(k === 'accent' ? 'input' : 'change', () => {
    const o = readControls()
    writeUrl(o)
    // Theme and accent changes restyle the open widget. Other changes start a new session.
    const restyleOnly = KEYS.every((x) => x === 'theme' || x === 'accent' || o[x] === prev[x])
    prev = o
    if (restyleOnly && current) {
      current.element.theme = themeOf(o)
      document.body.dataset.mode = o.theme
      document.documentElement.style.setProperty('--accent', o.accent)
      $('code').textContent = codeFor(o)
    } else {
      render(o)
    }
  })
}
