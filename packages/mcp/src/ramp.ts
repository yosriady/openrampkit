// The operations behind the MCP tools. They apply the guardrails, keep client secrets in the
// registry, and return compact JSON views. The MCP layer (server.ts) only maps tools to these.

import { cmp, currencyForCountry } from '@openrampkit/core'
import type { MethodOption, OpenRampError, PublicQuote, PublicSession, SurfaceKind } from '@openrampkit/core'
import { createBackend, RampError } from './backend.js'
import type { Backend, SessionInput } from './backend.js'
import { checkConfig, resolveBounds, resolveDestination, resolveTarget } from './config.js'
import type { NamedDestination, OpenRampMcpConfig, PayoutApproval } from './config.js'
import { amountCurrency, boundsText, errorView, methodView, paymentView, quoteView, sessionView, TERMINAL } from './format.js'
import { createLimiter } from './limits.js'
import { memoryRegistry } from './registry.js'
import type { SessionRegistry } from './registry.js'

type PlanResult = { methods: MethodOption[]; currency: string }
type QuotesResult = { quotes: PublicQuote[]; errors: OpenRampError[] }
type Direction = 'deposit' | 'withdraw'

const PREVIEW_TTL_MIN = 10
const DIRECT_SURFACES: SurfaceKind[] = ['QR', 'BANK_FIELDS', 'DEPOSIT_ADDRESS', 'REDIRECT', 'DEEPLINK']
const MAX_QUOTED_METHODS = 3

export type DepositArgs = {
  country: string
  currency?: string | undefined
  destination?: string | undefined
  custom_destination?: { chain: string; token: string; address: string; symbol?: string | undefined; decimals?: number | undefined } | undefined
  min_amount?: string | undefined
  max_amount?: string | undefined
  method?: string | undefined
  amount?: string | undefined
  reference?: string | undefined
  ttl_minutes?: number | undefined
}

export type WithdrawArgs = {
  country: string
  /** A name from `withdraw.targets`: the funds go there, and no pay link is made. */
  target?: string | undefined
  amount?: string | undefined
  max_amount?: string | undefined
  reference?: string | undefined
  ttl_minutes?: number | undefined
}

export type WaitOptions = { timeoutSeconds?: number | undefined; signal?: AbortSignal; onPoll?: (view: ReturnType<typeof sessionView>, elapsedMs: number) => void | Promise<void> }

export function createRampOps(config: OpenRampMcpConfig) {
  checkConfig(config)
  const backend: Backend = createBackend(config.connection)
  const registry: SessionRegistry = config.registry ?? memoryRegistry()
  const userId = config.userId ?? 'agent'
  const maxTtl = config.sessionTtlMinutes ?? 30
  const maxWait = Math.min(config.maxWaitSeconds ?? 120, 600)
  const pollMs = config.pollIntervalMs ?? 3000
  const previews = new Map<string, { id: string; secret: string; exp: number }>()
  const limiter = createLimiter(config.limits, registry)

  /**
   * Count the session against `limits`, then run `fn`. When `fn` fails before it calls `keep()`
   * (that is, before a session exists), the count is undone.
   */
  async function counted<T>(direction: Direction, bounds: { max: string; currency: string }, fn: (keep: () => void) => Promise<T>): Promise<T> {
    const release = await limiter.reserve(direction, bounds.currency, bounds.max)
    let kept = false
    try {
      return await fn(() => {
        kept = true
      })
    } catch (e) {
      if (!kept) await release()
      throw e
    }
  }

  /** Ask the operator's `approve` hook. Fails closed: false, a non-boolean or an error refuses. */
  async function approve(request: PayoutApproval): Promise<void> {
    if (!config.approve) return
    let ok: unknown
    try {
      ok = await config.approve(request)
    } catch {
      ok = false
    }
    if (ok !== true) throw new RampError('NOT_APPROVED', 'The operator did not approve this payout. Do not retry it. Ask the person who runs this agent.', 403)
  }

  async function create(input: SessionInput) {
    const s = await backend.create(input)
    await registry.set(s.id, { clientSecret: s.clientSecret, direction: input.direction, expiresAt: s.expiresAt, ...(input.metadata?.openrampkit_mcp === 'preview' ? { preview: true } : {}) })
    return s
  }

  async function secretFor(sessionId: string): Promise<string> {
    const e = await registry.get(sessionId)
    if (!e || e.preview) throw new RampError('UNKNOWN_SESSION', 'Unknown session. You can only read sessions that you created with this server.', 404)
    return e.clientSecret
  }

  const country = (c: string) => {
    const v = c.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(v)) throw new RampError('BAD_REQUEST', 'country must be an ISO 3166-1 alpha-2 code, e.g. "VN".', 400)
    return v
  }

  const ttl = (m?: number) => Math.max(1, Math.min(m ?? maxTtl, maxTtl))

  function base(direction: Direction, c: string, extra: Record<string, string> = {}): SessionInput {
    return {
      userId,
      direction,
      country: c,
      ...(config.allowedMethods ? { allowedMethods: config.allowedMethods } : {}),
      metadata: { openrampkit_mcp: 'agent', ...extra },
    }
  }

  function withdrawConfig() {
    const w = config.withdraw
    if (!w) throw new RampError('NOT_ALLOWED', 'Payouts are turned off in this MCP server.', 403)
    return { source: w.source, allowedDestinations: w.allowedDestinations ?? { fiat: {} } }
  }

  /** A short-lived session used only to list methods and quote. Reused per direction, country and destination. */
  async function preview(direction: Direction, c: string, destination?: string): Promise<string> {
    const key = `${direction}:${c}:${destination ?? ''}`
    const hit = previews.get(key)
    if (hit && hit.exp - Date.now() > 60_000) return hit.secret
    const input: SessionInput =
      direction === 'deposit'
        ? { ...base('deposit', c, { openrampkit_mcp: 'preview' }), destination: resolveDestination(config, { destination }), ttlMinutes: PREVIEW_TTL_MIN }
        : { ...base('withdraw', c, { openrampkit_mcp: 'preview' }), ...withdrawConfig(), ttlMinutes: PREVIEW_TTL_MIN }
    const s = await create(input)
    if (direction === 'withdraw') await backend.call(s.clientSecret, 'POST', `/sessions/${s.id}/target`, { type: 'fiat', currency: currencyForCountry(c) })
    previews.set(key, { id: s.id, secret: s.clientSecret, exp: Date.parse(s.expiresAt) })
    return s.clientSecret
  }

  const idOf = (secret: string) => secret.split('.')[0]!

  async function payLink(sessionId: string, secret: string) {
    const link = await backend.call<{ id?: string; url: string; expiresAt: string }>(secret, 'POST', `/sessions/${sessionId}/pay-link`, {})
    const entry = await registry.get(sessionId)
    if (entry && link.id) await registry.set(sessionId, { ...entry, payLinkId: link.id })
    return link
  }

  return {
    config,

    async listPaymentMethods(args: { country: string; direction?: Direction | undefined; destination?: string | undefined }) {
      const c = country(args.country)
      const direction = args.direction ?? 'deposit'
      const secret = await preview(direction, c, direction === 'deposit' ? args.destination : undefined)
      const plan = await backend.call<PlanResult>(secret, 'POST', `/sessions/${idOf(secret)}/plan`, {})
      return {
        country: c,
        direction,
        currency: plan.currency,
        methods: plan.methods.map(methodView),
      }
    },

    async getQuotes(args: { country: string; amount: string; method?: string | undefined; direction?: Direction | undefined; destination?: string | undefined }) {
      const c = country(args.country)
      const direction = args.direction ?? 'deposit'
      const secret = await preview(direction, c, direction === 'deposit' ? args.destination : undefined)
      const id = idOf(secret)
      let methods: string[]
      if (args.method) methods = [args.method]
      else {
        const plan = await backend.call<PlanResult>(secret, 'POST', `/sessions/${id}/plan`, {})
        methods = plan.methods.filter((m) => m.group !== 'unavailable' && m.kind !== 'wallet' && m.kind !== 'transfer').slice(0, MAX_QUOTED_METHODS).map((m) => m.method)
      }
      const quotes: ReturnType<typeof quoteView>[] = []
      const errors: Array<{ method: string; code: string; message: string }> = []
      for (const method of methods) {
        try {
          const r = await backend.call<QuotesResult>(secret, 'POST', `/sessions/${id}/quotes`, { method, amount: args.amount })
          quotes.push(...r.quotes.map(quoteView))
          errors.push(...r.errors.map((e) => ({ method, ...errorView(e) })))
        } catch (e) {
          if (!(e instanceof RampError)) throw e
          errors.push({ method, code: e.code, message: e.message })
        }
      }
      return {
        country: c,
        direction,
        amount_note: direction === 'withdraw' ? `amount is in ${config.withdraw?.source.symbol ?? 'the source token'}` : 'amount is in the currency of each method (the local currency for cash methods)',
        quotes,
        ...(errors.length ? { errors } : {}),
      }
    },

    async createDepositSession(args: DepositArgs) {
      const c = country(args.country)
      const destination = resolveDestination(config, { destination: args.destination, custom: args.custom_destination })
      const bounds = resolveBounds(config, { currency: args.currency ?? currencyForCountry(c), min: args.min_amount, max: args.max_amount })
      if (args.amount !== undefined) {
        resolveBounds(config, { currency: bounds.currency, exact: args.amount })
        if (cmp(args.amount, bounds.max) > 0 || (bounds.min && cmp(args.amount, bounds.min) < 0)) {
          throw new RampError('BAD_REQUEST', `amount must be inside ${boundsText(bounds)}.`, 400)
        }
      }
      const { s, link } = await counted('deposit', bounds, async (keep) => {
        const s = await create({
          ...base('deposit', c, args.reference ? { reference: args.reference.slice(0, 200) } : {}),
          destination,
          amountBounds: bounds,
          ttlMinutes: ttl(args.ttl_minutes),
        })
        keep()
        return { s, link: await payLink(s.id, s.clientSecret) }
      })
      const out: Record<string, unknown> = {
        session_id: s.id,
        status: 'requires_payment_method',
        pay_url: link.url,
        pay_url_expires_at: link.expiresAt,
        expires_at: s.expiresAt,
        destination: destination.type === 'crypto' ? { chain: destination.chain, token: destination.symbol ?? destination.token, address: destination.address } : destination,
        bounds: boundsText(bounds),
      }
      if (args.method && args.amount) {
        try {
          out.payment = await directPayment(s.id, s.clientSecret, args.method, args.amount, bounds.currency)
        } catch (e) {
          if (!(e instanceof RampError)) throw e
          out.payment_error = { code: e.code, message: e.message }
        }
      }
      out.next = out.payment
        ? 'Show the payment instructions (or pay_url) to the person. Then call wait_for_completion with session_id.'
        : 'Show pay_url to the person (as a link or a QR code). They pick a method and pay. Then call wait_for_completion with session_id.'
      return out
    },

    async createWithdrawSession(args: WithdrawArgs) {
      const c = country(args.country)
      const w = withdrawConfig()
      const target = resolveTarget(config, args.target)
      const currency = w.source.symbol ?? 'USDC'
      if (target && args.amount === undefined) throw new RampError('BAD_REQUEST', 'amount is required with target.', 400)
      const bounds = resolveBounds(config, { currency, max: args.max_amount, exact: args.amount })
      const reference = args.reference?.slice(0, 200)
      const source = { chain: w.source.chain, token: currency, custody: w.source.custody }
      const input: SessionInput = {
        ...base('withdraw', c, reference ? { reference } : {}),
        source: w.source,
        // A bound target: the server sets and locks it at creation, so nobody can change it later.
        // Only its chain is allowed, and no pay link is made.
        allowedDestinations: target ? { crypto: { chains: [target.chain] } } : w.allowedDestinations,
        ...(target
          ? {
              destination: {
                type: 'crypto' as const,
                chain: target.chain,
                token: target.token,
                address: target.address,
                ...(target.symbol ? { symbol: target.symbol } : {}),
                ...(target.decimals !== undefined ? { decimals: target.decimals } : {}),
              },
              lockDestination: true,
            }
          : {}),
        amountBounds: bounds,
        ttlMinutes: ttl(args.ttl_minutes),
      }
      return counted('withdraw', bounds, async (keep) => {
        await approve({ direction: 'withdraw', country: c, amount: bounds, source: w.source, ...(target ? { target } : {}), ...(reference ? { reference } : {}) })
        const s = await create(input)
        // The session exists: it keeps its count, even when the payout does not start.
        keep()
        if (target) return { session_id: s.id, ...(await boundPayout(s.id, s.clientSecret, target, args.amount!)), expires_at: s.expiresAt, source, bounds: boundsText(bounds) }
        const link = await payLink(s.id, s.clientSecret)
        return {
          session_id: s.id,
          status: 'requires_payment_method',
          pay_url: link.url,
          pay_url_expires_at: link.expiresAt,
          expires_at: s.expiresAt,
          source,
          bounds: boundsText(bounds),
          next: 'Send pay_url to the person who receives the funds. They pick how to receive them (for example a bank or e-wallet) and confirm. Then call wait_for_completion with session_id.',
        }
      })
    },

    /**
     * Make the pay link of a session stop working (for example when it went to the wrong person).
     * For the operator, not an MCP tool. Throws `NO_PAY_LINK` when this server made no pay link for it.
     */
    async revokePayLink(sessionId: string) {
      const secret = await secretFor(sessionId)
      const linkId = (await registry.get(sessionId))?.payLinkId
      if (!linkId) throw new RampError('NO_PAY_LINK', 'This session has no pay link from this server.', 404)
      await backend.call<{ revoked: boolean }>(secret, 'POST', `/sessions/${encodeURIComponent(sessionId)}/pay-link/revoke`, { id: linkId })
      return { session_id: sessionId, revoked: true }
    },

    async getSessionStatus(sessionId: string) {
      const secret = await secretFor(sessionId)
      return sessionView(await backend.call<PublicSession>(secret, 'GET', `/sessions/${encodeURIComponent(sessionId)}/step`))
    },

    async waitForCompletion(sessionId: string, opts: WaitOptions = {}) {
      const secret = await secretFor(sessionId)
      const limit = Math.max(1, Math.min(opts.timeoutSeconds ?? 60, maxWait)) * 1000
      const start = Date.now()
      for (;;) {
        const view = sessionView(await backend.call<PublicSession>(secret, 'GET', `/sessions/${encodeURIComponent(sessionId)}/step`))
        const elapsed = Date.now() - start
        // Stop on a final status, and on a failed attempt (the person must choose again).
        if (TERMINAL.has(view.status) || view.attempt_failed) return { ...view, waited_seconds: Math.round(elapsed / 1000) }
        await opts.onPoll?.(view, elapsed)
        if (elapsed + pollMs > limit || opts.signal?.aborted) {
          return { ...view, waited_seconds: Math.round(elapsed / 1000), timed_out: true, next: 'Not finished yet. Call wait_for_completion again, or ask the person if they need help.' }
        }
        await sleep(pollMs, opts.signal)
      }
    },
  }

  /**
   * Payout to a bound target: the session has the locked target from creation. Plan, quote the first
   * available method and start it with the client secret, which only this server holds. The treasury
   * sends the funds (custody `app`).
   */
  async function boundPayout(id: string, secret: string, t: NamedDestination, amount: string) {
    const fail = (e: unknown): never => {
      const code = e instanceof RampError ? e.code : 'PAYOUT_NOT_STARTED'
      const message = e instanceof RampError ? e.message : 'The payout could not start.'
      throw new RampError(code, `${message} Session ${id} did not start a payout. Check it with get_session_status before you try again.`, e instanceof RampError ? e.status : 502)
    }
    try {
      const plan = await backend.call<PlanResult>(secret, 'POST', `/sessions/${id}/plan`, {})
      const method = plan.methods.find((m) => m.group !== 'unavailable')
      if (!method) throw new RampError('NO_METHOD', `No method can pay out to ${t.name} now.`, 422)
      const r = await backend.call<QuotesResult>(secret, 'POST', `/sessions/${id}/quotes`, { method: method.method, amount })
      const q = r.quotes[0]
      if (!q) throw new RampError(r.errors[0]?.code ?? 'NO_QUOTES', r.errors[0]?.message ?? `No quote to pay out to ${t.name}.`, 422)
      const session = await backend.call<PublicSession>(secret, 'POST', `/sessions/${id}/select`, { quoteId: q.id })
      return {
        status: sessionView(session).status,
        target: { name: t.name, chain: t.chain, token: t.symbol ?? t.token, address: t.address },
        quote: quoteView(q),
        next: 'The payout started. No person needs to act. Call wait_for_completion with session_id.',
      }
    } catch (e) {
      return fail(e)
    }
  }

  /** Quote one method for an exact amount and start the payment, so the agent can show a QR code or bank details. */
  async function directPayment(id: string, secret: string, method: string, amount: string, boundsCurrency: string) {
    await backend.call<PlanResult>(secret, 'POST', `/sessions/${id}/plan`, { surfaces: DIRECT_SURFACES })
    const r = await backend.call<QuotesResult>(secret, 'POST', `/sessions/${id}/quotes`, { method, amount })
    const q = r.quotes[0]
    if (!q) {
      const e = r.errors[0]
      throw new RampError(e?.code ?? 'NO_QUOTES', e?.message ?? `No quote for ${method}.`, 422)
    }
    if (amountCurrency(q.input).toUpperCase() !== boundsCurrency.toUpperCase()) {
      throw new RampError('CURRENCY_MISMATCH', `${method} is paid in ${amountCurrency(q.input)}, not ${boundsCurrency}. Use currency ${amountCurrency(q.input)}, or let the person pick on pay_url.`, 422)
    }
    const session = await backend.call<PublicSession>(secret, 'POST', `/sessions/${id}/select`, { quoteId: q.id })
    return { quote: quoteView(q), ...paymentView(session.step.surface) }
  }
}

export type RampOps = ReturnType<typeof createRampOps>

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}
