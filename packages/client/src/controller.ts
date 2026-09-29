// `RampController` (exported also as `DepositController` and `WithdrawController`) holds the modal
// state for one session. UIs render `getSnapshot()` and call its actions. The session's direction
// picks the flow: deposit (methods, amount, quotes) or withdraw (target, amount, quotes).

import { CHAINS, USDC, cmp, currencyForCountry, isTerminal, orkError } from '@openrampkit/core'
import type {
  Direction,
  MethodOption,
  OrkError,
  OrkEvent,
  PlanResult,
  PublicSession,
  Quote,
  Step,
  Transition,
  WalletAdapter,
  WalletBalance,
} from '@openrampkit/core'
import { toOrkError } from './client.js'
import type { OpenRampClient } from './client.js'

export type Tab = 'crypto' | 'cash'

/** What an embedded provider page reported, via `notifySurface()`. */
export type SurfaceSignal = 'completed' | 'failed' | 'closed'

/** `target` is the withdraw "To wallet" form (network, token, address). */
export type ScreenName = 'loading' | 'target' | 'methods' | 'amount' | 'quotes' | 'step' | 'result' | 'error'

/** Withdraw "To wallet" form state */
export type TargetDraft = { chain: string; token: string; symbol: string; decimals: number; address: string }

export type Snapshot = {
  screen: ScreenName
  /** From the session once loaded. Undefined or 'deposit' means a deposit. */
  direction?: Direction
  tab: Tab
  session?: PublicSession
  plan?: PlanResult
  method?: MethodOption
  amount: string
  amountSide: 'source' | 'destination'
  quotes: Quote[]
  quoteErrors: OrkError[]
  quotesLoading: boolean
  selectedQuoteId?: string
  busy: boolean
  error?: OrkError
  walletConnected: boolean
  walletAddress?: string
  balances: WalletBalance[]
  /** Token the user pays with, for `wallet` and `transfer` */
  source?: { chain: string; token: string; symbol?: string; decimals?: number }
  /** The provider page (IFRAME surface) said the user closed it. Cleared by `reopenSurface()` or a new step. */
  surfaceClosed: boolean
  /** Withdraw: the "To wallet" form */
  target?: TargetDraft
  /** Withdraw: the currency paid out on the "To cash" tab */
  cashCurrency?: string
}

export type ControllerOptions = {
  client: OpenRampClient
  clientSecret: string
  wallet?: WalletAdapter
  /** Surfaces this UI can render. Defaults to all built-in ones. */
  surfaces?: string[]
  onEvent?: (e: OrkEvent) => void
  /** Refuse a session of the other direction (e.g. `openWithdraw()` with a deposit secret) */
  expect?: Direction
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Client-side format check for a withdraw address. The server checks again. */
export function isValidTargetAddress(chain: string, address: string): boolean {
  const a = address.trim()
  if (chain.startsWith('eip155:')) return EVM_ADDRESS.test(a) && !/^0x0{40}$/.test(a)
  if (chain.startsWith('solana:')) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
  return a.length >= 8
}

/** Tokens a withdrawal can go out as on `chain`: USDC when known, and the native token. */
export function withdrawTokens(chain: string): Array<{ token: string; symbol: string; decimals: number }> {
  return [
    ...(USDC[chain] ? [{ token: USDC[chain]!, symbol: 'USDC', decimals: 6 }] : []),
    { token: 'native', symbol: CHAINS[chain]?.nativeSymbol ?? 'ETH', decimals: 18 },
  ]
}

const CRYPTO_KINDS = new Set(['crypto', 'exchange'])

export class RampController {
  private snap: Snapshot
  private listeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private quoteTimer: ReturnType<typeof setTimeout> | undefined
  private resolveDone!: (s: PublicSession) => void
  private rejectDone!: (e: OrkError) => void
  private destroyed = false
  /** Resolves when the session reaches a terminal state */
  readonly done: Promise<PublicSession>

  constructor(private readonly opts: ControllerOptions) {
    this.snap = {
      screen: 'loading',
      direction: opts.expect ?? 'deposit',
      tab: 'crypto',
      amount: '',
      amountSide: 'source',
      quotes: [],
      quoteErrors: [],
      quotesLoading: false,
      busy: false,
      walletConnected: false,
      balances: [],
      surfaceClosed: false,
    }
    this.done = new Promise((res, rej) => {
      this.resolveDone = res
      this.rejectDone = rej
    })
    this.done.catch(() => {})
  }

  getSnapshot = (): Snapshot => this.snap

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch }
    for (const l of this.listeners) l()
  }

  private emit(type: string, object: unknown) {
    this.opts.onEvent?.({
      id: `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type,
      created: Math.floor(Date.now() / 1000),
      livemode: this.snap.session?.livemode ?? false,
      ...(this.snap.session ? { sessionId: this.snap.session.id } : {}),
      data: { object },
    })
  }

  private fail(e: unknown) {
    const error = toOrkError(e)
    this.set({ busy: false, error })
    return error
  }

  private started = false
  /** Increments on every quote request, to drop stale responses */
  private quoteSeq = 0
  /** Increments on every applied session, to drop poll responses that raced with an action */
  private sessionSeq = 0

  async start(): Promise<void> {
    if (!this.started) this.emit('modal.opened', {})
    this.started = true
    this.set({ screen: 'loading', error: undefined })
    try {
      const accounts = this.opts.wallet ? await this.opts.wallet.getAccounts().catch(() => []) : []
      const walletAddress: string | undefined = accounts[0]?.address
      const session = await this.opts.client.getSession(this.opts.clientSecret)
      if (this.opts.expect && session.direction !== this.opts.expect) {
        throw orkError('BAD_REQUEST', { message: `This is not a ${this.opts.expect} session.` })
      }
      this.set({ session, direction: session.direction, walletConnected: !!walletAddress, ...(walletAddress ? { walletAddress } : {}) })
      if (session.step.state !== 'SELECT_METHOD') return this.applySession(session)
      if (walletAddress && this.opts.wallet?.getBalances) {
        const balances = await this.opts.wallet.getBalances(accounts).catch(() => [] as WalletBalance[])
        this.set({ balances: balances.filter((b) => cmp(b.amount, '0') > 0) })
      }
      if (session.direction === 'withdraw') return this.startWithdraw(session)
      this.set({ source: this.defaultSource(session) })
      const plan = await this.opts.client.plan(this.opts.clientSecret, {
        walletConnected: !!walletAddress,
        ...(walletAddress ? { walletAddress } : {}),
        ...(this.opts.surfaces ? { surfaces: this.opts.surfaces } : {}),
      })
      const hasCrypto = plan.methods.some((m) => CRYPTO_KINDS.has(m.kind) && m.group !== 'unavailable')
      this.set({ plan, screen: 'methods', tab: session.destination?.type === 'merchant' || !hasCrypto ? 'cash' : 'crypto' })
    } catch (e) {
      const error = this.fail(e)
      this.set({ screen: 'error', error })
    }
  }

  private async replan() {
    if (this.snap.direction === 'withdraw') return this.setTab(this.snap.tab)
    this.set({ screen: 'loading' })
    try {
      const plan = await this.opts.client.plan(this.opts.clientSecret, {
        walletConnected: this.snap.walletConnected,
        ...(this.snap.walletAddress ? { walletAddress: this.snap.walletAddress } : {}),
        ...(this.opts.surfaces ? { surfaces: this.opts.surfaces } : {}),
      })
      this.set({ plan, screen: 'methods' })
    } catch (e) {
      this.set({ screen: 'error', error: this.fail(e) })
    }
  }

  /** Leave the current payment and pick another method (fires the server `restart` transition). */
  async restart() {
    await this.fire('restart')
  }

  setTab(tab: Tab) {
    this.set({ tab })
    if (this.snap.direction !== 'withdraw' || !this.snap.session) return
    this.set({ error: undefined, method: undefined, quotes: [], quoteErrors: [], selectedQuoteId: undefined })
    if (tab === 'crypto') {
      this.targetSeq++ // drop a cash plan that is still loading
      this.set({ screen: 'target' })
    } else void this.loadCashMethods()
  }

  // ---------- withdraw ----------

  /** Tabs the app allows for this withdrawal: `crypto` (To wallet) and `cash` (To cash). */
  withdrawTabs(): Tab[] {
    const allowed = this.snap.session?.allowedTargets
    if (!allowed) return ['crypto', 'cash']
    return [...(allowed.crypto ? (['crypto'] as const) : []), ...(allowed.fiat ? (['cash'] as const) : [])]
  }

  /** Networks the user may withdraw to: the allowed chains, else every chain with USDC plus the source chain. */
  withdrawChains(): string[] {
    const src = this.snap.session?.source
    const allowed = this.snap.session?.allowedTargets?.crypto?.chains
    if (allowed?.length) return allowed
    const chains = Object.keys(USDC)
    if (src && !chains.includes(src.chain)) chains.unshift(src.chain)
    return chains
  }

  private startWithdraw(session: PublicSession) {
    const src = session.source
    const chains = this.withdrawChains()
    const chain = src && chains.includes(src.chain) ? src.chain : chains[0] ?? 'eip155:8453'
    const allowedCur = session.allowedTargets?.fiat?.currencies?.map((c) => c.toUpperCase())
    const local = currencyForCountry(session.country).toUpperCase()
    const cashCurrency = !allowedCur?.length || allowedCur.includes(local) ? local : allowedCur[0]!
    this.set({ target: { ...this.draftFor(chain, src), address: this.snap.walletAddress ?? '' }, cashCurrency })
    const tabs = this.withdrawTabs()
    if (!tabs.length) {
      this.set({ screen: 'error', error: orkError('TARGET_NOT_ALLOWED') })
      return
    }
    this.setTab(tabs[0]!)
  }

  /** Token for a chain: the source token when it is the source chain, else USDC, else native. */
  private draftFor(chain: string, src?: PublicSession['source'], keep?: string): Omit<TargetDraft, 'address'> {
    const opts = withdrawTokens(chain)
    const fromSource = src && src.chain === chain ? { token: src.token, symbol: src.symbol ?? 'TOKEN', decimals: src.decimals ?? 18 } : undefined
    const list = fromSource && !opts.some((o) => o.token === fromSource.token) ? [fromSource, ...opts] : opts
    const pick = list.find((o) => o.token === keep) ?? (fromSource ? list.find((o) => o.token === fromSource.token) : undefined) ?? list[0]!
    return { chain, ...pick }
  }

  /** Token choices for the "To wallet" form on `chain` */
  targetTokens(chain: string = this.snap.target?.chain ?? ''): Array<{ token: string; symbol: string; decimals: number }> {
    const src = this.snap.session?.source
    const opts = withdrawTokens(chain)
    if (src && src.chain === chain && !opts.some((o) => o.token === src.token)) {
      return [{ token: src.token, symbol: src.symbol ?? 'TOKEN', decimals: src.decimals ?? 18 }, ...opts]
    }
    return opts
  }

  setTargetChain(chain: string) {
    const cur = this.snap.target
    const next = this.draftFor(chain, this.snap.session?.source, cur?.token === 'native' ? 'native' : undefined)
    this.set({ target: { ...next, address: cur?.address ?? '' }, error: undefined })
  }

  setTargetToken(token: string) {
    const cur = this.snap.target
    if (!cur) return
    const o = this.targetTokens(cur.chain).find((x) => x.token === token)
    if (o) this.set({ target: { ...cur, ...o }, error: undefined })
  }

  setTargetAddress(address: string) {
    const cur = this.snap.target
    if (cur) this.set({ target: { ...cur, address: address.trim() }, error: undefined })
  }

  /** "To wallet": send the target to the server, then go to the amount screen. */
  async submitTarget() {
    const t = this.snap.target
    if (!t) return
    if (!isValidTargetAddress(t.chain, t.address)) {
      this.set({ error: orkError('BAD_REQUEST', { message: 'Enter a valid address for this network.' }) })
      return
    }
    this.set({ busy: true, error: undefined })
    try {
      const plan = await this.opts.client.target(this.opts.clientSecret, {
        type: 'crypto',
        chain: t.chain,
        token: t.token,
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        ...this.planFields(),
      })
      this.emit('target.selected', { type: 'crypto', chain: t.chain, token: t.token })
      this.set({ busy: false, plan })
      const usable = plan.methods.filter((m) => m.group !== 'unavailable')
      if (usable.length === 1) return this.selectMethod(usable[0]!.method)
      this.set({ screen: 'methods' })
    } catch (e) {
      this.fail(e)
    }
  }

  /** "To cash": set the fiat target and show the payout methods. */
  private async loadCashMethods() {
    const currency = this.snap.cashCurrency ?? currencyForCountry(this.snap.session?.country)
    const seq = ++this.targetSeq
    this.set({ screen: 'loading', plan: undefined })
    try {
      const plan = await this.opts.client.target(this.opts.clientSecret, { type: 'fiat', currency, ...this.planFields() })
      if (seq !== this.targetSeq || this.destroyed) return
      this.emit('target.selected', { type: 'fiat', currency })
      this.set({ plan, screen: 'methods' })
    } catch (e) {
      if (seq !== this.targetSeq || this.destroyed) return
      this.set({ screen: 'error', error: this.fail(e) })
    }
  }

  /** Increments on every cash target request, to drop stale responses after a tab switch */
  private targetSeq = 0

  private planFields() {
    return {
      walletConnected: this.snap.walletConnected,
      ...(this.snap.walletAddress ? { walletAddress: this.snap.walletAddress } : {}),
      ...(this.opts.surfaces ? { surfaces: this.opts.surfaces } : {}),
    }
  }

  /** Withdraw: the wallet balance of the session's source token, when the wallet reports it. */
  sourceBalance(): WalletBalance | undefined {
    const src = this.snap.session?.source
    if (!src) return undefined
    return this.snap.balances.find((b) => b.chain === src.chain && b.token.toLowerCase() === src.token.toLowerCase())
  }

  methodsForTab(tab: Tab = this.snap.tab): MethodOption[] {
    const all = this.snap.plan?.methods ?? []
    return all.filter((m) => (tab === 'crypto' ? CRYPTO_KINDS.has(m.kind) : !CRYPTO_KINDS.has(m.kind)))
  }

  async selectMethod(method: string) {
    const m = this.snap.plan?.methods.find((x) => x.method === method)
    if (!m || m.group === 'unavailable') return
    this.emit('method.selected', { method })
    this.set({ method: m, quotes: [], quoteErrors: [], error: undefined, selectedQuoteId: undefined })
    if (method === 'transfer') {
      // No amount needed: the user sends any amount to a deposit address.
      this.set({ amount: '', screen: 'quotes' })
      return this.refreshQuotes()
    }
    this.set({ screen: 'amount', amountSide: 'source' })
  }

  /** Default pay-with token: the largest wallet balance, else USDC on a chain other than the destination. */
  private defaultSource(session: PublicSession): Snapshot['source'] {
    const top = [...this.snap.balances].sort((a, b) => cmp(b.usd ?? b.amount, a.usd ?? a.amount))[0]
    if (top) return { chain: top.chain, token: top.token, symbol: top.symbol, decimals: top.decimals }
    const destChain = session.destination?.type === 'crypto' ? session.destination.chain : ''
    const chain = ['eip155:42161', 'eip155:8453', 'eip155:10'].find((c) => c !== destChain) ?? 'eip155:42161'
    return { chain, token: USDC[chain]!, symbol: 'USDC', decimals: 6 }
  }

  setSource(source: NonNullable<Snapshot['source']>) {
    this.set({ source })
    if (this.snap.method?.method === 'transfer' && this.snap.screen === 'quotes') void this.refreshQuotes()
  }

  /** Keeps digits and the first decimal point, so "1,000.50" becomes "1000.50". */
  setAmount(amount: string) {
    const clean = amount.replace(/[^0-9.]/g, '')
    const dot = clean.indexOf('.')
    this.set({ amount: dot < 0 ? clean : clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '') })
  }

  async submitAmount() {
    // `!(n > 0)` also rejects NaN (for example ".")
    if (!(Number(this.snap.amount) > 0)) {
      this.set({ error: orkError('BAD_REQUEST', { message: 'Enter an amount.' }) })
      return
    }
    this.set({ screen: 'quotes', error: undefined })
    await this.refreshQuotes()
  }

  async refreshQuotes() {
    const m = this.snap.method
    if (!m) return
    clearTimeout(this.quoteTimer)
    const seq = ++this.quoteSeq
    this.set({ quotesLoading: true, error: undefined })
    try {
      const r = await this.opts.client.quotes(this.opts.clientSecret, {
        method: m.method,
        amount: this.snap.amount || '0',
        amountSide: this.snap.amountSide,
        ...(this.snap.direction === 'deposit' && (m.method === 'wallet' || m.method === 'transfer') && this.snap.source
          ? { source: { chain: this.snap.source.chain, token: this.snap.source.token } }
          : {}),
      })
      // Drop a response that a newer request, a new method or destroy() made stale.
      if (seq !== this.quoteSeq || this.destroyed || this.snap.method !== m) return
      const first = r.quotes[0]
      this.set({ quotes: r.quotes, quoteErrors: r.errors, quotesLoading: false, ...(first ? { selectedQuoteId: first.id } : {}) })
      this.emit('quotes.shown', { method: m.method, count: r.quotes.length })
      // Re-quote shortly before the earliest expiry while the quote screen is open.
      const exp = r.quotes.map((q) => (q.expiresAt ? Date.parse(q.expiresAt) : Infinity)).reduce((a, b) => Math.min(a, b), Infinity)
      if (Number.isFinite(exp) && this.snap.screen === 'quotes') {
        this.quoteTimer = setTimeout(() => {
          if (this.snap.screen === 'quotes' && !this.snap.busy) void this.refreshQuotes()
        }, Math.max(5_000, exp - Date.now() - 10_000))
      }
    } catch (e) {
      if (seq !== this.quoteSeq || this.destroyed) return
      this.fail(e)
      this.set({ quotesLoading: false })
    }
  }

  selectQuote(id: string) {
    this.set({ selectedQuoteId: id })
  }

  async confirm() {
    const quoteId = this.snap.selectedQuoteId
    if (!quoteId) return
    clearTimeout(this.quoteTimer)
    this.emit('quote.selected', { quoteId })
    this.set({ busy: true, error: undefined })
    try {
      const session = await this.opts.client.select(this.opts.clientSecret, {
        quoteId,
        ...(this.snap.walletAddress ? { walletAddress: this.snap.walletAddress } : {}),
      })
      this.set({ busy: false })
      this.applySession(session)
    } catch (e) {
      this.fail(e)
    }
  }

  /** Fire a SUBMIT or SURFACE_RESULT transition from the current step. */
  async fire(name: string, inputs?: Record<string, unknown>) {
    this.set({ busy: true, error: undefined })
    try {
      const session = await this.opts.client.transition(this.opts.clientSecret, name, inputs)
      this.set({ busy: false })
      this.applySession(session)
    } catch (e) {
      this.fail(e)
    }
  }

  /** For WALLET_TX surfaces: send with the wallet adapter, then report the hash. */
  async sendWalletTransactions() {
    const step = this.snap.session?.step
    if (step?.surface?.kind !== 'WALLET_TX') return
    if (!this.opts.wallet) {
      this.set({ error: orkError('BAD_REQUEST', { message: 'No wallet is connected.' }) })
      return
    }
    const t = step.transitions.find((x) => x.kind === 'SURFACE_RESULT' && x.expects === 'tx_hash')
    this.set({ busy: true, error: undefined })
    try {
      const { hash } = await this.opts.wallet.sendTransactions(step.surface.chain, step.surface.txs)
      this.set({ busy: false })
      if (t) await this.fire(t.name, { txHash: hash })
    } catch (e) {
      this.fail(e)
    }
  }

  openSurface() {
    const s = this.snap.session?.step.surface
    if (!s) return
    this.emit('surface.opened', { kind: s.kind })
    if (s.kind === 'REDIRECT' || s.kind === 'DEEPLINK') {
      // Must run inside the click handler so the browser allows the popup.
      // Do not pass 'noopener' in the features: then window.open returns null even on success.
      const w = typeof window !== 'undefined' ? window.open(s.url, '_blank') : null
      if (w) {
        try {
          w.opener = null
        } catch {}
      } else if (typeof window !== 'undefined' && s.kind === 'DEEPLINK') {
        window.location.href = s.url
      }
    }
  }

  /**
   * An embedded provider page (IFRAME surface) sent a message that the user completed, failed or
   * closed the payment. The UI must check the message origin and source before it calls this.
   *
   * The message is only a hint to check now. It never sets the outcome: a page can send any
   * message, so the result always comes from the server status (the next `step()` poll).
   * This emits `surface.message`, polls the step at once (skipping the backoff wait) and, for
   * `closed`, sets `surfaceClosed` so the UI can offer "Try again" or "Choose another method".
   */
  notifySurface(kind: SurfaceSignal, detail?: unknown) {
    const step = this.snap.session?.step
    if (this.destroyed || this.snap.screen !== 'step' || !step) return
    this.emit('surface.message', { kind, ...(detail !== undefined ? { detail } : {}) })
    if (kind === 'closed') this.set({ surfaceClosed: true })
    void this.pollNow(step)
  }

  /** Show the provider page again after the user closed it. */
  reopenSurface() {
    if (this.snap.surfaceClosed) this.set({ surfaceClosed: false })
  }

  back() {
    const screen = this.snap.screen
    clearTimeout(this.quoteTimer)
    if (screen === 'quotes') this.set({ screen: this.snap.method?.method === 'transfer' ? 'methods' : 'amount', error: undefined })
    else if (screen === 'amount') {
      const toTarget = this.snap.direction === 'withdraw' && this.snap.tab === 'crypto'
      this.set({ screen: toTarget ? 'target' : 'methods', error: undefined })
    }
    else if (screen === 'step' && this.snap.session?.step.state === 'PAYMENT') void this.restart()
  }

  close() {
    this.emit('modal.closed', { screen: this.snap.screen, state: this.snap.session?.step.state })
    if (this.snap.session?.step.state !== 'COMPLETED') this.rejectDone(orkError('BAD_REQUEST', { message: 'Closed before completion.', recovery: 'choose_other' }))
    this.destroy()
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.pollTimer)
    clearTimeout(this.quoteTimer)
    this.listeners.clear()
  }

  private applySession(session: PublicSession) {
    this.sessionSeq++
    const prev = this.snap.session?.step
    const sameStep = !!prev && prev.state === session.step.state && prev.sub === session.step.sub && prev.legIndex === session.step.legIndex
    this.set({ session, error: session.step.error, ...(sameStep ? {} : { surfaceClosed: false }) })
    if (!prev || prev.state !== session.step.state || prev.sub !== session.step.sub) {
      this.emit('step.changed', { state: session.step.state, sub: session.step.sub })
    }
    const step = session.step
    if (isTerminal(step.state)) {
      this.set({ screen: 'result' })
      clearTimeout(this.pollTimer)
      // Only COMPLETED settles `done`: after a failure the user may still try again.
      if (step.state === 'COMPLETED') this.resolveDone(session)
      return
    }
    if (step.state === 'SELECT_METHOD') {
      clearTimeout(this.pollTimer)
      this.set({ method: undefined, quotes: [], quoteErrors: [], selectedQuoteId: undefined, amount: '' })
      void this.replan()
      return
    }
    this.set({ screen: 'step' })
    this.schedulePoll(step)
  }

  private schedulePoll(step: Step, attempt = 0, startedAt = Date.now()) {
    clearTimeout(this.pollTimer)
    const aw = step.transitions.find((t): t is Extract<Transition, { kind: 'AWAIT' }> => t.kind === 'AWAIT')
    if (!aw || this.destroyed) return
    const delay = Math.min(aw.poll.intervalMs * aw.poll.backoff ** attempt, aw.poll.maxIntervalMs)
    if (Date.now() - startedAt > aw.poll.giveUpAfterMs) return
    this.pollTimer = setTimeout(() => void this.pollOnce(step, attempt, startedAt), delay)
  }

  /** True while a `pollNow()` request is in flight, so a burst of provider messages sends one request. */
  private pollingNow = false

  /** Poll now, then keep polling from the first backoff interval. */
  private async pollNow(step: Step) {
    if (this.pollingNow) return
    this.pollingNow = true
    clearTimeout(this.pollTimer)
    try {
      await this.pollOnce(step, -1, Date.now())
    } finally {
      this.pollingNow = false
    }
  }

  private async pollOnce(step: Step, attempt: number, startedAt: number) {
    const seq = this.sessionSeq
    try {
      const s = await this.opts.client.step(this.opts.clientSecret)
      if (this.destroyed) return
      // A transition answered while this poll was in flight: its session is newer, so keep it.
      if (seq !== this.sessionSeq) return
      const changed = s.step.state !== this.snap.session?.step.state || s.step.sub !== this.snap.session?.step.sub ||
        JSON.stringify(s.step.progress) !== JSON.stringify(this.snap.session?.step.progress)
      if (changed) this.applySession(s)
      else this.schedulePoll(step, attempt + 1, startedAt)
    } catch {
      if (this.destroyed || seq !== this.sessionSeq) return
      this.schedulePoll(step, attempt + 1, startedAt)
    }
  }
}

