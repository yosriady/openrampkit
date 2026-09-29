// Framework-free client. `createOpenRampClient` talks to the app's OpenRampKit server.
// `DepositController` holds the modal state; UIs render `getSnapshot()` and call its actions.

import { isTerminal, orkError } from '@openrampkit/core'
import type {
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
import { USDC, cmp } from '@openrampkit/core'

export type ClientOptions = {
  /** Base URL of the OpenRampKit server handler, e.g. `/api/openramp` or `https://ramp.example.workers.dev` */
  baseUrl: string
  fetch?: typeof fetch
}

export class OrkClientError extends Error {
  constructor(readonly error: OrkError, readonly status: number) {
    super(error.message)
  }
}

export function createOpenRampClient(opts: ClientOptions) {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const base = opts.baseUrl.replace(/\/$/, '')

  async function call<T>(secret: string, method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idem ? { 'idempotency-key': idem } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    if (!res.ok) throw new OrkClientError(json.error ?? orkError('INTERNAL'), res.status)
    return json as T
  }

  const sessionId = (secret: string) => secret.split('.')[0]!

  return {
    baseUrl: base,
    getSession: (secret: string) => call<PublicSession>(secret, 'GET', `/sessions/${sessionId(secret)}`),
    plan: (secret: string, body: { walletConnected: boolean; walletAddress?: string; surfaces?: string[] }) =>
      call<PlanResult>(secret, 'POST', `/sessions/${sessionId(secret)}/plan`, body),
    quotes: (secret: string, body: { method: string; amount: string; amountSide: 'source' | 'destination'; source?: { chain: string; token: string } }) =>
      call<{ quotes: Quote[]; errors: OrkError[] }>(secret, 'POST', `/sessions/${sessionId(secret)}/quotes`, body),
    select: (secret: string, body: { quoteId: string; walletAddress?: string }) =>
      call<PublicSession>(secret, 'POST', `/sessions/${sessionId(secret)}/select`, body, idemKey()),
    transition: (secret: string, name: string, inputs?: Record<string, unknown>) =>
      call<PublicSession>(secret, 'POST', `/sessions/${sessionId(secret)}/transitions/${encodeURIComponent(name)}`, { inputs: inputs ?? {} }, idemKey()),
    step: (secret: string) => call<PublicSession>(secret, 'GET', `/sessions/${sessionId(secret)}/step`),
  }
}

export type OpenRampClient = ReturnType<typeof createOpenRampClient>

function idemKey(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// ---------------- controller ----------------

export type Tab = 'crypto' | 'cash'

export type ScreenName = 'loading' | 'methods' | 'amount' | 'quotes' | 'step' | 'result' | 'error'

export type Snapshot = {
  screen: ScreenName
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
}

export type ControllerOptions = {
  client: OpenRampClient
  clientSecret: string
  wallet?: WalletAdapter
  /** Surfaces this UI can render. Defaults to all built-in ones. */
  surfaces?: string[]
  onEvent?: (e: OrkEvent) => void
}

const CRYPTO_KINDS = new Set(['crypto', 'exchange'])

export class DepositController {
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
      tab: 'crypto',
      amount: '',
      amountSide: 'source',
      quotes: [],
      quoteErrors: [],
      quotesLoading: false,
      busy: false,
      walletConnected: false,
      balances: [],
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
    const error = e instanceof OrkClientError ? e.error : orkError('INTERNAL', { message: e instanceof Error ? e.message : String(e) })
    this.set({ busy: false, error })
    return error
  }

  private started = false

  async start(): Promise<void> {
    if (!this.started) this.emit('modal.opened', {})
    this.started = true
    this.set({ screen: 'loading', error: undefined })
    try {
      let walletAddress: string | undefined
      if (this.opts.wallet) {
        const accounts = await this.opts.wallet.getAccounts().catch(() => [])
        walletAddress = accounts[0]?.address
      }
      const session = await this.opts.client.getSession(this.opts.clientSecret)
      this.set({ session, walletConnected: !!walletAddress, ...(walletAddress ? { walletAddress } : {}) })
      if (session.step.state !== 'SELECT_METHOD') return this.applySession(session)
      if (walletAddress && this.opts.wallet?.getBalances) {
        const accounts = await this.opts.wallet.getAccounts().catch(() => [])
        const balances = await this.opts.wallet.getBalances(accounts).catch(() => [] as WalletBalance[])
        this.set({ balances: balances.filter((b) => cmp(b.amount, '0') > 0) })
      }
      this.set({ source: this.defaultSource(session) })
      const plan = await this.opts.client.plan(this.opts.clientSecret, {
        walletConnected: !!walletAddress,
        ...(walletAddress ? { walletAddress } : {}),
        ...(this.opts.surfaces ? { surfaces: this.opts.surfaces } : {}),
      })
      const hasCrypto = plan.methods.some((m) => CRYPTO_KINDS.has(m.kind) && m.group !== 'unavailable')
      this.set({ plan, screen: 'methods', tab: session.destination.type === 'merchant' || !hasCrypto ? 'cash' : 'crypto' })
    } catch (e) {
      const error = this.fail(e)
      this.set({ screen: 'error', error })
    }
  }

  private async replan() {
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
    const destChain = session.destination.type === 'crypto' ? session.destination.chain : ''
    const chain = ['eip155:42161', 'eip155:8453', 'eip155:10'].find((c) => c !== destChain) ?? 'eip155:42161'
    return { chain, token: USDC[chain]!, symbol: 'USDC', decimals: 6 }
  }

  setSource(source: NonNullable<Snapshot['source']>) {
    this.set({ source })
    if (this.snap.method?.method === 'transfer' && this.snap.screen === 'quotes') void this.refreshQuotes()
  }

  setAmount(amount: string) {
    this.set({ amount: amount.replace(/[^0-9.]/g, '') })
  }

  async submitAmount() {
    if (!this.snap.amount || Number(this.snap.amount) <= 0) {
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
    this.set({ quotesLoading: true, error: undefined })
    try {
      const r = await this.opts.client.quotes(this.opts.clientSecret, {
        method: m.method,
        amount: this.snap.amount || '0',
        amountSide: this.snap.amountSide,
        ...((m.method === 'wallet' || m.method === 'transfer') && this.snap.source ? { source: { chain: this.snap.source.chain, token: this.snap.source.token } } : {}),
      })
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

  back() {
    const screen = this.snap.screen
    clearTimeout(this.quoteTimer)
    if (screen === 'quotes') this.set({ screen: this.snap.method?.method === 'transfer' ? 'methods' : 'amount', error: undefined })
    else if (screen === 'amount') this.set({ screen: 'methods', error: undefined })
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
    const prev = this.snap.session?.step
    this.set({ session, error: session.step.error })
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
    this.pollTimer = setTimeout(async () => {
      try {
        const s = await this.opts.client.step(this.opts.clientSecret)
        if (this.destroyed) return
        const changed = s.step.state !== this.snap.session?.step.state || s.step.sub !== this.snap.session?.step.sub ||
          JSON.stringify(s.step.progress) !== JSON.stringify(this.snap.session?.step.progress)
        if (changed) this.applySession(s)
        else this.schedulePoll(step, attempt + 1, startedAt)
      } catch {
        this.schedulePoll(step, attempt + 1, startedAt)
      }
    }, delay)
  }
}

export type { MethodOption, PlanResult, PublicSession, Quote, Step, WalletAdapter, WalletBalance } from '@openrampkit/core'
export { createMockWallet } from './mock-wallet.js'
