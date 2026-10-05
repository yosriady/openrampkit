import { createMockWallet } from '@openrampkit/client'
import { METHODS } from '@openrampkit/core'
import type { OrkEvent } from '@openrampkit/core'
import { autoTheme, darkTheme, lightTheme, openDeposit, openWithdraw } from '@openrampkit/web'
import type { DepositHandle, RadiusScale, Theme, ThemeOptions } from '@openrampkit/web'
import { BASE_URL, createSession, fakeFetch, onWebhook } from './server.js'

type Options = {
  /** `mock`: mock providers (default). `testnet`: the visitor's wallet pays on a testnet for real. */
  mode: 'mock' | 'testnet'
  direction: 'deposit' | 'withdraw'
  country: string
  locale: string
  theme: 'light' | 'dark' | 'auto'
  accent: string
  radius: RadiusScale
  font: 'system' | 'serif' | 'rounded' | 'mono'
  display: 'embedded' | 'modal'
  /** Payment sources that are on, comma separated (see SOURCES) */
  sources: string
}

/** Payment sources the user can turn on or off. Each maps to method ids for the session's `allowedMethods`. */
const SOURCES: Record<string, (method: string) => boolean> = {
  wallet: (m) => m === 'wallet',
  transfer: (m) => m === 'transfer',
  exchange: (m) => m === 'exchange_transfer',
  cash: (m) => ['bank', 'qr', 'ewallet'].includes(METHODS[m]?.kind ?? ''),
  card: (m) => ['card', 'wallet_pay'].includes(METHODS[m]?.kind ?? ''),
}
const ALL_SOURCES = Object.keys(SOURCES)

const FONTS: Record<Options['font'], string | undefined> = {
  system: undefined,
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
}

const DEFAULTS: Options = {
  mode: 'mock', direction: 'deposit', country: 'VN', locale: 'en', theme: 'light', accent: '#2744c4', radius: 'large', font: 'system',
  display: 'embedded', sources: ALL_SOURCES.join(','),
}
const KEYS = Object.keys(DEFAULTS) as Array<keyof Options>
/** Keys with a single form control (sources use one checkbox per source) */
const FIELD_KEYS = KEYS.filter((k) => k !== 'sources')

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const control = (k: keyof Options) => $<HTMLInputElement | HTMLSelectElement>(k)
const sourceBoxes = () => [...document.querySelectorAll<HTMLInputElement>('input[name="source"]')]

const parseSources = (v: string) => v.split(',').filter((x) => ALL_SOURCES.includes(x))

/** The session's `allowedMethods` for the chosen sources, or undefined when all sources are on. */
function allowedMethods(o: Options): string[] | undefined {
  const on = parseSources(o.sources)
  if (on.length === ALL_SOURCES.length) return undefined
  return Object.keys(METHODS).filter((m) => on.some((src) => SOURCES[src]!(m)))
}

/** Options come from the URL, so a setup can be shared as a link. */
function readUrl(): Options {
  const q = new URLSearchParams(location.search)
  const o = { ...DEFAULTS }
  for (const k of FIELD_KEYS) {
    const v = q.get(k)
    if (v && (k === 'accent' ? /^#[0-9a-f]{6}$/i.test(v) : [...(control(k) as HTMLSelectElement).options].some((x) => x.value === v))) {
      ;(o as Record<string, string>)[k] = v
    }
  }
  const src = q.get('sources')
  if (src !== null) o.sources = parseSources(src).join(',')
  return o
}

function readControls(): Options {
  const o = {} as Record<string, string>
  for (const k of FIELD_KEYS) o[k] = control(k).value
  o.sources = sourceBoxes().filter((b) => b.checked).map((b) => b.value).join(',')
  return o as Options
}

function writeControls(o: Options) {
  for (const k of FIELD_KEYS) control(k).value = o[k]
  const on = parseSources(o.sources)
  for (const b of sourceBoxes()) b.checked = on.includes(b.value)
}

function writeUrl(o: Options) {
  const q = new URLSearchParams()
  for (const k of KEYS) if (o[k] !== DEFAULTS[k]) q.set(k, o[k])
  const s = q.toString()
  history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}`)
}

function themeOf(o: Options): Theme {
  const font = FONTS[o.font]
  const opts: ThemeOptions = { accent: o.accent, radius: o.radius, ...(font ? { fontFamily: font } : {}) }
  return o.theme === 'dark' ? darkTheme(opts) : o.theme === 'auto' ? autoTheme(opts) : lightTheme(opts)
}

/** The page follows the widget theme. `auto` follows the system setting. */
function pageMode(o: Options): 'light' | 'dark' {
  if (o.theme !== 'auto') return o.theme
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyPage(o: Options) {
  document.body.dataset.mode = pageMode(o)
  document.documentElement.style.setProperty('--accent', o.accent)
  $('code').textContent = codeFor(o)
}

function codeFor(o: Options): string {
  const allowed = allowedMethods(o)
  const allowedLine = allowed ? `\n  allowedMethods: [${allowed.map((m) => `'${m}'`).join(', ')}],` : ''
  const font = FONTS[o.font]
  const themeArgs = [`accent: '${o.accent}'`, ...(o.radius !== 'large' ? [`radius: '${o.radius}'`] : []), ...(font ? [`fontFamily: "${font}"`] : [])].join(', ')
  const server =
    o.direction === 'withdraw'
      ? `// Your server
const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  direction: 'withdraw',
  country: '${o.country}',
  locale: '${o.locale}',${allowedLine}
  source: { chain: 'eip155:8453', token: USDC_BASE, custody: 'user_wallet' },
  allowedTargets: { crypto: { chains: ['eip155:8453', 'eip155:42161'] }, fiat: {} },
})`
      : `// Your server
const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  country: '${o.country}',
  locale: '${o.locale}',${allowedLine}
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
  theme: ${o.theme}Theme({ ${themeArgs} }),
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
/** Testnet mode, when it is on (loaded on demand) */
let testnet: { restyle(t: Theme): void; stop(): void } | undefined
/** Increments on every render, to drop a testnet module that loads after the mode changed */
let renderSeq = 0

const banner = $('banner')
const demoBanner = banner.innerHTML
function setBanner(text?: string) {
  banner.classList.toggle('testnet', !!text)
  if (!text) {
    banner.innerHTML = demoBanner
    return
  }
  // The label before the first colon is bold: "Testnet:" or "Devnet:".
  const colon = text.indexOf(':')
  const strong = document.createElement('strong')
  strong.textContent = colon > 0 ? text.slice(0, colon + 1) : ''
  banner.replaceChildren(strong, colon > 0 ? text.slice(colon + 1) : text)
}

function open(o: Options, container?: HTMLElement): DepositHandle {
  const opts = {
    baseUrl: BASE_URL,
    fetch: fakeFetch,
    clientSecret: () => {
      const allowed = allowedMethods(o)
      return createSession({ direction: o.direction, country: o.country, locale: o.locale, ...(allowed ? { allowedMethods: allowed } : {}) })
    },
    wallet: createMockWallet(),
    theme: themeOf(o),
    locale: o.locale,
    onEvent: logEvent,
    ...(container ? { container, embedded: true } : {}),
  }
  return o.direction === 'withdraw' ? openWithdraw(opts) : openDeposit(opts)
}

function render(o: Options) {
  applyPage(o)
  current?.close()
  current = undefined
  testnet?.stop()
  testnet = undefined
  const seq = ++renderSeq
  const isTestnet = o.mode === 'testnet'
  $('testnet-setup').hidden = !isTestnet
  $('mock-setup').hidden = isTestnet
  $('mock-hint').hidden = isTestnet
  if (isTestnet) {
    $('open').hidden = true
    $('widget').replaceChildren()
    void import('./testnet/ui.js').then(({ startTestnet }) => {
      if (seq !== renderSeq) return
      testnet = startTestnet({
        container: $('widget'),
        theme: themeOf(o),
        locale: o.locale,
        onEvent: logEvent,
        setBanner,
        setCode: (text) => ($('code').textContent = text),
      })
    })
    return
  }
  setBanner()
  $('tn-result').hidden = true
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
writeControls(initial)
render(initial)

/** Changes that only restyle the open widget. Other changes start a new session. */
const STYLE_KEYS: Array<keyof Options> = ['theme', 'accent', 'radius', 'font']

let prev = initial
function onChange() {
  const o = readControls()
  writeUrl(o)
  const restyleOnly = KEYS.every((x) => STYLE_KEYS.includes(x) || o[x] === prev[x])
  prev = o
  if (restyleOnly && (current || testnet)) {
    if (current) current.element.theme = themeOf(o)
    testnet?.restyle(themeOf(o))
    const code = $('code').textContent
    applyPage(o)
    // Testnet mode shows its own code.
    if (testnet) $('code').textContent = code
  } else {
    render(o)
  }
}
for (const k of FIELD_KEYS) control(k).addEventListener(k === 'accent' ? 'input' : 'change', onChange)
for (const b of sourceBoxes()) b.addEventListener('change', onChange)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (prev.theme === 'auto') document.body.dataset.mode = pageMode(prev)
})
