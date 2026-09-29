import { html, LitElement, nothing } from 'lit'
import type { PropertyValues, TemplateResult } from 'lit'
import { live } from 'lit/directives/live.js'
import type { DepositController, Snapshot } from '@openrampkit/client'
import { methodName } from '@openrampkit/core'
import type { FieldSpec, MethodOption, OrkError, Quote, Step, Surface, Transition } from '@openrampkit/core'
import { displayChain, formatAmount, formatCountdown, formatEta, formatFiat, formatToken, shortAddress, titleCase } from './format.js'
import { icons, methodIcon } from './icons.js'
import { mergeMessages } from './messages.js'
import type { Messages } from './messages.js'
import { qrPath } from './qr.js'
import { styles } from './styles.js'
import { themeVariables } from './theme.js'
import type { Appearance, Theme } from './theme.js'
import {
  amountModel,
  groupLabel,
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
    error: { attribute: false },
    open: { type: Boolean, reflect: true },
    embedded: { type: Boolean, reflect: true },
    _snap: { state: true },
    _copied: { state: true },
    _now: { state: true },
    _openedUrl: { state: true },
    _systemDark: { state: true },
  }

  declare controller: DepositController | undefined
  declare theme: Theme | undefined
  declare appearance: Appearance | undefined
  /** Partial message catalog, for translations */
  declare messages: Partial<Messages> | undefined
  /** Error shown when there is no controller (for example the client secret could not load) */
  declare error: OrkError | undefined
  declare open: boolean
  declare embedded: boolean

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
    if (back?.isConnected) back.focus()
  }

  // ---------- helpers ----------

  private get _m(): Messages {
    return mergeMessages(this.messages)
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
    return [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
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
    const active = (this.renderRoot as ShadowRoot).activeElement
    const inside = !!active && items.includes(active as HTMLElement)
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault()
      first.focus()
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
        aria-busy=${this._snap?.busy || this._screen === 'loading' ? 'true' : 'false'}
        tabindex="-1"
        @keydown=${this._onKeydown}
        @focusin=${() => (this._hadFocus = true)}
      >
        ${this._renderHeader(m)}
        <div class="body" part="body">${this._renderScreen(m)}</div>
        ${a?.hideFooter ? nothing : html`<div class="footer" part="footer">${m.poweredBy}</div>`}
        <div class="sr-only" aria-live="polite">${liveText(this._snap, this.error, m)}</div>
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
      case 'methods':
        return this._renderMethods(m, s)
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

  private _renderErrorNotice(error: OrkError | undefined) {
    if (!error) return nothing
    return html`<div class="notice error" role="alert">${icons.alert}<span>${error.message}</span></div>`
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

  // ---------- amount ----------

  private _renderAmount(m: Messages, s: Snapshot) {
    const c = this.controller!
    const { isWallet, currency, prefix, boundsText, balance, chips, valid, width } = amountModel(s, m)

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
            style=${`width:${width}ch`}
            .value=${live(s.amount)}
            @input=${(e: Event) => c.setAmount((e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && valid && !s.busy) void c.submitAmount()
            }}
          />
          ${prefix ? nothing : html`<span class="amount-suffix">${currency}</span>`}
        </label>
        ${boundsText ? html`<div class="hint">${boundsText}</div>` : nothing}
        ${balance ? html`<div class="hint">${m.balance(formatToken(balance.amount, balance.symbol))}</div>` : nothing}
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
              <strong>${formatToken(b.amount)}</strong>
              ${b.usd ? formatFiat(b.usd, 'USD') : nothing}
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
      <span class="field-label">${m.sendFrom}</span>
      <div class="select-row">
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
    const isTransfer = s.method?.method === 'transfer'
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
        <div class="status-line"><span class="spinner"></span>${m.gettingQuotes}</div>`
    } else if (!s.quotes.length) {
      list = html`<div class="notice info">${m.noQuotes}</div>
        ${errors.map((e) => html`<div class="notice info">${e}</div>`)}
        <div class="stack"><button class="btn secondary" type="button" @click=${() => void c.refreshQuotes()}>${m.refresh}</button></div>`
    } else {
      list = html`<div class="rows" role="radiogroup" aria-label=${m.quotesLabel} @keydown=${onKey}>
          ${s.quotes.map((q) => this._renderQuoteRow(m, s, q))}
        </div>
        ${s.quotesLoading ? html`<div class="status-line"><span class="spinner"></span>${m.gettingQuotes}</div>` : nothing}
        ${errors.length ? html`<div class="hint" style="text-align:left">${errors.join(' ')}</div>` : nothing}`
    }
    const canConfirm = !!s.selectedQuoteId && !s.busy && s.quotes.length > 0
    return html`
      ${isTransfer ? this._renderTransferSource(m, s) : nothing} ${list} ${this._renderErrorNotice(s.error)}
      ${s.quotes.length
        ? html`<div class="stack">
            <button class="btn" type="button" ?disabled=${!canConfirm} @click=${() => void c.confirm()}>
              ${s.busy ? html`<span class="spinner"></span>${m.confirming}` : isTransfer ? m.continue : m.confirm}
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
        <span class="row-sub wrap">${quoteSubtitle(q, m)}</span>
      </span>
      <span class="row-end">
        ${Number(q.output.amount) > 0 ? html`<strong>${formatAmount(q.output)}</strong>` : nothing}
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
    const errors = [step.error, s.error && s.error.message !== step.error?.message ? s.error : undefined]

    return html`
      ${surface ? this._renderSurface(m, s, step, surface, submits[0]) : this._renderProcessing(m, step)}
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
      ${errors.map((e) => this._renderErrorNotice(e))}
      ${showProgress ? this._renderProgress(m, step) : nothing}
      ${awaiting && surface ? html`<div class="status-line"><span class="spinner"></span>${m.checkingStatus}</div>` : nothing}
      ${step.state === 'PAYMENT'
        ? html`<div class="stack">
            <button class="btn ghost" type="button" ?disabled=${s.busy} @click=${() => void c.fire('restart')}>${m.chooseOther}</button>
          </div>`
        : nothing}
    `
  }

  private _renderProcessing(m: Messages, step: Step) {
    return html`<div class="center">
      <span class="spinner large" aria-hidden="true"></span>
      <div class="secondary-text">${step.sub ? titleCase(step.sub.toLowerCase()) : m.stepTitle[step.state] ?? m.checkingStatus}</div>
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
        return html`<iframe
          class="provider"
          src=${surface.url}
          title=${m.iframeTitle(provider)}
          allow=${surface.allow ?? 'payment; camera; microphone; clipboard-write'}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
          referrerpolicy="strict-origin-when-cross-origin"
          style=${`height:${surface.height ?? 560}px`}
        ></iframe>`
      case 'PROVIDER_SDK':
        return html`<div class="notice info">${m.sdkUnsupported(titleCase(surface.provider))}</div>`
      case 'QR': {
        const left = surface.expiresAt ? Date.parse(surface.expiresAt) - this._now : undefined
        const label = surface.method ? methodName(surface.method) : m.scanToPay
        return html`
          <div class="big-amount">${formatFiat(surface.amount, surface.currency)}</div>
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
          <div class="hint" style="margin-top:0">${m.depositAddressHint(symbol, chain)}</div>
          ${this._qr(surface.address, m.address)}
          <div class="kv">
            ${this._copyRow(m, 'addr', m.address, surface.address, { mono: true })}
            ${surface.memo ? this._copyRow(m, 'memo', m.memo, surface.memo, { mono: true }) : nothing}
            <div class="select-row" style="margin:0">
              ${this._copyRow(m, 'net', m.network, chain, { copy: false })} ${this._copyRow(m, 'tok', m.token, symbol, { copy: false })}
            </div>
          </div>
          ${surface.min ? html`<div class="hint">${m.minDeposit(formatToken(surface.min, symbol))}</div>` : nothing}
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
              ${s.busy ? html`<span class="spinner"></span>${m.checkWallet}` : m.confirmInWallet}
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
              .checked=${!!this._form[f.id]}
              @change=${(e: Event) => set(f.id, (e.target as HTMLInputElement).checked)}
            />${f.label}</label
          >`
        }
        if (f.type === 'select') {
          return html`<div>
            <label class="field-label" for=${fid}>${f.label}</label>
            <select class="input" id=${fid} ?required=${!!f.required} @change=${(e: Event) => set(f.id, (e.target as HTMLSelectElement).value)}>
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
            .value=${String(this._form[f.id] ?? '')}
            @input=${(e: Event) => set(f.id, (e.target as HTMLInputElement).value)}
          />
        </div>`
      })}
      ${submit
        ? html`<button class="btn" type="submit" ?disabled=${busy}>
            ${busy ? html`<span class="spinner"></span>` : nothing}${submit.label || m.submit}
          </button>`
        : nothing}
    </form>`
  }

  // ---------- result and error ----------

  private _renderResult(m: Messages, s: Snapshot) {
    const c = this.controller!
    const step = s.session!.step
    const q = this._selectedQuote
    if (step.state === 'COMPLETED') {
      return html`<div class="center">
          <span class="result-icon success" aria-hidden="true">${icons.check}</span>
          <h3 class="result-title">${m.successTitle}</h3>
          <p class="secondary-text">${q ? m.youReceived(formatAmount(q.output)) : m.successBody}</p>
        </div>
        ${step.progress && step.progress.legs.length > 1 ? this._renderProgress(m, step) : nothing}
        <div class="stack"><button class="btn" type="button" @click=${() => this.close()}>${m.done}</button></div>`
    }
    const retry = step.state === 'FAILED' || step.state === 'BLOCKED'
    return html`<div class="center">
        <span class="result-icon failure" aria-hidden="true">${icons.x}</span>
        <h3 class="result-title">${m.failedTitle[step.state] ?? m.failedBody}</h3>
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
        <p class="secondary-text">${error?.message ?? m.errorBody}</p>
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
