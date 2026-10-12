// `RampController` (exported also as `DepositController` and `WithdrawController`) holds the modal
// state for one session. UIs render `getSnapshot()` and call its actions. The session's direction
// picks the flow: deposit (methods, amount, quotes) or withdraw (target, amount, quotes).

import { CHAINS, USDC, accountFor, defaultSourceTokens, exchangeOptions, nativeDecimals, sourceTokenKey, chainNamespace, cmp, createClientEvent, currencyForCountry, isAddressTransfer, isSafeLinkUrl, isTerminal, isWebUrl, openRampError } from '@openrampkit/core'
import type {
  Direction,
  MethodOption,
  OpenRampError,
  ClientEvent,
  ClientEventFields,
  ClientEventType,
  PlanResult,
  PublicSession,
  PublicQuote,
  ExchangeOption,
  SourceChain,
  Step,
  Transition,
  WalletAdapter,
  WalletBalance,
} from '@openrampkit/core'
import { toOpenRampError } from './client.js'
import type { DepositAddressView, OpenRampClient } from './client.js'

/** The longest delay that `setTimeout` takes (2^31 - 1 ms); a longer one fires at once */
const MAX_TIMER_MS = 2_147_483_647

export type Tab = 'crypto' | 'cash'

/** What an embedded provider page reported, via `notifySurface()`. */
export type SurfaceSignal = 'completed' | 'failed' | 'closed'

/** `target` is the withdraw "To wallet" form (network, token, address). */
export type ScreenName = 'loading' | 'target' | 'methods' | 'exchanges' | 'deposit_address' | 'amount' | 'quotes' | 'step' | 'result' | 'error'

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
  quotes: PublicQuote[]
  quoteErrors: OpenRampError[]
  quotesLoading: boolean
  selectedQuoteId?: string
  busy: boolean
  error?: OpenRampError
  walletConnected: boolean
  walletAddress?: string
  balances: WalletBalance[]
  /** Token the user pays with, for `wallet` and `transfer` */
  source?: { chain: string; token: string; symbol?: string; decimals?: number }
  /**
   * Deposit: chains and tokens of the source picker for an address transfer, from the server (with
   * logos). Undefined until it loads or when it fails: a UI then uses `defaultSourceTokens`.
   */
  sources?: SourceChain[]
  /** Deposit: the exchange the user picked in the "From an exchange" picker (an `ExchangeOption` id) */
  exchange?: string
  /** Amount chips per currency code, from `FlowOptions.presets` */
  presets?: Record<string, string[]>
  /** Deposit, method `deposit_address`: the user's standing address for the current `source` */
  depositAddress?: DepositAddressView
  /** True while the standing address for the current `source` loads */
  depositAddressLoading?: boolean
  /** The provider page (IFRAME surface) said the user closed it. Cleared by `reopenSurface()` or a new step. */
  surfaceClosed: boolean
  /** Withdraw: the "To wallet" form */
  target?: TargetDraft
  /** Withdraw: the currency paid out on the "To cash" tab */
  cashCurrency?: string
}

/**
 * How the flow opens, set by the app per session. Every option is optional, and an option that does not
 * fit the session (a method the plan does not have, a tab with no methods) is ignored.
 */
export type FlowOptions = {
  /** The tab to show first. Deposit: `crypto` (wallet, transfer, exchanges) or `cash`. Withdraw: `crypto` (To wallet) or `cash` (To cash). */
  initialTab?: Tab
  /** Deposit: open this method at once, for example `qris`, `transfer` or `exchanges` (the exchange picker) */
  initialMethod?: string
  /** With `initialMethod`: hide the way back to the method list */
  lockMethod?: boolean
  /** Amount to fill in, for example `'50'` */
  amount?: string
  /** Amount chips per currency code (a fiat code, or a token symbol for a wallet deposit), for example `{ USD: ['20', '50', '100'] }`. At most 4 show. */
  presets?: Record<string, string[]>
  /** Deposit: the token the user pays with first (wallet and transfer). Without `token`: USDC on the chain, else the native token. */
  defaultSource?: { chain: string; token?: string }
  /** Withdraw: the chain and token to receive first on the "To wallet" tab */
  defaultTarget?: { chain: string; token?: string }
  /**
   * Withdraw: the amount the user can withdraw, in the source token, when no wallet reports it (for
   * example `custody: 'app'`). It turns on the MAX chip and the check against the balance.
   */
  balance?: string
}

export type ControllerOptions = {
  client: OpenRampClient
  clientSecret: string
  /** How the flow opens (tab, method, amount, defaults) */
  flow?: FlowOptions
  wallet?: WalletAdapter
  /** Surfaces this UI can render. Defaults to all built-in ones. */
  surfaces?: string[]
  onEvent?: (e: ClientEvent) => void
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
    { token: 'native', symbol: CHAINS[chain]?.nativeSymbol ?? 'ETH', decimals: nativeDecimals(chain) },
  ]
}

/** Keeps digits and the first decimal point, so "1,000.50" becomes "1000.50". */
function cleanAmount(amount: string): string {
  const clean = amount.replace(/[^0-9.]/g, '')
  const dot = clean.indexOf('.')
  return dot < 0 ? clean : clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '')
}

function upperKeys(presets: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(presets).map(([k, v]) => [k.toUpperCase(), Array.isArray(v) ? v.map((x) => cleanAmount(String(x))).filter(Boolean) : []]))
}

const CRYPTO_KINDS = new Set(['crypto', 'exchange'])

/** The method that shows the user's standing deposit address (server option `depositAddresses.widget`) */
export const DEPOSIT_ADDRESS_METHOD = 'deposit_address'

export class RampController {
  private snap: Snapshot
  private listeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private quoteTimer: ReturnType<typeof setTimeout> | undefined
  private resolveDone!: (s: PublicSession) => void
  private rejectDone!: (e: OpenRampError) => void
  private destroyed = false
  /** Resolves when the session reaches a terminal state */
  readonly done: Promise<PublicSession>

  constructor(private readonly opts: ControllerOptions) {
    this.snap = {
      screen: 'loading',
      direction: opts.expect ?? 'deposit',
      tab: 'crypto',
      amount: cleanAmount(opts.flow?.amount ?? ''),
      ...(opts.flow?.presets ? { presets: upperKeys(opts.flow.presets) } : {}),
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

  private emit<T extends ClientEventType>(type: T, object: ClientEventFields[T]) {
    if (!this.opts.onEvent) return
    const session = this.snap.session
    this.opts.onEvent(createClientEvent(type, object, { livemode: session?.livemode ?? false, ...(session ? { sessionId: session.id } : {}) }) as ClientEvent)
  }

  private fail(e: unknown) {
    const error = toOpenRampError(e)
    this.set({ busy: false, error })
    return error
  }

  private started = false
  /** Wallet accounts read at start */
  private accounts: Array<{ chain: string; address: string }> = []
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
      this.accounts = accounts
      const session = await this.opts.client.getSession(this.opts.clientSecret)
      // Withdraw: the account on the source chain (an EVM and a Solana wallet can both be connected).
      const walletAddress: string | undefined = (session.source ? accountFor(accounts, session.source.chain) : undefined)?.address ?? accounts[0]?.address
      if (this.opts.expect && session.direction !== this.opts.expect) {
        throw openRampError('BAD_REQUEST', { message: `This is not a ${this.opts.expect} session.` })
      }
      this.set({ session, direction: session.direction, walletConnected: !!walletAddress, ...(walletAddress ? { walletAddress } : {}) })
      if (session.step.state !== 'SELECT_METHOD') return this.applySession(session)
      if (walletAddress && this.opts.wallet?.getBalances) {
        const balances = await this.opts.wallet.getBalances(accounts).catch(() => [] as WalletBalance[])
        this.set({ balances: balances.filter((b) => cmp(b.amount, '0') > 0) })
      }
      const hostBalance = this.hostBalance(session)
      if (hostBalance) this.set({ balances: [...this.snap.balances, hostBalance] })
      if (session.direction === 'withdraw') return this.startWithdraw(session)
      this.set({ source: this.defaultSource(session) })
      const plan = await this.opts.client.plan(this.opts.clientSecret, {
        walletConnected: !!walletAddress,
        ...(walletAddress ? { walletAddress } : {}),
        ...(this.opts.surfaces ? { surfaces: this.opts.surfaces } : {}),
      })
      const hasCrypto = plan.methods.some((m) => CRYPTO_KINDS.has(m.kind) && m.group !== 'unavailable')
      const hasCash = plan.methods.some((m) => !CRYPTO_KINDS.has(m.kind) && m.group !== 'unavailable')
      const wanted = this.opts.flow?.initialTab
      const tab = wanted === 'crypto' && hasCrypto ? 'crypto' : wanted === 'cash' && hasCash ? 'cash' : session.destination?.type === 'merchant' || !hasCrypto ? 'cash' : 'crypto'
      this.set({ plan, screen: 'methods', tab })
      await this.openInitialMethod()
    } catch (e) {
      const error = this.fail(e)
      this.set({ screen: 'error', error })
    }
  }

  /** `FlowOptions.initialMethod`: open the method (or the exchange picker) when the plan has it */
  private async openInitialMethod() {
    const want = this.opts.flow?.initialMethod
    if (!want) return
    if (want === 'exchanges') return this.openExchanges()
    const m = this.snap.plan?.methods.find((x) => x.method === want && x.group !== 'unavailable')
    if (!m) return
    this.set({ tab: CRYPTO_KINDS.has(m.kind) ? 'crypto' : 'cash' })
    await this.selectMethod(want)
  }

  /** False when `lockMethod` keeps the user on the app's `initialMethod` */
  canGoBack(): boolean {
    const f = this.opts.flow
    if (!f?.lockMethod || !f.initialMethod) return true
    const screen = this.snap.screen
    if (f.initialMethod === 'exchanges') return screen !== 'exchanges'
    return this.snap.method?.method !== f.initialMethod || (screen === 'quotes' && !isAddressTransfer(this.snap.method?.method))
  }

  /** Withdraw: `FlowOptions.balance` as a balance of the session's source token, when no wallet reported one */
  private hostBalance(session: PublicSession): WalletBalance | undefined {
    const amount = this.opts.flow?.balance
    const src = session.source
    if (session.direction !== 'withdraw' || !src || !amount || !/^\d+(\.\d+)?$/.test(amount)) return undefined
    if (this.snap.balances.some((b) => b.chain === src.chain && b.token.toLowerCase() === src.token.toLowerCase())) return undefined
    return { chain: src.chain, token: src.token, symbol: src.symbol ?? 'USDC', decimals: src.decimals ?? 6, amount }
  }

  /** The plan that loads after a restart (see `applySession`) */
  private replanning: Promise<void> | undefined

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
    const locked = this.lockedTarget()
    if (locked) tab = locked.type === 'crypto' ? 'crypto' : 'cash'
    this.set({ tab })
    if (this.snap.direction !== 'withdraw' || !this.snap.session) return
    this.set({ error: undefined, method: undefined, quotes: [], quoteErrors: [], selectedQuoteId: undefined })
    if (locked) void this.loadLockedPlan()
    else if (tab === 'crypto') {
      this.targetSeq++ // drop a cash plan that is still loading
      this.set({ screen: 'target' })
    } else void this.loadCashMethods()
  }

  // ---------- withdraw ----------

  /**
   * The target the app set and locked at creation (`destinationLocked`), else undefined. With a locked
   * target the controller skips the target screen and never calls `/target`.
   */
  lockedTarget(): Extract<NonNullable<PublicSession['destination']>, { type: 'crypto' | 'fiat' }> | undefined {
    const s = this.snap.session
    const d = s?.direction === 'withdraw' && s.destinationLocked ? s.destination : undefined
    return d && (d.type === 'crypto' || d.type === 'fiat') ? d : undefined
  }

  /** Tabs the app allows for this withdrawal: `crypto` (To wallet) and `cash` (To cash). A locked target gives one tab. */
  withdrawTabs(): Tab[] {
    const locked = this.lockedTarget()
    if (locked) return [locked.type === 'crypto' ? 'crypto' : 'cash']
    const allowed = this.snap.session?.allowedDestinations
    if (!allowed) return ['crypto', 'cash']
    return [...(allowed.crypto ? (['crypto'] as const) : []), ...(allowed.fiat ? (['cash'] as const) : [])]
  }

  /** Networks the user may withdraw to: the allowed chains, else every chain with USDC plus the source chain. */
  withdrawChains(): string[] {
    const src = this.snap.session?.source
    const allowed = this.snap.session?.allowedDestinations?.crypto?.chains
    if (allowed?.length) return allowed
    const chains = Object.keys(USDC)
    if (src && !chains.includes(src.chain)) chains.unshift(src.chain)
    return chains
  }

  private startWithdraw(session: PublicSession) {
    const src = session.source
    const chains = this.withdrawChains()
    const want = this.opts.flow?.defaultTarget
    const chain = want && chains.includes(want.chain) ? want.chain : src && chains.includes(src.chain) ? src.chain : chains[0] ?? 'eip155:8453'
    const allowedCur = session.allowedDestinations?.fiat?.currencies?.map((c) => c.toUpperCase())
    const local = currencyForCountry(session.country).toUpperCase()
    const cashCurrency = !allowedCur?.length || allowedCur.includes(local) ? local : allowedCur[0]!
    const keep = want?.chain === chain ? want.token : undefined
    this.set({ target: { ...this.draftFor(chain, src, keep), address: accountFor(this.accounts, chain)?.address ?? this.snap.walletAddress ?? '' }, cashCurrency })
    const locked = this.lockedTarget()
    if (locked?.type === 'crypto') {
      // Read only: the UI shows it, and the amount screen names it.
      const known = this.targetTokens(locked.chain).find((o) => o.token.toLowerCase() === locked.token.toLowerCase())
      this.set({
        target: { chain: locked.chain, token: locked.token, symbol: locked.symbol ?? known?.symbol ?? 'TOKEN', decimals: locked.decimals ?? known?.decimals ?? 18, address: locked.address },
      })
    } else if (locked?.type === 'fiat') this.set({ cashCurrency: locked.currency })
    if (locked) {
      this.set({ tab: locked.type === 'crypto' ? 'crypto' : 'cash' })
      return this.loadLockedPlan()
    }
    const tabs = this.withdrawTabs()
    if (!tabs.length) {
      this.set({ screen: 'error', error: openRampError('DESTINATION_NOT_ALLOWED') })
      return
    }
    const wanted = this.opts.flow?.initialTab
    this.setTab(wanted && tabs.includes(wanted) ? wanted : tabs[0]!)
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
    // A Solana address is not valid on an EVM chain (and back): switch to the wallet's account of that kind.
    const sameKind = !!cur && chainNamespace(cur.chain) === chainNamespace(chain)
    const address = sameKind ? cur.address : (accountFor(this.accounts, chain)?.address ?? '')
    this.set({ target: { ...next, address }, error: undefined })
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
      this.set({ error: openRampError('BAD_REQUEST', { message: 'Enter a valid address for this network.' }) })
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

  /** Locked target: the server already has it, so only get the plan (`/plan`), then show the payout methods. */
  private async loadLockedPlan() {
    const seq = ++this.targetSeq
    this.set({ screen: 'loading', plan: undefined })
    try {
      const plan = await this.opts.client.plan(this.opts.clientSecret, this.planFields())
      if (seq !== this.targetSeq || this.destroyed) return
      this.set({ plan })
      const usable = plan.methods.filter((m) => m.group !== 'unavailable')
      if (this.snap.tab === 'crypto' && usable.length === 1) return this.selectMethod(usable[0]!.method)
      this.set({ screen: 'methods' })
    } catch (e) {
      if (seq !== this.targetSeq || this.destroyed) return
      this.set({ screen: 'error', error: this.fail(e) })
    }
  }

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

  /** Deposit: rows of the "From an exchange" picker. Empty when the plan has no connect method. */
  exchangeOptions(): ExchangeOption[] {
    return this.snap.direction === 'withdraw' ? [] : exchangeOptions(this.snap.plan?.methods ?? [])
  }

  /** Show the exchange picker */
  openExchanges() {
    if (!this.exchangeOptions().length) return
    this.set({ screen: 'exchanges', exchange: undefined, error: undefined })
  }

  /** Pick an exchange: start its connect method, else the deposit address method. */
  async selectExchange(id: string) {
    const row = this.exchangeOptions().find((x) => x.id === id)
    if (row) return this.selectMethod(row.method, { exchange: row.id })
  }

  /**
   * The deposit method to offer when the payment on the exchange's page did not work: the picked
   * exchange's `fallback`, while that payment waits for the user or after it failed.
   */
  depositFallback(): ExchangeOption | undefined {
    const row = this.exchangeOptions().find((x) => x.id === this.snap.exchange)
    if (!row?.fallback || this.snap.method?.method !== row.method) return undefined
    const state = this.snap.session?.step.state
    return state === 'PAYMENT' || state === 'FAILED' ? row : undefined
  }

  /**
   * Leave the exchange payment and send from the same exchange to a deposit address. The server refuses
   * the restart when the exchange already took the payment, so the user cannot pay twice.
   */
  async depositInstead() {
    const row = this.depositFallback()
    if (!row?.fallback) return
    this.replanning = undefined
    await this.restart()
    await this.replanning
    if (this.snap.screen === 'methods' && !this.snap.error) await this.selectMethod(row.fallback, { exchange: row.id })
  }

  async selectMethod(method: string, opts: { exchange?: string } = {}) {
    const m = this.snap.plan?.methods.find((x) => x.method === method)
    if (!m || m.group === 'unavailable') return
    this.emit('method.selected', { method })
    this.set({ method: m, exchange: opts.exchange, quotes: [], quoteErrors: [], error: undefined, selectedQuoteId: undefined })
    if (method === DEPOSIT_ADDRESS_METHOD) {
      // No payment in this session: the widget shows the user's standing address for the chosen token.
      this.set({ screen: 'deposit_address', depositAddress: undefined })
      void this.loadSources('transfer')
      return this.loadDepositAddress()
    }
    if (isAddressTransfer(method)) {
      // No amount needed: the user sends any amount to a deposit address.
      this.set({ amount: '', screen: 'quotes' })
      void this.loadSources(method)
      return this.refreshQuotes()
    }
    this.set({ screen: 'amount', amountSide: 'source' })
  }

  /** Default pay-with token: the largest wallet balance, else USDC on a chain other than the destination. */
  private defaultSource(session: PublicSession): Snapshot['source'] {
    const want = this.opts.flow?.defaultSource
    if (want?.chain) {
      const tokens = defaultSourceTokens(want.chain)
      const t = want.token ? (tokens.find((o) => sourceTokenKey(want.chain, o.token) === sourceTokenKey(want.chain, want.token!)) ?? { token: want.token }) : tokens[0]!
      return { chain: want.chain, token: t.token, ...('symbol' in t ? { symbol: t.symbol, decimals: t.decimals } : {}) }
    }
    const top = [...this.snap.balances].sort((a, b) => cmp(b.usd ?? b.amount, a.usd ?? a.amount))[0]
    if (top) return { chain: top.chain, token: top.token, symbol: top.symbol, decimals: top.decimals }
    const destChain = session.destination?.type === 'crypto' ? session.destination.chain : ''
    const chain = ['eip155:42161', 'eip155:8453', 'eip155:10'].find((c) => c !== destChain) ?? 'eip155:42161'
    return { chain, token: USDC[chain]!, symbol: 'USDC', decimals: 6 }
  }

  private sourcesFor?: string

  /** Load the source picker list for a method once. On an error the picker keeps the default list. */
  async loadSources(method: string) {
    if (this.sourcesFor === method && this.snap.sources) return
    this.sourcesFor = method
    try {
      const { chains } = await this.opts.client.sources(this.opts.clientSecret, method)
      if (!this.destroyed && this.sourcesFor === method && Array.isArray(chains)) this.set({ sources: chains })
    } catch {
      if (this.sourcesFor === method) this.sourcesFor = undefined
    }
  }

  private depositAddressSeq = 0

  /** Method `deposit_address`: load the standing address for the current `source`. A newer call wins. */
  async loadDepositAddress() {
    const src = this.snap.source
    if (!src) return
    const seq = ++this.depositAddressSeq
    this.set({ depositAddressLoading: true, error: undefined })
    try {
      const view = await this.opts.client.depositAddress(this.opts.clientSecret, { chain: src.chain, token: src.token })
      if (seq === this.depositAddressSeq && !this.destroyed) this.set({ depositAddress: view, depositAddressLoading: false })
    } catch (e) {
      if (seq === this.depositAddressSeq) this.set({ depositAddress: undefined, depositAddressLoading: false, error: toOpenRampError(e) })
    }
  }

  setSource(source: NonNullable<Snapshot['source']>) {
    this.set({ source })
    if (this.snap.screen === 'deposit_address') {
      this.set({ depositAddress: undefined })
      void this.loadDepositAddress()
      return
    }
    if (isAddressTransfer(this.snap.method?.method) && this.snap.screen === 'quotes') void this.refreshQuotes()
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
      this.set({ error: openRampError('BAD_REQUEST', { message: 'Enter an amount.' }) })
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
        ...(this.snap.direction === 'deposit' && (m.method === 'wallet' || isAddressTransfer(m.method)) && this.snap.source
          ? { source: { chain: this.snap.source.chain, token: this.snap.source.token } }
          : {}),
      })
      // Drop a response that a newer request, a new method or destroy() made stale.
      if (seq !== this.quoteSeq || this.destroyed || this.snap.method !== m) return
      const first = r.quotes[0]
      this.set({ quotes: r.quotes, quoteErrors: r.errors, quotesLoading: false, ...(first ? { selectedQuoteId: first.id } : {}) })
      this.emit('quotes.shown', { method: m.method, count: r.quotes.length })
      // Re-quote shortly before the earliest expiry while the quote screen is open.
      const exp = r.quotes.map((q) => Date.parse(q.expiresAt)).filter((t) => Number.isFinite(t)).reduce((a, b) => Math.min(a, b), Infinity)
      if (Number.isFinite(exp) && this.snap.screen === 'quotes') {
        this.quoteTimer = setTimeout(() => {
          if (this.snap.screen === 'quotes' && !this.snap.busy) void this.refreshQuotes()
          // A timer longer than 2^31 - 1 ms fires at once, so cap it (a quote that lives for weeks).
        }, Math.min(MAX_TIMER_MS, Math.max(5_000, exp - Date.now() - 10_000)))
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
    // Pay with wallet: the account on the chain the user pays from (e.g. Solana while an EVM wallet is also connected).
    const payFrom = this.snap.direction !== 'withdraw' && this.snap.method?.method === 'wallet' && this.snap.source
      ? accountFor(this.accounts, this.snap.source.chain)?.address
      : undefined
    const walletAddress = payFrom ?? this.snap.walletAddress
    try {
      const session = await this.opts.client.select(this.opts.clientSecret, {
        quoteId,
        ...(walletAddress ? { walletAddress } : {}),
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
      this.set({ error: openRampError('BAD_REQUEST', { message: 'No wallet is connected.' }) })
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
      // Never open a `javascript:` or `data:` URL. A deep link may use an app scheme (e.g. gcash://).
      if (s.kind === 'REDIRECT' ? !isWebUrl(s.url, { allowHttp: true }) : !isSafeLinkUrl(s.url)) return
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
    if (!this.canGoBack()) return
    const screen = this.snap.screen
    clearTimeout(this.quoteTimer)
    const list = this.snap.exchange ? 'exchanges' : 'methods'
    if (screen === 'exchanges' || screen === 'deposit_address') this.set({ screen: 'methods', error: undefined })
    else if (screen === 'quotes') this.set({ screen: isAddressTransfer(this.snap.method?.method) ? list : 'amount', error: undefined })
    else if (screen === 'amount') {
      const toTarget = this.snap.direction === 'withdraw' && this.snap.tab === 'crypto' && !this.lockedTarget()
      this.set({ screen: toTarget ? 'target' : list, error: undefined })
    }
    else if (screen === 'step' && this.snap.session?.step.state === 'PAYMENT') void this.restart()
  }

  close() {
    this.emit('modal.closed', { screen: this.snap.screen, state: this.snap.session?.step.state })
    if (this.snap.session?.step.state !== 'COMPLETED') this.rejectDone(openRampError('BAD_REQUEST', { message: 'Closed before completion.', recovery: 'choose_other' }))
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
    const detail = session.step.detail?.code
    const sameStep = !!prev && prev.state === session.step.state && prev.detail?.code === detail && prev.legIndex === session.step.legIndex
    this.set({ session, error: session.step.error, ...(sameStep ? {} : { surfaceClosed: false }) })
    if (!prev || prev.state !== session.step.state || prev.detail?.code !== detail) {
      this.emit('step.changed', { state: session.step.state, ...(detail ? { detail } : {}) })
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
      this.replanning = this.replan()
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
      const cur = this.snap.session
      const changed = s.step.state !== cur?.step.state || JSON.stringify(s.step.detail) !== JSON.stringify(cur?.step.detail) ||
        JSON.stringify(s.payment) !== JSON.stringify(cur?.payment)
      if (changed) this.applySession(s)
      else this.schedulePoll(step, attempt + 1, startedAt)
    } catch {
      if (this.destroyed || seq !== this.sessionSeq) return
      this.schedulePoll(step, attempt + 1, startedAt)
    }
  }
}

