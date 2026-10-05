import type { ProviderRenderer } from './provider-sdk.js'
import { html, LitElement, nothing } from 'lit'
import type { PropertyValues, TemplateResult } from 'lit'
import { live } from 'lit/directives/live.js'
import { isValidTargetAddress } from '@openrampkit/client'
import type { DepositController, Snapshot, Tab } from '@openrampkit/client'
import { isAddressTransfer, isWebUrl, methodName } from '@openrampkit/core'
import type { FieldSpec, MethodOption, OrkError, Quote, Step, Surface, Transition } from '@openrampkit/core'
import { displayChain, formatAmount, formatCountdown, formatEta, formatFiat, formatToken, shortAddress, titleCase } from './format.js'
import { icons, methodIcon } from './icons.js'
import { resolveMessages } from './messages.js'
import type { Messages } from './messages.js'
import { qrPath } from './qr.js'
import { styles } from './styles.js'
import { themeVariables } from './theme.js'
import type { Appearance, Theme } from './theme.js'
import {
  amountModel,
  classifyIframeMessage,
  groupLabel,
  iframeOrigin,
  groupMethods,
  liveText,
  methodSubtitle,
  methodTabs,
  nextQuoteId,
  quoteSubtitle,
  resolveMode,
  screenOf,
  screenTitle,
  sourceForChain,
  stepKey,
  transferChains,
  transferTokens,
} from './view.js'

export const TAG_NAME = 'openramp-modal'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, a[href], [tabindex]:not([tabindex="-1"])'

const qrCache = new Map<string, { size: number; path: string }>()
function cachedQr(text: string) {
  let v = qrCache.get(text)
  if (!v) {
    v = qrPath(text)
    if (qrCache.size > 20) qrCache.clear()
    qrCache.set(text, v)
  }
  return v
}

/**
 * `<openramp-modal>`: renders a `DepositController` snapshot and calls its actions.
 * It never talks to the server itself.
 *
 * Events: `openramp-close` (bubbles, composed) when the user closes it. `detail.session` holds the last session.
 */
export class OpenRampModal extends LitElement {
  static override styles = styles

  static override properties = {
    controller: { attribute: false },
    theme: { attribute: false },
    appearance: { attribute: false },
    messages: { attribute: false },
    locale: { type: String },
    error: { attribute: false },
    open: { type: Boolean, reflect: true },
    embedded: { type: Boolean, reflect: true },
    providerRenderers: { attribute: false },
    _snap: { state: true },
    _sdkError: { state: true },
    _copied: { state: true },
    _now: { state: true },
    _openedUrl: { state: true },
    _systemDark: { state: true },
  }

  declare controller: DepositController | undefined
  declare theme: Theme | undefined
  declare appearance: Appearance | undefined
  /** Partial message catalog. Overrides the locale catalog key by key. */
  declare messages: Partial<Messages> | undefined
  /**
   * BCP 47 locale, e.g. `vi` or `th-TH`. Picks the built-in catalog (en, vi, id, th, ms, fil) and the
   * number format. Default: the session locale, then English.
   */
  declare locale: string | undefined
  /** Error shown when there is no controller (for example the client secret could not load) */
  declare error: OrkError | undefined
  declare open: boolean
  declare embedded: boolean
  /**
   * Renderers for PROVIDER_SDK surfaces, keyed by provider id (e.g. `{ stripe: stripeOnrampRenderer() }`).
   * Without one, the modal uses the surface's `redirectUrl` when it has one.
   */
  declare providerRenderers: Record<string, ProviderRenderer> | undefined
  declare private _sdkError: string | undefined

  declare private _snap: Snapshot | undefined
  declare private _copied: string | undefined
  declare private _now: number
  declare private _openedUrl: string | undefined
  declare private _systemDark: boolean

  private _unsub: (() => void) | undefined
  private _subscribed: DepositController | undefined
  private _closedController: DepositController | undefined
  private _media: MediaQueryList | undefined
  private _copyTimer: ReturnType<typeof setTimeout> | undefined
  private _tick: ReturnType<typeof setInterval> | undefined
  private _form: Record<string, unknown> = {}
  private _stepKey = ''
  private _lastScreen = ''
  private _hadFocus = false
  private _returnFocus: HTMLElement | null = null
  private _listening = false
  private _docKeys = false
  private _sdkMounted: string | undefined
  private _sdkCleanup: (() => void) | undefined

  constructor() {
    super()
    this.open = false
    this.embedded = false
    this._now = Date.now()
    this._systemDark = false
  }

  // ---------- lifecycle ----------

  override connectedCallback(): void {
    super.connectedCallback()
    if (typeof window !== 'undefined' && window.matchMedia) {
      this._media = window.matchMedia('(prefers-color-scheme: dark)')
      this._systemDark = this._media.matches
      this._media.addEventListener?.('change', this._onMedia)
    }
    this._subscribe()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this._media?.removeEventListener?.('change', this._onMedia)
    this._unsub?.()
    this._unsub = undefined
    this._subscribed = undefined
    clearInterval(this._tick)
    this._tick = undefined
    clearTimeout(this._copyTimer)
    this._syncMessageListener(false)
    this._syncDocKeys(false)
    this._unmountSdk()
  }

  private _onMedia = (e: MediaQueryListEvent) => {
    this._systemDark = e.matches
  }

  private _subscribe() {
    const c = this.controller
    if (c === this._subscribed && this._unsub) return
    this._unsub?.()
    this._unsub = undefined
    this._subscribed = c
    this._snap = c?.getSnapshot()
    if (!c || !this.isConnected) return
    this._unsub = c.subscribe(() => {
      this._snap = c.getSnapshot()
    })
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('controller')) this._subscribe()
    if (changed.has('theme') || changed.has('appearance') || changed.has('_systemDark')) this._applyTheme()
    if (changed.has('open') && this.open && !this.embedded && typeof document !== 'undefined') {
      const active = document.activeElement
      this._returnFocus = active instanceof HTMLElement && active !== this ? active : null
    }
    const step = this._snap?.session?.step
    const key = stepKey(step)
    if (key !== this._stepKey) {
      this._stepKey = key
      this._form = {}
    }
    this._syncTicker(step)
  }

  protected override firstUpdated(): void {
    this._applyTheme()
  }

  protected override updated(changed: PropertyValues): void {
    this._syncMessageListener(!!this._iframeSurface)
    this._syncDocKeys(this.open && !this.embedded && this.isConnected)
    this._syncProviderSdk()
    if (!this._visible) return
    const screen = this._screen
    const openedNow = changed.has('open') && this.open
    if (openedNow || screen !== this._lastScreen) {
      this._lastScreen = screen
      // Embedded mode: do not steal focus from the host page until the user works inside the element.
      if (this.embedded && !this._hadFocus) return
      // Move focus to the new screen's heading so keyboard and screen reader users follow along.
      const root = this.renderRoot as ShadowRoot
      ;(root.querySelector<HTMLElement>('.title') ?? root.querySelector<HTMLElement>('.card'))?.focus({ preventScroll: true })
    }
  }

  // ---------- provider SDK surfaces ----------

  /** Mount the provider renderer once per step; unmount when the step changes. */
  private _syncProviderSdk() {
    const surface = this._snap?.session?.step.surface
    const renderer = surface?.kind === 'PROVIDER_SDK' ? this.providerRenderers?.[surface.provider] : undefined
    const key = surface?.kind === 'PROVIDER_SDK' && renderer ? `${this._stepKey}|${surface.provider}` : undefined
    if (key === this._sdkMounted) return
    this._unmountSdk()
    if (!key || !renderer || surface?.kind !== 'PROVIDER_SDK') return
    const container = (this.renderRoot as ShadowRoot).querySelector<HTMLElement>('.provider-sdk')
    if (!container) return
    this._sdkMounted = key
    this._sdkError = undefined
    const c = this.controller
    const mode = this.theme?.mode === 'dark' || (this.theme?.mode === 'auto' && this._systemDark) ? 'dark' : 'light'
    Promise.resolve(
      renderer(container, {
        surface,
        mode,
        completed: (detail) => c?.notifySurface('completed', detail),
        failed: (detail) => c?.notifySurface('failed', detail),
      }),
    )
      .then((cleanup) => {
        if (this._sdkMounted === key && typeof cleanup === 'function') this._sdkCleanup = cleanup
        else if (typeof cleanup === 'function') cleanup()
      })
      .catch((e: unknown) => {
        if (this._sdkMounted === key) this._sdkError = e instanceof Error ? e.message : String(e)
      })
  }

  private _unmountSdk() {
    const cleanup = this._sdkCleanup
    this._sdkCleanup = undefined
    this._sdkMounted = undefined
    try {
      cleanup?.()
    } catch {
      /* provider cleanup errors must not break the modal */
    }
  }

  // ---------- provider iframe messages ----------

  /** The IFRAME surface on screen, if any. Messages are only read while it is shown. */
  private get _iframeSurface(): Extract<Surface, { kind: 'IFRAME' }> | undefined {
    const s = this._snap
    const surface = s?.session?.step.surface
    if (!this._visible || !this.isConnected || s?.screen !== 'step' || s.surfaceClosed || surface?.kind !== 'IFRAME') return undefined
    return surface
  }

  private _syncMessageListener(on: boolean) {
    if (typeof window === 'undefined' || on === this._listening) return
    this._listening = on
    if (on) window.addEventListener('message', this._onMessage)
    else window.removeEventListener('message', this._onMessage)
  }

  /**
   * A `message` event from the provider iframe. Security rules:
   * - `event.origin` must equal the allowed origin exactly (`surface.messages.origin`, else `surface.origin`).
   * - `event.source` must be this element's iframe window, so other frames on the page cannot pretend.
   * - A message never decides the outcome. It only asks the controller to check the server status now.
   */
  private _onMessage = (e: MessageEvent) => {
    const surface = this._iframeSurface
    if (!surface) return
    const origin = iframeOrigin(surface)
    if (!origin || e.origin !== origin) return
    const frame = this.renderRoot.querySelector<HTMLIFrameElement>('iframe.provider')
    if (!frame?.contentWindow || e.source !== frame.contentWindow) return
    const kind = classifyIframeMessage(e.data, surface.messages)
    if (kind) this.controller?.notifySurface(kind, { origin })
  }

  private _applyTheme() {
    const mode = resolveMode(this.theme, this._systemDark)
    this.setAttribute('data-mode', mode)
    const vars = themeVariables(this.theme, this.appearance, mode)
    for (const [k, v] of Object.entries(vars)) this.style.setProperty(k, v)
  }

  private _syncTicker(step: Step | undefined) {
    const s = step?.surface
    const needs = this._snap?.screen === 'step' && s?.kind === 'QR' && !!s.expiresAt
    if (needs && !this._tick) {
      this._now = Date.now()
      this._tick = setInterval(() => (this._now = Date.now()), 1000)
    } else if (!needs && this._tick) {
      clearInterval(this._tick)
      this._tick = undefined
    }
  }

  // ---------- public API ----------

  /** Close the modal: tells the controller, hides the element and fires `openramp-close`. */
  close() {
    const c = this.controller
    if (c && this._closedController !== c) {
      this._closedController = c
      c.close()
    }
    this.open = false
    this.dispatchEvent(
      new CustomEvent('openramp-close', { bubbles: true, composed: true, detail: { session: c?.getSnapshot().session } }),
    )
    const back = this._returnFocus
    this._returnFocus = null
    if (back) restoreFocus(back)
  }

  // ---------- helpers ----------

  private get _m(): Messages {
    return resolveMessages({ locale: this.locale, sessionLocale: this._snap?.session?.locale, messages: this.messages })
  }

  private get _visible() {
    return this.open || this.embedded
  }

  private get _screen(): string {
    return screenOf(this._snap, this.error)
  }

  private get _selectedQuote(): Quote | undefined {
    const s = this._snap
    return s?.quotes.find((q) => q.id === s.selectedQuoteId)
  }

  private async _copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      this.renderRoot.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* ignore */
      }
      ta.remove()
    }
    this._copied = key
    clearTimeout(this._copyTimer)
    this._copyTimer = setTimeout(() => (this._copied = undefined), 1600)
  }

  private _focusables(): HTMLElement[] {
    const card = this.renderRoot.querySelector('.card')
    if (!card) return []
    // Visible and in the Tab order (roving tabindex leaves unselected tabs and quotes out)
    return [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)
  }

  private _onKeydown = (e: KeyboardEvent) => {
    if (this.embedded) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      this.close()
      return
    }
    if (e.key !== 'Tab') return
    const items = this._focusables()
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) {
      e.preventDefault()
      return
    }
    // The dialog moves focus itself: it stays inside, and every control is reached even where the
    // browser's own Tab skips buttons (Safari without "Press Tab to highlight each item").
    e.preventDefault()
    const i = items.indexOf((this.renderRoot as ShadowRoot).activeElement as HTMLElement)
    const next = i < 0 ? (e.shiftKey ? last : first) : items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length]!
    next.focus()
  }

  /** Page-level keys while the modal is open, for when focus is outside the card (for example on the page body). */
  private _syncDocKeys(on: boolean) {
    if (typeof document === 'undefined' || on === this._docKeys) return
    this._docKeys = on
    if (on) document.addEventListener('keydown', this._onDocKeydown)
    else document.removeEventListener('keydown', this._onDocKeydown)
  }

  private _onDocKeydown = (e: KeyboardEvent) => {
    // Keys inside the element go through the card's own handler.
    if (!this.open || this.embedded || e.defaultPrevented || e.composedPath().includes(this)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    } else if (e.key === 'Tab') {
      // Bring focus back into the dialog instead of the page behind it.
      e.preventDefault()
      const items = this._focusables()
      ;(e.shiftKey ? items[items.length - 1] : items[0])?.focus()
    }
  }

  private _onOverlayClick = (e: MouseEvent) => {
    if (e.target !== e.currentTarget) return
    // Do not close by accident while a payment step is on screen.
    if (this._screen === 'step') return
    this.close()
  }

  // ---------- render ----------

  override render() {
    if (!this._visible) return nothing
    const m = this._m
    const a = this.appearance
    const card = html`
      <div
        class="card"
        part="card"
        role=${this.embedded ? 'region' : 'dialog'}
        aria-modal=${this.embedded ? nothing : 'true'}
        aria-labelledby="ork-title"
        lang=${m.locale}
        aria-busy=${this._snap?.busy || this._screen === 'loading' ? 'true' : 'false'}
        tabindex="-1"
        @keydown=${this._onKeydown}
        @focusin=${() => (this._hadFocus = true)}
      >
        ${this._renderHeader(m)}
        <div class="body" part="body">${this._renderScreen(m)}</div>
        ${a?.hideFooter ? nothing : html`<div class="footer" part="footer">${m.poweredBy}</div>`}
        <div class="sr-only" role="status">${liveText(this._snap, this.error, m)}</div>
        <div class="sr-only" role="status">${this._copied ? m.copied : ''}</div>
      </div>
    `
    if (this.embedded) return card
    return html`<div class="overlay" part="overlay" @click=${this._onOverlayClick}>${card}</div>`
  }

  private _renderHeader(m: Messages) {
    const screen = this._screen
    const canBack = screen === 'amount' || screen === 'quotes'
    const a = this.appearance
    const showLogo = !!a?.logoUrl && (screen === 'methods' || screen === 'loading')
    return html`
      <div class="header" part="header">
        ${canBack
          ? html`<button class="icon-btn" type="button" aria-label=${m.back} @click=${() => this.controller?.back()}>
              ${icons.back}
            </button>`
          : html`<span></span>`}
        <div class="title-wrap">
          ${showLogo ? html`<img class="logo" src=${a!.logoUrl!} alt=${a?.merchantName ?? ''} />` : nothing}
          <h2 class="title" id="ork-title" tabindex="-1">${screenTitle(this._snap, m, a)}</h2>
        </div>
        ${this.embedded
          ? html`<span></span>`
          : html`<button class="icon-btn" type="button" aria-label=${m.close} @click=${() => this.close()}>${icons.close}</button>`}
      </div>
    `
  }

  private _renderScreen(m: Messages): TemplateResult {
    const s = this._snap
    if (!s || !this.controller) return this.error ? this._renderError(m, this.error, false) : this._renderLoading(m)
    switch (s.screen) {
      case 'loading':
        return this._renderLoading(m)
      case 'target':
        return this._renderTarget(m, s)
      case 'methods':
        return s.direction === 'withdraw' ? this._renderWithdrawMethods(m, s) : this._renderMethods(m, s)
      case 'amount':
        return this._renderAmount(m, s)
      case 'quotes':
        return this._renderQuotes(m, s)
      case 'step':
        return this._renderStep(m, s)
      case 'result':
        return this._renderResult(m, s)
      case 'error':
      default:
        return this._renderError(m, s.error, true)
    }
  }

  private _renderLoading(m: Messages) {
    return html`
      <span class="sr-only">${m.loading}</span>
      <div aria-hidden="true">
        <div class="skeleton" style="height:40px;margin-bottom:12px"></div>
        <div class="skeleton"></div>
        <div class="skeleton"></div>
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </div>
    `
  }

  private _renderErrorNotice(error: OrkError | undefined, id?: string) {
    if (!error) return nothing
    return html`<div class="notice error" role="alert" id=${id ?? nothing}>${icons.alert}<span>${error.message}</span></div>`
  }

  // ---------- methods ----------

  private _renderMethods(m: Messages, s: Snapshot) {
    const c = this.controller!
    const { showTabs, tab, list } = methodTabs(c.methodsForTab('crypto'), c.methodsForTab('cash'), s.tab)
    const onTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      c.setTab(tab === 'crypto' ? 'cash' : 'crypto')
      void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.focus())
    }
    return html`
      ${showTabs
        ? html`<div class="tabs" role="tablist" aria-label=${m.tabsLabel} @keydown=${onTabKey}>
            ${(['crypto', 'cash'] as const).map(
              (t) => html`<button
                class="tab"
                role="tab"
                type="button"
                id=${`ork-tab-${t}`}
                aria-controls="ork-methods"
                aria-selected=${tab === t ? 'true' : 'false'}
                tabindex=${tab === t ? '0' : '-1'}
                @click=${() => c.setTab(t)}
              >
                ${t === 'crypto' ? m.tabCrypto : m.tabCash}
              </button>`,
            )}
          </div>`
        : nothing}
      <div id="ork-methods" role=${showTabs ? 'tabpanel' : nothing} aria-labelledby=${showTabs ? `ork-tab-${tab}` : nothing}>
        ${list.length === 0 ? html`<div class="notice info">${m.noMethods}</div>` : nothing}
        ${groupMethods(list).map(({ group, items }) => {
          const label = groupLabel(group, m)
          return html`<section class="group" aria-label=${label}>
            <h3 class="group-label">${label}</h3>
            <ul class="rows">
              ${items.map((x) => html`<li>${this._renderMethodRow(m, s, x)}</li>`)}
            </ul>
          </section>`
        })}
      </div>
      ${this._renderErrorNotice(s.error)}
    `
  }

  private _renderMethodRow(m: Messages, s: Snapshot, x: MethodOption) {
    const unavailable = x.group === 'unavailable'
    const sub = methodSubtitle(x, s.walletAddress, m)
    return html`<button
      class="row"
      type="button"
      ?disabled=${unavailable}
      data-method=${x.method}
      @click=${() => void this.controller?.selectMethod(x.method)}
    >
      <span class="row-icon">${methodIcon(x.kind, x.method)}</span>
      <span class="row-main">
        <span class="row-title">${x.name}</span>
        ${sub ? html`<span class="row-sub ${unavailable ? 'reason' : ''}">${sub}</span>` : nothing}
      </span>
      ${unavailable ? nothing : html`<span class="row-end">${formatEta(x.eta, m)}</span><span class="chevron">${icons.chevron}</span>`}
    </button>`
  }

  // ---------- withdraw: tabs, target and payout methods ----------

  /** "To wallet" / "To cash" tabs, shown when the app allows both */
  private _renderWithdrawTabs(m: Messages, s: Snapshot) {
    const c = this.controller!
    const tabs = c.withdrawTabs()
    if (tabs.length < 2) return nothing
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      c.setTab(s.tab === 'crypto' ? 'cash' : 'crypto')
      void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.focus())
    }
    return html`<div class="tabs" role="tablist" aria-label=${m.withdrawTabsLabel} @keydown=${onKey}>
      ${tabs.map(
        (t: Tab) => html`<button
          class="tab"
          role="tab"
          type="button"
          id=${`ork-tab-${t}`}
          aria-controls="ork-panel"
          aria-selected=${s.tab === t ? 'true' : 'false'}
          tabindex=${s.tab === t ? '0' : '-1'}
          @click=${() => s.tab !== t && c.setTab(t)}
        >
          ${t === 'crypto' ? m.tabToWallet : m.tabToCash}
        </button>`,
      )}
    </div>`
  }

  private _renderTarget(m: Messages, s: Snapshot) {
    const c = this.controller!
    const t = s.target
    const tabs = c.withdrawTabs().length > 1
    if (!t) return this._renderLoading(m)
    const valid = isValidTargetAddress(t.chain, t.address)
    const showInvalid = !!t.address && !valid
    const own = s.walletAddress
    const submit = () => {
      if (valid && !s.busy) void c.submitTarget()
    }
    return html`
      ${this._renderWithdrawTabs(m, s)}
      <div id="ork-panel" role=${tabs ? 'tabpanel' : nothing} aria-labelledby=${tabs ? 'ork-tab-crypto' : nothing}>
        ${this._renderTargetSelects(m, t)}
        <label class="field-label" for="ork-address">${m.walletAddress}</label>
        <input
          class="input mono"
          id="ork-address"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="done"
          placeholder=${m.addressPlaceholder}
          aria-invalid=${showInvalid ? 'true' : 'false'}
          aria-describedby=${showInvalid ? 'ork-address-error' : nothing}
          .value=${live(t.address)}
          @input=${(e: Event) => c.setTargetAddress((e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && submit()}
        />
        ${showInvalid ? html`<div class="field-error" id="ork-address-error">${m.invalidAddress}</div>` : nothing}
        ${own && own.toLowerCase() !== t.address.toLowerCase()
          ? html`<div class="stack" style="margin-top:8px">
              <button class="btn ghost" type="button" @click=${() => c.setTargetAddress(own)}>${m.useMyWallet} (${shortAddress(own)})</button>
            </div>`
          : nothing}
      </div>
      ${this._renderErrorNotice(s.error)}
      <div class="stack">
        <button class="btn" type="button" ?disabled=${!valid || s.busy} @click=${submit}>
          ${s.busy ? html`<span class="spinner" aria-hidden="true"></span>` : nothing}${m.continue}
        </button>
      </div>
    `
  }

  /**
   * Network and token pickers. Each select is its own template: the happy-dom 18 parser cannot
   * handle two sibling bound selects in one template (see the transfer picker note in the tests).
   */
  private _renderTargetSelects(m: Messages, t: NonNullable<Snapshot['target']>) {
    const c = this.controller!
    const select = (label: string, onChange: (v: string) => void, options: Array<{ value: string; label: string }>, value: string) =>
      html`<select class="input" aria-label=${label} @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}>
        ${options.map((o) => html`<option value=${o.value} ?selected=${o.value === value}>${o.label}</option>`)}
      </select>`
    const chains = c.withdrawChains().map((ch) => ({ value: ch, label: displayChain(ch) }))
    const tokens = c.targetTokens(t.chain).map((o) => ({ value: o.token, label: o.symbol }))
    return html`<div class="select-row">
      ${select(m.network, (v) => c.setTargetChain(v), chains, t.chain)} ${select(m.token, (v) => c.setTargetToken(v), tokens, t.token)}
    </div>`
  }

  private _renderWithdrawMethods(m: Messages, s: Snapshot) {
    const list = s.plan?.methods ?? []
    const tabs = this.controller!.withdrawTabs().length > 1
    return html`
      ${this._renderWithdrawTabs(m, s)}
      <div id="ork-panel" role=${tabs ? 'tabpanel' : nothing} aria-labelledby=${tabs ? `ork-tab-${s.tab}` : nothing}>
        ${s.tab === 'cash' && s.plan ? html`<div class="hint" style="margin:0 0 12px">${m.payoutIn(s.plan.currency)}</div>` : nothing}
        ${list.length === 0 ? html`<div class="notice info">${m.noPayoutMethods}</div>` : nothing}
        ${groupMethods(list).map(({ group, items }) => {
          const label = groupLabel(group, m)
          return html`<section class="group" aria-label=${label}>
            <h3 class="group-label">${label}</h3>
            <ul class="rows">
              ${items.map((x) => html`<li>${this._renderMethodRow(m, s, x)}</li>`)}
            </ul>
          </section>`
        })}
      </div>
      ${this._renderErrorNotice(s.error)}
    `
  }

  // ---------- amount ----------

  private _renderAmount(m: Messages, s: Snapshot) {
    const c = this.controller!
    const { isWallet, isWithdraw, overBalance, currency, prefix, boundsText, balance, chips, valid, width } = amountModel(s, m)
    const describedBy = [boundsText && 'ork-amount-bounds', balance && 'ork-amount-balance', overBalance && 'ork-amount-error'].filter(Boolean).join(' ')
    const t = s.target
    const summary = !isWithdraw
      ? ''
      : s.tab === 'crypto' && t
        ? m.toAddressOn(shortAddress(t.address), displayChain(t.chain))
        : s.method && s.plan
          ? `${s.method.name} · ${m.payoutIn(s.plan.currency)}`
          : ''

    return html`
      <div class="amount-box">
        <label class="amount-input-wrap amount-wrap-focus">
          ${prefix ? html`<span class="amount-prefix" aria-hidden="true">${prefix}</span>` : nothing}
          <input
            class="amount-input"
            inputmode="decimal"
            autocomplete="off"
            enterkeyhint="done"
            placeholder=${m.amountPlaceholder}
            aria-label=${`${m.amountLabel} (${currency})`}
            aria-invalid=${overBalance ? 'true' : 'false'}
            aria-describedby=${describedBy || nothing}
            style=${`width:${width}ch`}
            .value=${live(s.amount)}
            @input=${(e: Event) => c.setAmount((e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && valid && !s.busy) void c.submitAmount()
            }}
          />
          ${prefix ? nothing : html`<span class="amount-suffix">${currency}</span>`}
        </label>
        ${boundsText ? html`<div class="hint" id="ork-amount-bounds">${boundsText}</div>` : nothing}
        ${balance
          ? html`<div class="hint" id="ork-amount-balance" style=${overBalance ? 'color:var(--ork-color-danger)' : nothing}>
              ${(isWithdraw ? m.available : m.balance)(formatToken(balance.amount, balance.symbol, m.locale))}
            </div>`
          : nothing}
        ${overBalance ? html`<div class="field-error" id="ork-amount-error">${m.overBalance}</div>` : nothing}
        ${summary ? html`<div class="target-summary">${summary}</div>` : nothing}
      </div>
      ${chips.length
        ? html`<div class="chips">
            ${chips.map(
              (ch) => html`<button
                class="chip"
                type="button"
                aria-pressed=${s.amount === ch.value ? 'true' : 'false'}
                @click=${() => c.setAmount(ch.value)}
              >
                ${ch.label}
              </button>`,
            )}
          </div>`
        : nothing}
      ${isWallet && s.balances.length ? this._renderBalancePicker(m, s) : nothing}
      ${this._renderErrorNotice(s.error)}
      <div class="stack">
        <button class="btn" type="button" ?disabled=${!valid || s.busy} @click=${() => void c.submitAmount()}>
          ${valid ? m.continue : m.enterAmount}
        </button>
      </div>
    `
  }

  private _renderBalancePicker(m: Messages, s: Snapshot) {
    const c = this.controller!
    return html`
      <span class="field-label" id="ork-paywith">${m.payWith}</span>
      <div class="rows" role="radiogroup" aria-labelledby="ork-paywith">
        ${s.balances.map((b) => {
          const selected = s.source?.chain === b.chain && s.source?.token === b.token
          return html`<button
            class="row"
            type="button"
            role="radio"
            aria-checked=${selected ? 'true' : 'false'}
            @click=${() => c.setSource({ chain: b.chain, token: b.token, symbol: b.symbol, decimals: b.decimals })}
          >
            <span class="row-icon">${icons.wallet}</span>
            <span class="row-main">
              <span class="row-title">${b.symbol}</span>
              <span class="row-sub">${displayChain(b.chain)}</span>
            </span>
            <span class="row-end">
              <strong>${formatToken(b.amount, undefined, m.locale)}</strong>
              ${b.usd ? formatFiat(b.usd, 'USD', { locale: m.locale }) : nothing}
            </span>
          </button>`
        })}
      </div>
    `
  }

  // ---------- quotes ----------

  private _renderTransferSource(m: Messages, s: Snapshot) {
    const c = this.controller!
    const src = s.source
    const chains = transferChains(src?.chain)
    const setChain = (chain: string) => c.setSource(sourceForChain(chain, src?.token === 'native'))
    const setToken = (token: string) => {
      if (!src) return
      const o = transferTokens(src.chain).find((x) => x.token === token)
      if (o) c.setSource({ chain: src.chain, ...o })
    }
    return html`
      <span class="field-label" id="ork-sendfrom">${m.sendFrom}</span>
      <div class="select-row" role="group" aria-labelledby="ork-sendfrom">
        <select class="input" aria-label=${m.network} @change=${(e: Event) => setChain((e.target as HTMLSelectElement).value)}>
          ${chains.map((ch) => html`<option value=${ch} ?selected=${src?.chain === ch}>${displayChain(ch)}</option>`)}
        </select>
        <select class="input" aria-label=${m.token} @change=${(e: Event) => setToken((e.target as HTMLSelectElement).value)}>
          ${src
            ? transferTokens(src.chain).map((o) => html`<option value=${o.token} ?selected=${src.token === o.token}>${o.symbol}</option>`)
            : nothing}
        </select>
      </div>
    `
  }

  private _renderQuotes(m: Messages, s: Snapshot) {
    const c = this.controller!
    const isTransfer = isAddressTransfer(s.method?.method)
    const errors = dedupe(s.quoteErrors.map((e) => e.message))
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const next = nextQuoteId(s.quotes, s.selectedQuoteId, e.key === 'ArrowDown' ? 1 : -1)
      if (!next) return
      c.selectQuote(next)
      void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`[data-quote="${CSS.escape(next)}"]`)?.focus())
    }
    let list: unknown
    if (s.quotesLoading && !s.quotes.length) {
      list = html`<div aria-hidden="true"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
        <div class="status-line"><span class="spinner" aria-hidden="true"></span>${m.gettingQuotes}</div>`
    } else if (!s.quotes.length) {
      list = html`<div class="notice info">${m.noQuotes}</div>
        ${errors.map((e) => html`<div class="notice info">${e}</div>`)}
        <div class="stack"><button class="btn secondary" type="button" @click=${() => void c.refreshQuotes()}>${m.refresh}</button></div>`
    } else {
      list = html`<div class="rows" role="radiogroup" aria-label=${m.quotesLabel} @keydown=${onKey}>
          ${s.quotes.map((q) => this._renderQuoteRow(m, s, q))}
        </div>
        ${s.quotesLoading ? html`<div class="status-line"><span class="spinner" aria-hidden="true"></span>${m.gettingQuotes}</div>` : nothing}
        ${errors.length ? html`<div class="hint" style="text-align:left">${errors.join(' ')}</div>` : nothing}`
    }
    const canConfirm = !!s.selectedQuoteId && !s.busy && s.quotes.length > 0
    return html`
      ${isTransfer ? this._renderTransferSource(m, s) : nothing} ${list} ${this._renderErrorNotice(s.error)}
      ${s.quotes.length
        ? html`<div class="stack">
            <button class="btn" type="button" ?disabled=${!canConfirm} @click=${() => void c.confirm()}>
              ${s.busy ? html`<span class="spinner" aria-hidden="true"></span>${m.confirming}` : isTransfer ? m.continue : m.confirm}
            </button>
          </div>`
        : nothing}
    `
  }

  private _renderQuoteRow(m: Messages, s: Snapshot, q: Quote) {
    const selected = q.id === s.selectedQuoteId
    return html`<button
      class="row"
      type="button"
      role="radio"
      data-quote=${q.id}
      aria-checked=${selected ? 'true' : 'false'}
      tabindex=${selected || !s.selectedQuoteId ? '0' : '-1'}
      @click=${() => this.controller?.selectQuote(q.id)}
    >
      <span class="row-icon" aria-hidden="true" style="font-weight:700;font-size:15px">${q.provider.slice(0, 1).toUpperCase()}</span>
      <span class="row-main">
        <span class="row-title">
          ${q.provider}
          ${q.badges?.includes('best_price') ? html`<span class="badge success">${m.bestPrice}</span>` : nothing}
          ${q.badges?.includes('fastest') ? html`<span class="badge">${m.fastest}</span>` : nothing}
        </span>
        <span class="row-sub wrap">${quoteSubtitle(q, m, s.direction)}</span>
      </span>
      <span class="row-end">
        ${Number(q.output.amount) > 0 ? html`<strong>${formatAmount(q.output, m.locale)}</strong>` : nothing}
        ${formatEta(q.eta, m)}
      </span>
    </button>`
  }

  // ---------- step ----------

  private _renderStep(m: Messages, s: Snapshot) {
    const c = this.controller!
    const step = s.session!.step
    const surface = step.surface
    const submits = step.transitions.filter((t): t is Extract<Transition, { kind: 'SUBMIT' }> => t.kind === 'SUBMIT')
    const awaiting = step.transitions.some((t) => t.kind === 'AWAIT')
    const formSurface = surface?.kind === 'FORM' || surface?.kind === 'OTP'
    // FORM and OTP surfaces use the first SUBMIT transition as their submit button.
    const extra = formSurface ? submits.slice(1) : submits
    const hasPrimary = !!surface && ['REDIRECT', 'DEEPLINK', 'WALLET_TX', 'FORM', 'OTP'].includes(surface.kind)
    const showProgress = !!step.progress && (step.progress.legs.length > 1 || step.state === 'PROCESSING')
    const errors = [step.error, s.error && s.error.message !== step.error?.message ? s.error : undefined].filter((e): e is OrkError => !!e)

    return html`
      ${surface ? this._renderSurface(m, s, step, surface, submits[0]) : this._renderProcessing(m, step, s.direction === 'withdraw')}
      ${extra.length
        ? html`<div class="stack">
            ${extra.map((t, i) =>
              t.inputs?.length
                ? this._renderForm(m, t.inputs, t)
                : html`<button
                    class="btn ${hasPrimary || i > 0 ? 'secondary' : ''}"
                    type="button"
                    ?disabled=${s.busy}
                    @click=${() => void c.fire(t.name)}
                  >
                    ${t.label}
                  </button>`,
            )}
          </div>`
        : nothing}
      ${errors.map((e, i) => this._renderErrorNotice(e, i === 0 ? 'ork-step-error' : undefined))}
      ${showProgress ? this._renderProgress(m, step) : nothing}
      ${awaiting && surface && !errors.length ? html`<div class="status-line"><span class="spinner" aria-hidden="true"></span>${m.checkingStatus}</div>` : nothing}
      ${step.state === 'PAYMENT' && !(s.surfaceClosed && surface?.kind === 'IFRAME')
        ? html`<div class="stack">
            <button class="btn ghost" type="button" ?disabled=${s.busy} @click=${() => void c.fire('restart')}>${m.chooseOther}</button>
          </div>`
        : nothing}
    `
  }

  private _renderProcessing(m: Messages, step: Step, withdraw = false) {
    return html`<div class="center">
      <span class="spinner large" aria-hidden="true"></span>
      <div class="secondary-text">${step.sub ? titleCase(step.sub.toLowerCase()) : m.stepTitle[step.state] ?? m.checkingStatus}</div>
      ${withdraw && step.state === 'PROCESSING' ? html`<p class="secondary-text">${m.sendingBody}</p>` : nothing}
    </div>`
  }

  private _renderProgress(m: Messages, step: Step) {
    return html`<ol class="progress" aria-label=${m.progressLabel}>
      ${step.progress!.legs.map(
        (l, i) => html`<li>
          <span class="dot ${l.status}" aria-hidden="true">${l.status === 'succeeded' ? icons.check : i + 1}</span>
          <span>
            <span class="sr-only">${i + 1}.</span>
            <strong>${l.provider ?? titleCase(l.adapterId)}</strong>:
            <span class="leg-status">${m.legStatus[l.status] ?? l.status}</span>
            ${l.txHash ? html`<span class="muted"> ${shortAddress(l.txHash)}</span>` : nothing}
          </span>
        </li>`,
      )}
    </ol>`
  }

  private _copyRow(m: Messages, key: string, label: string, value: string, opts: { mono?: boolean; copy?: boolean } = {}) {
    const copied = this._copied === key
    return html`<div class="kv-row">
      <div class="kv-main">
        <div class="kv-label">${label}</div>
        <div class="kv-value ${opts.mono ? 'mono' : ''}">${value}</div>
      </div>
      ${opts.copy === false
        ? nothing
        : html`<button
            class="copy-btn"
            type="button"
            ?data-copied=${copied}
            aria-label=${copied ? m.copied : `${m.copy} ${label}`}
            @click=${() => void this._copy(key, value)}
          >
            ${copied ? m.copied : m.copy}
          </button>`}
    </div>`
  }

  private _qr(text: string, label: string) {
    const { size, path } = cachedQr(text)
    return html`<div class="qr">
      <svg viewBox=${`0 0 ${size} ${size}`} role="img" aria-label=${label} shape-rendering="crispEdges">
        <path d=${path} fill="#000"></path>
      </svg>
    </div>`
  }

  private _renderSurface(
    m: Messages,
    s: Snapshot,
    step: Step,
    surface: Surface,
    submit: Extract<Transition, { kind: 'SUBMIT' }> | undefined,
  ): TemplateResult {
    const c = this.controller!
    const provider = ('provider' in surface && surface.provider) || this._selectedQuote?.provider || m.provider
    switch (surface.kind) {
      case 'REDIRECT': {
        const opened = this._openedUrl === surface.url
        const finish = step.transitions.find((t) => t.kind === 'SURFACE_RESULT' && t.expects === 'completed')
        return html`<div class="center">
            <span class="row-icon" aria-hidden="true">${icons.external}</span>
            <p class="secondary-text">${opened ? m.redirectWaiting(provider) : m.redirectHint(provider)}</p>
          </div>
          <div class="stack">
            <button
              class="btn ${opened ? 'secondary' : ''}"
              type="button"
              @click=${() => {
                // Opens the window inside the click handler, so popup blockers allow it.
                c.openSurface()
                this._openedUrl = surface.url
              }}
            >
              ${opened ? m.openAgain : m.continueTo(provider)}
            </button>
            ${opened && finish
              ? html`<button class="btn" type="button" ?disabled=${s.busy} @click=${() => void c.fire(finish.name)}>${m.continue}</button>`
              : nothing}
          </div>`
      }
      case 'IFRAME':
        if (s.surfaceClosed) {
          return html`<div class="notice info" role="status">${icons.alert}<span><strong>${m.iframeClosed}</strong><br />${m.iframeClosedBody}</span></div>
            <div class="stack">
              <button class="btn" type="button" @click=${() => c.reopenSurface()}>${m.tryAgain}</button>
              <button class="btn secondary" type="button" ?disabled=${s.busy} @click=${() => void c.fire('restart')}>${m.chooseOther}</button>
            </div>`
        }
        // Only http(s) pages (or the inert about:blank): a `javascript:` or `data:` src would run in this page's context.
        if (surface.url !== 'about:blank' && !isWebUrl(surface.url, { allowHttp: true })) return html`<div class="notice error" role="alert">${m.sdkFailed(provider)}</div>`
        return html`<iframe
          class="provider"
          src=${surface.url}
          title=${m.iframeTitle(provider)}
          allow=${surface.allow ?? 'payment; camera; microphone; clipboard-write'}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
          referrerpolicy="strict-origin-when-cross-origin"
          style=${`height:${surface.height ?? 560}px`}
        ></iframe>`
      case 'PROVIDER_SDK': {
        const name = titleCase(surface.provider)
        if (this.providerRenderers?.[surface.provider]) {
          return html`<div class="provider-sdk" data-provider=${surface.provider}></div>
            ${this._sdkError ? html`<div class="notice error" role="alert">${m.sdkFailed(name)}</div>` : nothing}`
        }
        const redirectUrl = isWebUrl(surface.params.redirectUrl, { allowHttp: true }) ? surface.params.redirectUrl : undefined
        if (redirectUrl) {
          return html`<p class="hint">${m.redirectHint(name)}</p>
            <a class="btn" href=${redirectUrl} target="_blank" rel="noopener noreferrer"
              >${m.continueTo(name)}<span class="sr-only"> (${m.opensInNewTab})</span></a
            >`
        }
        return html`<div class="notice info">${m.sdkUnsupported(name)}</div>`
      }
      case 'QR': {
        const left = surface.expiresAt ? Date.parse(surface.expiresAt) - this._now : undefined
        const label = surface.method ? methodName(surface.method) : m.scanToPay
        return html`
          <div class="big-amount">${formatFiat(surface.amount, surface.currency, { locale: m.locale })}</div>
          <div class="hint">${surface.method ? `${methodName(surface.method)}. ${m.scanToPay}` : m.scanToPay}</div>
          ${this._qr(surface.payload, label)}
          ${left !== undefined
            ? html`<div class="hint" role="timer">${left > 0 ? m.expiresIn(formatCountdown(left)) : m.expired}</div>`
            : nothing}
          ${surface.reference ? html`<div class="kv">${this._copyRow(m, 'ref', m.reference, surface.reference, { mono: true })}</div>` : nothing}
        `
      }
      case 'DEPOSIT_ADDRESS': {
        const chain = surface.chainName ?? displayChain(surface.chain)
        const symbol = surface.symbol ?? 'tokens'
        return html`
          ${s.method?.method === 'exchange_transfer' ? html`<div class="notice info">${icons.exchange}<span>${m.exchangeHint(symbol, chain)}</span></div>` : nothing}
          <div class="hint" style="margin-top:0">${m.depositAddressHint(symbol, chain)}</div>
          ${this._qr(surface.address, m.address)}
          <div class="kv">
            ${this._copyRow(m, 'addr', m.address, surface.address, { mono: true })}
            ${surface.memo ? this._copyRow(m, 'memo', m.memo, surface.memo, { mono: true }) : nothing}
            <div class="select-row" style="margin:0">
              ${this._copyRow(m, 'net', m.network, chain, { copy: false })} ${this._copyRow(m, 'tok', m.token, symbol, { copy: false })}
            </div>
          </div>
          ${surface.min ? html`<div class="hint">${m.minDeposit(formatToken(surface.min, symbol, m.locale))}</div>` : nothing}
          <div class="notice warning">${icons.alert}<span>${surface.warning ?? m.depositWarning(symbol, chain)}</span></div>
        `
      }
      case 'WALLET_TX':
        return html`<div class="center">
            <span class="row-icon" aria-hidden="true">${icons.wallet}</span>
            <p class="secondary-text">${m.walletTxHint(surface.txs.length, displayChain(surface.chain))}</p>
          </div>
          <div class="stack">
            <button class="btn" type="button" ?disabled=${s.busy} @click=${() => void c.sendWalletTransactions()}>
              ${s.busy ? html`<span class="spinner" aria-hidden="true"></span>${m.checkWallet}` : m.confirmInWallet}
            </button>
          </div>`
      case 'BANK_FIELDS':
        return html`<div class="kv">
          ${surface.fields.map((f, i) => this._copyRow(m, `bank-${i}`, f.label, f.value, { copy: f.copy }))}
        </div>`
      case 'DEEPLINK':
        return html`<div class="stack">
          <button class="btn" type="button" @click=${() => c.openSurface()}>${m.openApp(surface.appName)}</button>
        </div>`
      case 'OTP': {
        const id = submit?.inputs?.[0]?.id ?? 'code'
        const fields: FieldSpec[] = [{ id, label: m.otpLabel, type: 'text', required: true }]
        return html`<p class="secondary-text">${m.otpHint(surface.to)}</p>
          ${this._renderForm(m, fields, submit, true)}`
      }
      case 'FORM':
        return this._renderForm(m, surface.fields, submit)
    }
  }

  private _renderForm(m: Messages, fields: FieldSpec[], submit: Extract<Transition, { kind: 'SUBMIT' }> | undefined, otp = false) {
    const c = this.controller!
    const busy = !!this._snap?.busy
    // Fields point at the step error, so screen readers read it with the field.
    const errorId = this._snap?.session?.step.error || this._snap?.error ? 'ork-step-error' : nothing
    const set = (id: string, v: unknown) => {
      this._form = { ...this._form, [id]: v }
    }
    const onSubmit = (e: Event) => {
      e.preventDefault()
      if (!submit || busy) return
      const inputs: Record<string, unknown> = {}
      for (const f of fields) if (f.id in this._form) inputs[f.id] = this._form[f.id]
      void c.fire(submit.name, inputs)
    }
    return html`<form class="form" @submit=${onSubmit}>
      ${fields.map((f) => {
        const fid = `ork-f-${f.id}`
        if (f.type === 'checkbox') {
          return html`<label class="checkbox"
            ><input
              type="checkbox"
              id=${fid}
              ?required=${!!f.required}
              aria-describedby=${errorId}
              .checked=${!!this._form[f.id]}
              @change=${(e: Event) => set(f.id, (e.target as HTMLInputElement).checked)}
            />${f.label}</label
          >`
        }
        if (f.type === 'select') {
          return html`<div>
            <label class="field-label" for=${fid}>${f.label}</label>
            <select class="input" id=${fid} ?required=${!!f.required} aria-describedby=${errorId} @change=${(e: Event) => set(f.id, (e.target as HTMLSelectElement).value)}>
              <option value="" ?selected=${!this._form[f.id]}></option>
              ${(f.options ?? []).map((o) => html`<option value=${o.value} ?selected=${this._form[f.id] === o.value}>${o.label}</option>`)}
            </select>
          </div>`
        }
        return html`<div>
          <label class="field-label" for=${fid}>${f.label}</label>
          <input
            class="input"
            id=${fid}
            type=${f.type === 'number' ? 'text' : f.type}
            inputmode=${f.type === 'number' || otp ? 'numeric' : nothing}
            autocomplete=${otp ? 'one-time-code' : f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'off'}
            ?required=${!!f.required}
            aria-describedby=${errorId}
            .value=${String(this._form[f.id] ?? '')}
            @input=${(e: Event) => set(f.id, (e.target as HTMLInputElement).value)}
          />
        </div>`
      })}
      ${submit
        ? html`<button class="btn" type="submit" ?disabled=${busy}>
            ${busy ? html`<span class="spinner" aria-hidden="true"></span>` : nothing}${submit.label || m.submit}
          </button>`
        : nothing}
    </form>`
  }

  // ---------- result and error ----------

  private _renderResult(m: Messages, s: Snapshot) {
    const c = this.controller!
    const step = s.session!.step
    const q = this._selectedQuote
    const withdraw = s.direction === 'withdraw'
    if (step.state === 'COMPLETED') {
      return html`<div class="center">
          <span class="result-icon success" aria-hidden="true">${icons.check}</span>
          <h3 class="result-title">${withdraw ? m.withdrawSuccessTitle : m.successTitle}</h3>
          <p class="secondary-text">${q ? (s.session!.destination?.type === 'crypto' && s.session!.destination.calls?.length ? m.youDeposited(formatAmount(q.output, m.locale)) : m.youReceived(formatAmount(q.output, m.locale))) : withdraw ? m.withdrawSuccessBody : m.successBody}</p>
        </div>
        ${step.progress && step.progress.legs.length > 1 ? this._renderProgress(m, step) : nothing}
        <div class="stack"><button class="btn" type="button" @click=${() => this.close()}>${m.done}</button></div>`
    }
    const retry = step.state === 'FAILED' || step.state === 'BLOCKED'
    return html`<div class="center">
        <span class="result-icon failure" aria-hidden="true">${icons.x}</span>
        <h3 class="result-title">${withdraw && step.state === 'FAILED' ? m.withdrawFailedTitle : m.failedTitle[step.state] ?? m.failedBody}</h3>
        <p class="secondary-text">${step.error?.message ?? m.failedBody}</p>
      </div>
      ${s.error && s.error.message !== step.error?.message ? this._renderErrorNotice(s.error) : nothing}
      <div class="stack">
        ${retry
          ? html`<button class="btn" type="button" ?disabled=${s.busy} @click=${() => void c.fire('restart')}>${m.tryAgain}</button>`
          : nothing}
        <button class="btn ${retry ? 'secondary' : ''}" type="button" @click=${() => this.close()}>${m.close}</button>
      </div>`
  }

  private _renderError(m: Messages, error: OrkError | undefined, canRetry: boolean) {
    return html`<div class="center">
        <span class="result-icon failure" aria-hidden="true">${icons.alert}</span>
        <h3 class="result-title">${m.errorTitle}</h3>
        <p class="secondary-text">${error?.message ?? (this._snap?.direction === 'withdraw' ? m.withdrawErrorBody : m.errorBody)}</p>
      </div>
      <div class="stack">
        ${canRetry && this.controller
          ? html`<button class="btn" type="button" @click=${() => void this.controller?.start()}>${m.tryAgain}</button>`
          : nothing}
        ${this.embedded
          ? nothing
          : html`<button class="btn ${canRetry ? 'secondary' : ''}" type="button" @click=${() => this.close()}>${m.close}</button>`}
      </div>`
  }
}

/**
 * Focus the element that opened the modal. The opener can still be disabled at this moment (the React
 * DepositButton is disabled while the modal is open), so try again for a short time while focus is nowhere.
 */
function restoreFocus(el: HTMLElement, tries = 5) {
  if (!el.isConnected) return
  el.focus()
  if (document.activeElement === el || tries <= 0) return
  setTimeout(() => {
    const active = document.activeElement
    if (!active || active === document.body) restoreFocus(el, tries - 1)
  }, 20)
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}

/** Register `<openramp-modal>` once. Safe to call many times and on the server (no-op). */
export function defineOpenRampModal(): void {
  if (typeof customElements === 'undefined') return
  if (!customElements.get(TAG_NAME)) customElements.define(TAG_NAME, OpenRampModal)
}

declare global {
  interface HTMLElementTagNameMap {
    'openramp-modal': OpenRampModal
  }
}
