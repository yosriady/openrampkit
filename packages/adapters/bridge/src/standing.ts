// Standing deposit addresses on Bridge (see `Adapter.standingAddress` and `Adapter.standingAccount`):
//
// - Fiat in (`bank` route): a Bridge virtual account. The user pays USD, EUR, MXN, BRL or GBP by bank
//   transfer, at any time, and Bridge delivers USDC to the destination. Deposits come from
//   GET /v0/customers/{id}/virtual_accounts/{va}/history (grouped by `deposit_id`) and from
//   `virtual_account.activity` webhooks.
// - Crypto in (`convert` route): a Bridge liquidation address. The user sends USDC on one chain, and
//   Bridge delivers USDC on another chain to the destination. Each deposit is a drain:
//   GET /v0/customers/{id}/liquidation_addresses/{la}/drains and `liquidation_address.drain` webhooks.
//
// Money safety:
// - The Bridge customer comes from the server only: the app's `customer` hook (`customerId`), else the
//   customer that an earlier Bridge KYC of this adapter made for the same user id. The browser never
//   gives it. One customer belongs to one user id (`custuser:` claim): another user gets 409.
// - The destination is the one the server passed. Bridge's echo of the account (its `destination`) must
//   match it, or the call fails (502). A drain or a deposit that Bridge reports as delivered somewhere
//   else fails its session.
// - One deposit, one owner: a virtual account deposit is claimed with `dep:{deposit_id}` (the same key
//   as the session flow, so a session and a standing account never both take one deposit), a drain with
//   `drain:{drain_id}`. Both use `claimOnce`, one atomic step on stores with `putIfAbsent`.
// - Webhooks find the account by the server-side index (`sacct:{id}`), never by a ref in the body, and
//   the event's customer must be the account's customer. An event becomes a leg event only for a
//   deposit that this account already claimed; the server maps its leg ref to the session.
// - Amounts and currencies: a deposit counts only in the account's own source currency (the virtual
//   account currency, or USDC for a liquidation address); anything else is skipped and logged.

import { claimOnce, findDeliverAsset, legStepFromEvent, statusMap } from '@openrampkit/adapter'
import type { AdapterContext, LegEvent, Logger, StandingAccountDepositsInput, StandingAccountInput, StandingAccountResult, StandingAddressInput, StandingDeposit, StandingDepositsInput } from '@openrampkit/adapter'
import { OpenRampException, cmp, isDecimal, openRampError } from '@openrampkit/core'
import type { CryptoAsset, LegStatus, LegStep, PollSpec, StepDetailCode } from '@openrampkit/core'

type Ctx = Pick<AdapterContext, 'fetch' | 'log' | 'shared'>

/** What the adapter's index gives this module */
export type StandingRuntime = {
  call<T>(ctx: Pick<AdapterContext, 'fetch' | 'log'>, method: 'GET' | 'POST', path: string, what: string, body?: unknown, idem?: string): Promise<T>
  chains: ReadonlyArray<{ chain: string; rail: string; usdc: string }>
  /** Deposit rails by currency (upper case), with the endorsement each one needs */
  rails: ReadonlyArray<{ currency: string; endorsement: string }>
  customerHook?: (user: { userId: string }) => Promise<{ customerId?: string } | undefined>
  /** The `shared` key of the adapter's own record of a user (customer id from an earlier KYC) */
  userKey(userId: string): string
  /** Virtual account event type to a leg status (undefined: not a payment event, or unknown, logged) */
  vaMap(type: string, log?: Pick<Logger, 'warn'>): { status: LegStatus; detail?: StepDetailCode; rank: number } | undefined
  bankFields(i: DepositInstructions): Array<{ label: string; value: string; copy: boolean }>
  developerFeePercent?: string
  poll: PollSpec
}

/** Bridge's bank details of a virtual account (the fields this adapter reads) */
export type DepositInstructions = {
  currency?: string
  bank_name?: string
  bank_address?: string
  bank_routing_number?: string
  bank_account_number?: string
  bank_beneficiary_name?: string
  bank_beneficiary_address?: string
  payment_rails?: string[]
  iban?: string
  bic?: string
  account_holder_name?: string
  clabe?: string
  br_code?: string
  account_number?: string
  sort_code?: string
  deposit_message?: string
}

type VirtualAccount = {
  id: string
  status?: string
  customer_id?: string
  source_deposit_instructions?: DepositInstructions
  destination?: { currency?: string; payment_rail?: string; address?: string }
}

type LiquidationAddress = {
  id: string
  customer_id?: string
  chain?: string
  currency?: string
  address?: string
  state?: string
  destination_payment_rail?: string
  destination_currency?: string
  destination_address?: string
  external_account_id?: string | null
  bridge_wallet_id?: string | null
  prefunded_account_id?: string | null
}

export type VaEvent = {
  id: string
  type: string
  customer_id?: string
  virtual_account_id?: string
  amount?: string
  currency?: string
  deposit_id?: string
  destination_tx_hash?: string
  destination_payment_rail?: string
  created_at?: string
  receipt?: { final_amount?: string; destination_tx_hash?: string }
}

export type Drain = {
  id: string
  customer_id?: string
  liquidation_address_id?: string
  amount?: string
  currency?: string
  state?: string
  created_at?: string
  deposit_tx_hash?: string
  source_payment_rail?: string
  destination?: { payment_rail?: string; currency?: string; to_address?: string }
  destination_tx_hash?: string
  receipt?: { outgoing_amount?: string; converted_amount?: string }
}

/** What the adapter keeps for one standing account or address (no TTL; the server keeps its own record) */
type AccountRec = {
  kind: 'va' | 'la'
  id: string
  userId: string
  customerId: string
  /** Virtual account: the source currency, upper case */
  currency?: string
  /** Liquidation address: the source chain and its Bridge rail */
  srcChain?: string
  srcRail?: string
  /** The destination: USDC on a chain, its Bridge rail, and the address */
  asset: CryptoAsset
  rail: string
  address: string
  /** ms */
  createdAt: number
}

/**
 * Drain `state` to a leg status. `awaiting_funds`: Bridge saw the deposit and waits for it to confirm
 * (no session yet). A state that is not in the table is no event (it is logged).
 */
const DRAIN_STATE = statusMap<{ status: LegStatus; detail?: StepDetailCode } | 'awaiting_funds'>('Bridge drain', {
  awaiting_funds: 'awaiting_funds',
  funds_received: { status: 'processing', detail: 'settling' },
  in_review: { status: 'processing', detail: 'delayed' },
  payment_submitted: { status: 'processing', detail: 'settling' },
  refund_in_flight: { status: 'processing', detail: 'refunding' },
  payment_processed: { status: 'succeeded' },
  refunded: { status: 'refunded' },
  undeliverable: { status: 'failed' },
  returned: { status: 'failed' },
  missing_return_policy: { status: 'failed' },
  refund_failed: { status: 'failed' },
  error: { status: 'failed' },
  canceled: { status: 'failed' },
})

/** Virtual account event types that are about the outgoing USDC (their amount is in the destination currency) */
const OUTGOING = new Set(['payment_submitted', 'payment_processed'])

/** The account ref (`standingAddress` and `standingAccount`) and the leg ref of one deposit */
const ACCOUNT_REF = 'bsa|'
export const STANDING_DEPOSIT_REF = 'bsd|'

/** How long a deposit claim lasts (longer than any poll window of the server) */
const CLAIM_TTL_SEC = 400 * 24 * 60 * 60
/** Webhook events kept for the next poll, per account */
const INBOX_MAX = 100
const INBOX_TTL_SEC = 7 * 24 * 60 * 60
/** Pages of 100 that one poll reads at most */
const MAX_PAGES = 5
const PAGE = 100
/** A minute of slack for clock skew between Bridge and this server */
const SKEW_MS = 60_000
/** The session flow's virtual account cache lifetime (see `ensureVirtualAccount` in index.ts) */
const VA_CACHE_TTL_SEC = 30 * 24 * 60 * 60

const ID = /^[A-Za-z0-9_-]{1,64}$/

const bad = (message: string) => new OpenRampException(openRampError('BAD_REQUEST', { message }), 400)
const conflict = (message: string) => new OpenRampException(openRampError('CONFLICT', { message }), 409)
const unavailable = (message: string) => new OpenRampException(openRampError('PROVIDER_UNAVAILABLE', { message }), 502)

/** The same address: EVM addresses in any case, other chains exactly */
function sameAddress(a: string | undefined | null, b: string): boolean {
  if (typeof a !== 'string' || !a) return false
  return a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b
}

const lower = (s: string | undefined | null) => (typeof s === 'string' ? s.toLowerCase() : undefined)

function positive(s: string | undefined | null): string | undefined {
  return typeof s === 'string' && isDecimal(s) && cmp(s, '0') > 0 ? s : undefined
}

async function sha(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

function list<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  const data = (res as { data?: unknown } | undefined)?.data
  return Array.isArray(data) ? (data as T[]) : []
}

export function bridgeStanding(rt: StandingRuntime) {
  const { call } = rt

  const accountKey = (id: string) => `sacct:${id}`
  const inboxKey = (id: string) => `sinbox:${id}`
  const owner = (id: string) => `standing:${id}`

  // ---------- the customer ----------

  /**
   * The Bridge customer of an app user: the `customer` hook, else the customer that this adapter's KYC
   * made for the same user id. Never from the browser. The first user id to use a customer keeps it.
   */
  async function customerOf(userId: string, ctx: Ctx): Promise<string> {
    const hint = rt.customerHook ? await rt.customerHook({ userId }) : undefined
    const known = await ctx.shared.get<{ customerId?: string }>(rt.userKey(userId))
    const id = hint?.customerId ?? known?.customerId
    if (!id) throw conflict('This user has no Bridge customer yet. Finish Bridge KYC first, or return the customerId from the `customer` option.')
    if (typeof id !== 'string' || !ID.test(id)) throw unavailable('The Bridge customer id is not valid.')
    if (!(await claimOnce(ctx.shared, `custuser:${id}`, userId, 0))) {
      ctx.log.error('bridge: a Bridge customer id was given for two app users; refused', { customerId: id })
      throw conflict('This Bridge customer belongs to another user.')
    }
    return id
  }

  /** The customer must be active, with the rail's endorsement approved when Bridge lists endorsements. */
  async function checkCustomer(customerId: string, endorsement: string | undefined, ctx: Ctx): Promise<void> {
    const c = await call<{ id?: string; status?: string; endorsements?: Array<{ name: string; status: string }> }>(ctx, 'GET', `/customers/${encodeURIComponent(customerId)}`, 'check your account')
    if (c.id !== undefined && c.id !== customerId) throw unavailable('Bridge returned another customer.')
    if (c.status !== 'active') throw conflict(`The Bridge customer is not active (${String(c.status ?? 'unknown').slice(0, 40)}). Finish Bridge KYC first.`)
    if (endorsement && c.endorsements) {
      const e = c.endorsements.find((x) => x.name === endorsement)
      if (e?.status !== 'approved') throw conflict(`The Bridge customer has no approved ${endorsement} endorsement for this currency.`)
    }
  }

  // ---------- records ----------

  async function saveAccount(rec: AccountRec, routeKey: string, ctx: Ctx): Promise<void> {
    await ctx.shared.put(accountKey(rec.id), rec)
    await ctx.shared.put(routeKey, rec.id)
  }

  async function loadAccount(kind: 'va' | 'la', id: string, ctx: Ctx): Promise<AccountRec | undefined> {
    const rec = await ctx.shared.get<AccountRec>(accountKey(id))
    return rec && rec.kind === kind && rec.id === id ? rec : undefined
  }

  function parseRef(ref: string, prefix: string): { kind: 'va' | 'la'; id: string; depositId?: string } | undefined {
    if (!ref.startsWith(prefix)) return undefined
    const [kind, id, depositId] = ref.slice(prefix.length).split('|')
    if ((kind !== 'va' && kind !== 'la') || !id || !ID.test(id)) return undefined
    if (prefix === STANDING_DEPOSIT_REF && !depositId) return undefined
    return { kind, id, ...(depositId ? { depositId } : {}) }
  }

  // ---------- pages ----------

  /** Up to MAX_PAGES pages of a newest-first list, until an item is older than `floor` */
  async function pages<T extends { id: string; created_at?: string }>(ctx: Ctx, path: string, what: string, floor: number): Promise<T[]> {
    const out: T[] = []
    let after: string | undefined
    for (let i = 0; i < MAX_PAGES; i++) {
      const sep = path.includes('?') ? '&' : '?'
      const items = list<T>(await call<unknown>(ctx, 'GET', `${path}${sep}limit=${PAGE}${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`, what))
      out.push(...items)
      const last = items[items.length - 1]
      const oldest = Math.min(...items.map((x) => Date.parse(x?.created_at ?? '')).filter(Number.isFinite))
      if (items.length < PAGE || !last?.id || oldest < floor) break
      after = last.id
      if (i === MAX_PAGES - 1) ctx.log.warn('bridge: more activity than one poll reads', { path: path.split('?')[0] })
    }
    return out
  }

  /** An account's webhook inbox: Bridge objects that a verified webhook delivered, for the next poll */
  async function addToInbox(id: string, item: { id: string }, ctx: Ctx): Promise<void> {
    const cur = (await ctx.shared.get<Array<{ id: string }>>(inboxKey(id))) ?? []
    const next = [...cur.filter((x) => x?.id !== item.id), item].slice(-INBOX_MAX)
    await ctx.shared.put(inboxKey(id), next, INBOX_TTL_SEC)
  }

  const inbox = async <T>(id: string, ctx: Ctx) => ((await ctx.shared.get<T[]>(inboxKey(id))) ?? []) as T[]

  // ---------- fiat in: virtual accounts ----------

  /** True when a Bridge virtual account delivers this route: USDC on `rail` to `address`, from `currency` */
  function vaMatches(va: VirtualAccount, currency: string, rail: string, address: string): boolean {
    const d = va.destination
    return (
      va.status !== 'deactivated' &&
      lower(d?.currency) === 'usdc' &&
      d?.payment_rail === rail &&
      sameAddress(d?.address, address) &&
      (va.source_deposit_instructions?.currency === undefined || lower(va.source_deposit_instructions.currency) === currency.toLowerCase())
    )
  }

  /** The main account identifier, for `StandingAddress.address` */
  function mainId(i: DepositInstructions): string | undefined {
    return i.iban ?? i.clabe ?? i.bank_account_number ?? i.account_number ?? i.br_code
  }

  async function standingAccount(input: StandingAccountInput, ctx: Ctx): Promise<StandingAccountResult> {
    const currency = input.origin.currency.toUpperCase()
    const r = rt.rails.find((x) => x.currency === currency)
    if (!r) throw bad(`Bridge has no virtual account for ${currency} in this setup.`)
    const d = input.destination
    const c = findDeliverAsset(rt.chains.map((x) => ({ chain: x.chain, token: x.usdc, c: x })), { kind: 'crypto', chain: d.chain, token: d.token })?.c
    if (!c) throw bad('Bridge virtual accounts deliver USDC only, on a chain that Bridge serves.')
    const customerId = await customerOf(input.userId, ctx)
    const routeHash = await sha(JSON.stringify([customerId, currency, c.rail, d.address.startsWith('0x') ? d.address.toLowerCase() : d.address]))
    const routeKey = `sroute:va:${routeHash}`
    const known = await ctx.shared.get<string>(routeKey)
    const kept = known ? await ctx.shared.get<AccountRec & { instructions?: DepositInstructions }>(accountKey(known)) : undefined
    if (kept?.kind === 'va' && kept.instructions && kept.userId === input.userId) return accountView(kept, kept.instructions)
    await checkCustomer(customerId, r.endorsement, ctx)
    const base = `/customers/${encodeURIComponent(customerId)}/virtual_accounts`
    // An account for this route that exists already (made by a session, or by an earlier call that
    // stopped half way): Bridge keeps one account per customer, currency and destination.
    let va = (await pages<VirtualAccount & { created_at?: string }>(ctx, base, 'find your bank account', 0)).find((x) => vaMatches(x, currency, c.rail, d.address))
    if (!va) {
      va = await call<VirtualAccount>(
        ctx,
        'POST',
        base,
        'open a bank account for you',
        {
          source: { currency: currency.toLowerCase() },
          destination: { currency: 'usdc', payment_rail: c.rail, address: d.address },
          ...(rt.developerFeePercent ? { developer_fee_percent: rt.developerFeePercent } : {}),
        },
        // The same key for the same route: a retry of a create that stopped half way gets the same account.
        `orb-sva-${routeHash}`,
      )
    }
    // Fail closed: the account must deliver to the server's destination, as Bridge itself says.
    if (!va?.id || !ID.test(va.id) || !vaMatches(va, currency, c.rail, d.address) || (va.customer_id !== undefined && va.customer_id !== customerId)) {
      ctx.log.error('bridge: the virtual account does not deliver to the destination that was asked; refused', { customerId })
      throw unavailable('Bridge returned a bank account for another destination.')
    }
    const instructions = va.source_deposit_instructions
    if (!instructions || !mainId(instructions)) throw unavailable('Bridge did not return bank details.')
    const asset: CryptoAsset = { kind: 'crypto', chain: c.chain, token: c.usdc, symbol: 'USDC', decimals: 6 }
    const rec: AccountRec & { instructions: DepositInstructions } = { kind: 'va', id: va.id, userId: input.userId, customerId, currency, asset, rail: c.rail, address: d.address, createdAt: Date.now(), instructions }
    await saveAccount(rec, routeKey, ctx)
    // The session flow reuses the same account (its cache key, see `ensureVirtualAccount`).
    await ctx.shared.put(`va:${customerId}:${currency}:${c.rail}:${d.address}`, { id: va.id, instructions }, VA_CACHE_TTL_SEC)
    return accountView(rec, instructions)
  }

  function accountView(rec: AccountRec, i: DepositInstructions): StandingAccountResult {
    return { address: mainId(i)!, ref: `${ACCOUNT_REF}va|${rec.id}`, bank: { fields: rt.bankFields(i) }, data: { customerId: rec.customerId, virtualAccountId: rec.id } }
  }

  /**
   * One deposit of a virtual account, from all its events: the input (in the account currency), the
   * time, and the latest stage. Undefined when the events break a rule (logged).
   */
  function vaDeposit(rec: AccountRec, events: VaEvent[], log: Logger): { at: number; input?: string; best: VaEvent; received: boolean } | undefined {
    let input: string | undefined
    let received = false
    let best: VaEvent | undefined
    let bestRank = -1
    for (const ev of events) {
      const m = rt.vaMap(ev.type)
      if (!m) continue
      const cur = lower(ev.currency)
      if (OUTGOING.has(ev.type)) {
        if (cur !== undefined && cur !== 'usdc') {
          log.error('bridge: a virtual account deposit paid out another currency; skipped', { virtualAccountId: rec.id, depositId: ev.deposit_id })
          return undefined
        }
      } else if (cur !== undefined && cur !== rec.currency!.toLowerCase()) {
        log.error('bridge: a virtual account deposit in another currency; skipped', { virtualAccountId: rec.id, depositId: ev.deposit_id })
        return undefined
      } else if (ev.type === 'funds_received' || input === undefined) {
        input = positive(ev.amount) ?? input
      }
      if (m.rank >= 1) received = true
      if (m.rank > bestRank) {
        best = ev
        bestRank = m.rank
      }
    }
    if (!best) return undefined
    const at = Math.min(...events.map((e) => Date.parse(e.created_at ?? '')).filter(Number.isFinite))
    return { at: Number.isFinite(at) ? at : Date.now(), ...(input ? { input } : {}), best, received }
  }

  /** The events of this account only, and of this customer only */
  const ownVaEvent = (rec: AccountRec) => (ev: VaEvent) =>
    !!ev && typeof ev.deposit_id === 'string' && ID.test(ev.deposit_id) && (ev.virtual_account_id === undefined || ev.virtual_account_id === rec.id) && (ev.customer_id === undefined || ev.customer_id === rec.customerId)

  async function vaDeposits(rec: AccountRec, since: number, ctx: Ctx): Promise<StandingDeposit[]> {
    const floor = Math.max(since, rec.createdAt - SKEW_MS)
    const path = `/customers/${encodeURIComponent(rec.customerId)}/virtual_accounts/${encodeURIComponent(rec.id)}/history`
    const events = [...(await pages<VaEvent>(ctx, path, 'check your deposits', floor)), ...(await inbox<VaEvent>(rec.id, ctx))].filter(ownVaEvent(rec))
    const byDeposit = new Map<string, VaEvent[]>()
    for (const ev of events) (byDeposit.get(ev.deposit_id!) ?? byDeposit.set(ev.deposit_id!, []).get(ev.deposit_id!)!).push(ev)
    const out: StandingDeposit[] = []
    for (const [depositId, evs] of byDeposit) {
      const dep = vaDeposit(rec, evs, ctx.log)
      // Only money that arrived makes a session (not `funds_scheduled` alone), and not before the account.
      if (!dep || !dep.received || dep.at < floor) continue
      // One deposit, one owner: a session of this account may have taken it already (same key).
      if (!(await claimOnce(ctx.shared, `dep:${depositId}`, owner(rec.id), CLAIM_TTL_SEC))) continue
      out.push({
        id: depositId,
        legRef: `${STANDING_DEPOSIT_REF}va|${rec.id}|${depositId}`,
        at: dep.at,
        ...(dep.input ? { input: { value: dep.input, asset: { kind: 'fiat' as const, currency: rec.currency! } } } : {}),
      })
    }
    return out
  }

  /** The leg event of one virtual account deposit, from its latest event */
  function vaLegEvent(ref: string, rec: AccountRec, ev: VaEvent): LegEvent | undefined {
    const m = rt.vaMap(ev.type)
    if (!m) return undefined
    const hash = ev.destination_tx_hash ?? ev.receipt?.destination_tx_hash
    const base = {
      ref,
      ...(ev.deposit_id ? { providerRef: ev.deposit_id } : {}),
      ...(hash ? { transactions: [{ role: 'destination' as const, chain: rec.asset.chain, hash }] } : {}),
    }
    if (m.status === 'succeeded') {
      // Fail closed: delivered on another rail or in another currency is not this destination.
      if ((ev.destination_payment_rail !== undefined && ev.destination_payment_rail !== rec.rail) || (ev.currency !== undefined && lower(ev.currency) !== 'usdc')) {
        return { ref, status: 'failed', error: openRampError('DELIVERY_FAILED', { message: 'Bridge reports this deposit as delivered somewhere else. Contact support.', recovery: 'contact_support' }) }
      }
      const out = positive(ev.receipt?.final_amount) ?? positive(ev.amount)
      return { ...base, status: 'succeeded', ...(out ? { output: { value: out, asset: rec.asset } } : {}) }
    }
    if (m.status === 'failed') {
      return { ...base, status: 'failed', error: openRampError('DELIVERY_FAILED', { message: 'Bridge could not deliver or refund this deposit. Contact support.', recovery: 'contact_support' }) }
    }
    return { ...base, status: m.status, ...(m.detail ? { detail: { code: m.detail, providerStatus: ev.type } } : {}) }
  }

  // ---------- crypto in: liquidation addresses ----------

  function laMatches(la: LiquidationAddress, srcRail: string, rail: string, address: string): boolean {
    return (
      la.state !== 'deactivated' &&
      la.chain === srcRail &&
      lower(la.currency) === 'usdc' &&
      la.destination_payment_rail === rail &&
      lower(la.destination_currency) === 'usdc' &&
      sameAddress(la.destination_address, address) &&
      !la.external_account_id &&
      !la.bridge_wallet_id &&
      !la.prefunded_account_id
    )
  }

  async function standingAddress(input: StandingAddressInput, ctx: Ctx): Promise<{ address: string; ref: string; data?: Record<string, unknown> }> {
    const usdc = rt.chains.map((x) => ({ chain: x.chain, token: x.usdc, c: x }))
    const src = findDeliverAsset(usdc, { kind: 'crypto', chain: input.origin.chain, token: input.origin.token })?.c
    if (!src) throw bad('Bridge liquidation addresses here take USDC only, on a chain that Bridge serves.')
    const d = input.destination
    const c = findDeliverAsset(usdc, { kind: 'crypto', chain: d.chain, token: d.token })?.c
    if (!c) throw bad('Bridge liquidation addresses here deliver USDC only, on a chain that Bridge serves.')
    if (src.chain === c.chain) throw bad('Bridge gives no liquidation address for the same token on the same chain.')
    const customerId = await customerOf(input.userId, ctx)
    const routeHash = await sha(JSON.stringify([customerId, src.rail, c.rail, d.address.startsWith('0x') ? d.address.toLowerCase() : d.address]))
    const routeKey = `sroute:la:${routeHash}`
    const known = await ctx.shared.get<string>(routeKey)
    const kept = known ? await ctx.shared.get<AccountRec & { depositAddress?: string }>(accountKey(known)) : undefined
    if (kept?.kind === 'la' && kept.depositAddress && kept.userId === input.userId) return laView(kept, kept.depositAddress)
    // TO VERIFY: the endorsement that a crypto-to-crypto liquidation address needs. This checks that the customer is active.
    await checkCustomer(customerId, undefined, ctx)
    const base = `/customers/${encodeURIComponent(customerId)}/liquidation_addresses`
    // Bridge refuses a second liquidation address with the same source chain, currency and destination:
    // look for one first (an earlier call may have made it and stopped).
    let la = (await pages<LiquidationAddress & { created_at?: string }>(ctx, base, 'find your deposit address', 0)).find((x) => laMatches(x, src.rail, c.rail, d.address))
    if (!la) {
      la = await call<LiquidationAddress>(
        ctx,
        'POST',
        base,
        'make your deposit address',
        {
          chain: src.rail,
          currency: 'usdc',
          destination_payment_rail: c.rail,
          destination_currency: 'usdc',
          destination_address: d.address,
          ...(rt.developerFeePercent ? { custom_developer_fee_percent: rt.developerFeePercent } : {}),
        },
        `orb-sla-${routeHash}`,
      )
    }
    // Fail closed: the address must drain to the server's destination, as Bridge itself says.
    if (!la?.id || !ID.test(la.id) || typeof la.address !== 'string' || !la.address || !laMatches(la, src.rail, c.rail, d.address) || (la.customer_id !== undefined && la.customer_id !== customerId)) {
      ctx.log.error('bridge: the liquidation address does not drain to the destination that was asked; refused', { customerId })
      throw unavailable('Bridge returned a deposit address for another destination.')
    }
    const asset: CryptoAsset = { kind: 'crypto', chain: c.chain, token: c.usdc, symbol: 'USDC', decimals: 6 }
    const rec: AccountRec & { depositAddress: string } = { kind: 'la', id: la.id, userId: input.userId, customerId, srcChain: src.chain, srcRail: src.rail, asset, rail: c.rail, address: d.address, createdAt: Date.now(), depositAddress: la.address }
    await saveAccount(rec, routeKey, ctx)
    return laView(rec, la.address)
  }

  function laView(rec: AccountRec, depositAddress: string) {
    return { address: depositAddress, ref: `${ACCOUNT_REF}la|${rec.id}`, data: { customerId: rec.customerId, liquidationAddressId: rec.id } }
  }

  /** A drain of this address and customer, with a known state */
  const ownDrain = (rec: AccountRec) => (x: Drain) =>
    !!x && typeof x.id === 'string' && ID.test(x.id) && (x.liquidation_address_id === undefined || x.liquidation_address_id === rec.id) && (x.customer_id === undefined || x.customer_id === rec.customerId)

  /** True when the drain took USDC (Bridge writes a dollar amount: `usdc`, or `usd` in some examples) on the address's chain */
  function drainSourceOk(rec: AccountRec, x: Drain, log: Logger): boolean {
    // TO VERIFY: the docs show `usdc` (API reference) and `usd` (guide) for the drain currency of a USDC address.
    const cur = lower(x.currency)
    if (cur !== undefined && cur !== 'usdc' && cur !== 'usd') {
      log.error('bridge: a drain in another currency; skipped', { liquidationAddressId: rec.id, drainId: x.id })
      return false
    }
    if (x.source_payment_rail !== undefined && x.source_payment_rail !== rec.srcRail) {
      log.error('bridge: a drain from another chain; skipped', { liquidationAddressId: rec.id, drainId: x.id })
      return false
    }
    return true
  }

  async function laDeposits(rec: AccountRec, since: number, ctx: Ctx): Promise<StandingDeposit[]> {
    const floor = Math.max(since, rec.createdAt - SKEW_MS)
    const path = `/customers/${encodeURIComponent(rec.customerId)}/liquidation_addresses/${encodeURIComponent(rec.id)}/drains`
    const seen = new Map<string, Drain>()
    for (const x of [...(await inbox<Drain>(rec.id, ctx)), ...(await pages<Drain>(ctx, path, 'check your deposits', floor))]) if (ownDrain(rec)(x)) seen.set(x.id, x)
    const origin: CryptoAsset = { kind: 'crypto', chain: rec.srcChain!, token: rt.chains.find((c) => c.chain === rec.srcChain)!.usdc, symbol: 'USDC', decimals: 6 }
    const out: StandingDeposit[] = []
    for (const x of seen.values()) {
      const state = DRAIN_STATE(x.state, ctx.log)
      // No session before the money confirmed (`awaiting_funds`), and none for a state not in the table.
      if (!state || state === 'awaiting_funds') continue
      const at = Date.parse(x.created_at ?? '')
      if (!Number.isFinite(at) || at < floor) continue
      if (!drainSourceOk(rec, x, ctx.log)) continue
      if (!(await claimOnce(ctx.shared, `drain:${x.id}`, owner(rec.id), CLAIM_TTL_SEC))) continue
      const amount = positive(x.amount)
      out.push({ id: x.id, legRef: `${STANDING_DEPOSIT_REF}la|${rec.id}|${x.id}`, at, ...(amount ? { input: { value: amount, asset: origin } } : {}) })
    }
    return out
  }

  function laLegEvent(ref: string, rec: AccountRec, x: Drain, log?: Pick<Logger, 'warn' | 'error'>): LegEvent | undefined {
    const m = DRAIN_STATE(x.state, log)
    if (!m) return undefined
    const txs = [
      ...(x.deposit_tx_hash ? [{ role: 'source' as const, chain: rec.srcChain!, hash: x.deposit_tx_hash }] : []),
      ...(x.destination_tx_hash ? [{ role: 'destination' as const, chain: rec.asset.chain, hash: x.destination_tx_hash }] : []),
    ]
    const base = { ref, providerRef: x.id, ...(txs.length ? { transactions: txs } : {}) }
    if (m === 'awaiting_funds') return { ...base, status: 'processing', detail: { code: 'confirming', providerStatus: 'awaiting_funds' } }
    if (m.status === 'succeeded') {
      const dst = x.destination
      const other = !!dst && ((dst.to_address !== undefined && !sameAddress(dst.to_address, rec.address)) || (dst.payment_rail !== undefined && dst.payment_rail !== rec.rail) || (dst.currency !== undefined && lower(dst.currency) !== 'usdc'))
      if (other) {
        log?.error('bridge: a drain was delivered to another destination', { liquidationAddressId: rec.id, drainId: x.id })
        return { ref, status: 'failed', error: openRampError('DELIVERY_FAILED', { message: 'Bridge reports this deposit as delivered somewhere else. Contact support.', recovery: 'contact_support' }) }
      }
      if (!dst?.to_address) {
        // Fail closed: no proof of the destination yet. The poll asks again.
        log?.warn('bridge: a processed drain has no destination address yet; still processing', { drainId: x.id })
        return { ...base, status: 'processing', detail: { code: 'settling', providerStatus: 'payment_processed' } }
      }
      const out = positive(x.receipt?.outgoing_amount) ?? positive(x.receipt?.converted_amount)
      return { ...base, status: 'succeeded', ...(out ? { output: { value: out, asset: rec.asset } } : {}) }
    }
    if (m.status === 'failed') {
      return { ...base, status: 'failed', error: openRampError('DELIVERY_FAILED', { message: `Bridge could not deliver this deposit (${String(x.state)}). Contact support.`, recovery: 'contact_support' }) }
    }
    return { ...base, status: m.status, ...(m.detail ? { detail: { code: m.detail, providerStatus: String(x.state) } } : {}) }
  }

  // ---------- the adapter methods ----------

  async function standingDeposits(input: StandingDepositsInput | StandingAccountDepositsInput, ctx: Ctx): Promise<StandingDeposit[]> {
    const r = parseRef(input.ref, ACCOUNT_REF)
    if (!r) throw new Error('bridge: not a Bridge standing address ref')
    const rec = await loadAccount(r.kind, r.id, ctx)
    if (!rec) throw new Error('bridge: this standing address is not known to the adapter (its shared store lost the record)')
    // The route the server polls must be this record's route (a bank account has a currency, an address a chain).
    const o = input.origin as { currency?: string; chain?: string }
    if (rec.kind === 'va' ? o.currency?.toUpperCase() !== rec.currency : o.chain !== rec.srcChain) throw new Error('bridge: the standing address ref does not match its route')
    return rec.kind === 'va' ? vaDeposits(rec, input.since, ctx) : laDeposits(rec, input.since, ctx)
  }

  /** The step of one standing deposit (`bsd|...` ref) */
  async function standingStatus(ref: string, ctx: Ctx): Promise<LegStep> {
    const r = parseRef(ref, STANDING_DEPOSIT_REF)
    if (!r?.depositId) throw new OpenRampException(openRampError('NOT_FOUND', { message: 'This Bridge deposit is not known.' }), 404)
    const rec = await loadAccount(r.kind, r.id, ctx)
    if (!rec) throw new OpenRampException(openRampError('NOT_FOUND', { message: 'This Bridge deposit is not known.' }), 404)
    const processing: LegStep = { status: 'processing', detail: { code: 'processing' }, ref, providerRef: r.depositId, poll: rt.poll }
    // One deposit, one owner: the claim that `standingDeposits` took must still be this account's.
    const claimKey = r.kind === 'va' ? `dep:${r.depositId}` : `drain:${r.depositId}`
    const by = await ctx.shared.get<string>(claimKey)
    if (by !== owner(rec.id)) {
      ctx.log.error('bridge: a standing deposit that this account does not own', { id: rec.id })
      return { status: 'failed', ref, error: openRampError('DELIVERY_FAILED', { message: 'This deposit belongs to another payment. Contact support.', recovery: 'contact_support' }) }
    }
    if (r.kind === 'va') {
      const path = `/customers/${encodeURIComponent(rec.customerId)}/virtual_accounts/${encodeURIComponent(rec.id)}/history?deposit_id=${encodeURIComponent(r.depositId)}&limit=${PAGE}`
      const events = [...list<VaEvent>(await call<unknown>(ctx, 'GET', path, 'check your deposit')), ...(await inbox<VaEvent>(rec.id, ctx))].filter((e) => ownVaEvent(rec)(e) && e.deposit_id === r.depositId)
      const dep = vaDeposit(rec, events, ctx.log)
      if (!dep) return processing
      const ev = vaLegEvent(ref, rec, dep.best)
      return ev ? legStepFromEvent(ev, ref, rt.poll) : processing
    }
    const path = `/customers/${encodeURIComponent(rec.customerId)}/liquidation_addresses/${encodeURIComponent(rec.id)}/drains?drain_id=${encodeURIComponent(r.depositId)}`
    const found = [...list<Drain>(await call<unknown>(ctx, 'GET', path, 'check your deposit')), ...(await inbox<Drain>(rec.id, ctx))].find((x) => ownDrain(rec)(x) && x.id === r.depositId)
    if (!found || !drainSourceOk(rec, found, ctx.log)) return processing
    const ev = laLegEvent(ref, rec, found, ctx.log)
    return ev ? legStepFromEvent(ev, ref, rt.poll) : processing
  }

  /**
   * A virtual account webhook for a standing account. Undefined: the account is not a standing one
   * (the session flow handles the event). Else the leg events: one for a deposit that this account
   * owns, the session's event for a deposit that a session owns, and none for a new deposit (it is kept
   * for the next poll, which makes its session).
   */
  async function vaWebhook(ev: VaEvent, eventId: string | undefined, ctx: Ctx): Promise<LegEvent[] | { sessionRef: string } | undefined> {
    if (!ev?.virtual_account_id || !ID.test(ev.virtual_account_id)) return undefined
    const rec = await loadAccount('va', ev.virtual_account_id, ctx)
    if (!rec) return undefined
    // Account events (activation, account_update, ...) and unknown types (logged): no leg event.
    if (!rt.vaMap(ev.type, ctx.log)) return []
    if (!ownVaEvent(rec)(ev)) {
      ctx.log.warn('bridge: a virtual account event that does not match its account; ignored', { virtualAccountId: rec.id })
      return []
    }
    await addToInbox(rec.id, ev, ctx)
    const by = await ctx.shared.get<string>(`dep:${ev.deposit_id}`)
    if (by && by !== owner(rec.id)) return { sessionRef: by }
    if (by !== owner(rec.id)) return []
    const ref = `${STANDING_DEPOSIT_REF}va|${rec.id}|${ev.deposit_id}`
    if (!vaDeposit(rec, [ev], ctx.log)) return []
    const le = vaLegEvent(ref, rec, ev)
    return le ? [{ ...le, ...(eventId ? { eventId } : {}) }] : []
  }

  /** A drain webhook: a leg event for a drain that a standing address owns; a new drain waits for the poll */
  async function drainWebhook(x: Drain, eventId: string | undefined, ctx: Ctx): Promise<LegEvent[]> {
    if (!x?.liquidation_address_id || !ID.test(x.liquidation_address_id)) return []
    const rec = await loadAccount('la', x.liquidation_address_id, ctx)
    if (!rec) return []
    if (!ownDrain(rec)(x)) {
      ctx.log.warn('bridge: a drain event that does not match its address; ignored', { liquidationAddressId: rec.id })
      return []
    }
    if (!DRAIN_STATE(x.state, ctx.log)) return []
    await addToInbox(rec.id, x, ctx)
    if ((await ctx.shared.get<string>(`drain:${x.id}`)) !== owner(rec.id)) return []
    if (!drainSourceOk(rec, x, ctx.log)) return []
    const le = laLegEvent(`${STANDING_DEPOSIT_REF}la|${rec.id}|${x.id}`, rec, x, ctx.log)
    return le ? [{ ...le, ...(eventId ? { eventId } : {}) }] : []
  }

  return { standingAccount, standingAddress, standingDeposits, standingStatus, vaWebhook, drainWebhook }
}
