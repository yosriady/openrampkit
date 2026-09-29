// OpenRampKit server. Web-standard Request/Response only: runs on Cloudflare Workers, Vercel/Next.js,
// Node 20+, Bun and Deno. It holds provider secrets, fixes the destination per session,
// plans pathways, runs legs, takes provider webhooks and sends signed webhooks to the app.

import { ADAPTER_API_VERSION } from '@openrampkit/adapter'
import type { Adapter, AdapterContext, LegEvent, Logger } from '@openrampkit/adapter'
import {
  OrkException,
  createEvent,
  currencyForCountry,
  isLegTerminal,
  isTerminal,
  orkError,
  planPathways,
  rankQuotes,
} from '@openrampkit/core'
import type {
  Amount,
  Destination,
  Direction,
  Fee,
  LegStep,
  OrkError,
  Pathway,
  PublicSession,
  Quote,
  RegionPolicy,
  SessionStatus,
  Step,
  SurfaceKind,
} from '@openrampkit/core'
import { hmacHex, randomHex, safeEqual, sha256Hex, signWebhook, verifyWebhook } from './crypto.js'
import { memoryStore, scopedKV, VersionConflictError } from './store.js'
import type { ActiveLeg, SessionRecord, SessionStore, StoredQuote } from './store.js'

export * from './store.js'
export { verifyWebhook } from './crypto.js'

export type CreateSessionInput = {
  userId: string
  direction?: Direction
  destination: Destination
  country?: string
  region?: string
  email?: string
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  allowedMethods?: string[]
  metadata?: Record<string, string>
  /** Minutes until the session expires (default 30) */
  ttlMinutes?: number
}

export type OpenRampConfig = {
  /** Secret used to sign start URLs. At least 32 characters. */
  secret: string
  /** Public URL where this handler is mounted, e.g. https://app.example.com/api/openramp */
  baseUrl: string
  adapters: Adapter[]
  store?: SessionStore
  livemode?: boolean
  policy?: {
    maxLegs?: 1 | 2
    regions?: RegionPolicy
    methodPriority?: Record<string, string[]>
    disabledMethods?: string[]
  }
  /** Signed webhooks to the app backend */
  webhooks?: { url: string; secret: string }
  /** Resolve the user's country. Defaults to Cloudflare / Vercel geo headers. */
  geo?: (req: Request) => { country?: string; region?: string } | undefined
  /**
   * Optional: let the browser create sessions through `POST {baseUrl}/sessions`.
   * Return the session input for this request (the app decides userId and destination), or null to refuse.
   */
  authorize?: (req: Request, body: unknown) => Promise<CreateSessionInput | null>
  /** Allowed origins for CORS. Default: same origin only. */
  cors?: { origins: string[] | '*' }
  logger?: Logger
  /** Where providers return the user. Default: `{baseUrl}/return` which closes the tab. */
  returnUrl?: string
  fetch?: typeof fetch
}

const consoleLogger: Logger = {
  debug: () => {},
  info: (m, d) => console.info(`[openramp] ${m}`, d ?? ''),
  warn: (m, d) => console.warn(`[openramp] ${m}`, d ?? ''),
  error: (m, d) => console.error(`[openramp] ${m}`, d ?? ''),
}

const ALL_SURFACES: SurfaceKind[] = ['REDIRECT', 'IFRAME', 'QR', 'DEEPLINK', 'BANK_FIELDS', 'DEPOSIT_ADDRESS', 'WALLET_TX', 'OTP', 'FORM']

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const errorResponse = (e: OrkError, status: number) => json({ error: e }, status)

export function createOpenRamp(config: OpenRampConfig) {
  if (!config.secret || config.secret.length < 32) throw new Error('OpenRamp: `secret` must be at least 32 characters')
  for (const a of config.adapters) {
    if (a.apiVersion !== ADAPTER_API_VERSION) throw new Error(`OpenRamp: adapter ${a.id} targets API v${a.apiVersion}, server supports v${ADAPTER_API_VERSION}`)
  }
  const store = config.store ?? memoryStore()
  const log = config.logger ?? consoleLogger
  const f: typeof fetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const base = config.baseUrl.replace(/\/$/, '')
  const basePath = new URL(base).pathname.replace(/\/$/, '')
  const adapters = new Map(config.adapters.map((a) => [a.id, a]))
  const livemode = config.livemode ?? false

  const adapter = (id: string) => {
    const a = adapters.get(id)
    if (!a) throw new OrkException(orkError('INTERNAL', { message: `Adapter ${id} is not configured` }), 500)
    return a
  }

  // ---------------- sessions ----------------

  async function createSession(input: CreateSessionInput): Promise<{ id: string; clientSecret: string; expiresAt: string }> {
    const id = `ors_${randomHex(12)}`
    const secret = randomHex(24)
    const now = Date.now()
    const expiresAt = now + (input.ttlMinutes ?? 30) * 60_000
    const rec: SessionRecord = {
      id,
      secretHash: await sha256Hex(secret),
      version: 1,
      userId: input.userId,
      direction: input.direction ?? 'deposit',
      destination: normalizeDestination(input.destination),
      ...(input.country ? { country: input.country.toUpperCase() } : {}),
      ...(input.region ? { region: input.region.toUpperCase() } : {}),
      ...(input.email ? { email: input.email } : {}),
      locale: input.locale ?? 'en',
      ...(input.amountBounds ? { amountBounds: input.amountBounds } : {}),
      ...(input.allowedMethods ? { allowedMethods: input.allowedMethods } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      livemode,
      status: 'open',
      createdAt: now,
      expiresAt,
      quotes: {},
      step: { sessionId: id, state: 'SELECT_METHOD', transitions: [], expiresAt: new Date(expiresAt).toISOString() },
      startUrls: {},
      notified: [],
    }
    await store.put(rec)
    await notify(rec, 'session.created')
    return { id, clientSecret: `${id}.${secret}`, expiresAt: new Date(expiresAt).toISOString() }
  }

  async function loadAuthed(req: Request, id: string): Promise<SessionRecord> {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const [sid, secret] = token.split('.')
    if (!sid || !secret || sid !== id) throw new OrkException(orkError('UNAUTHORIZED'), 401)
    const rec = await store.get(id)
    if (!rec || !safeEqual(rec.secretHash, await sha256Hex(secret))) throw new OrkException(orkError('UNAUTHORIZED'), 401)
    if (Date.now() > rec.expiresAt && !isTerminal(rec.step.state) && rec.status === 'open') {
      rec.status = 'expired'
      rec.step = { sessionId: rec.id, state: 'EXPIRED', transitions: [], error: orkError('SESSION_EXPIRED') }
      await save(rec)
    }
    return rec
  }

  async function save(rec: SessionRecord) {
    const expected = rec.version
    rec.version += 1
    try {
      await store.put(rec, expected)
    } catch (e) {
      rec.version -= 1
      if (e instanceof VersionConflictError) throw new OrkException(orkError('RATE_LIMITED', { message: 'The session changed. Try again.' }), 409)
      throw e
    }
  }

  function publicSession(rec: SessionRecord): PublicSession {
    return {
      id: rec.id,
      direction: rec.direction,
      destination: rec.destination,
      status: rec.status,
      ...(rec.country ? { country: rec.country } : {}),
      ...(rec.plan ? { currency: rec.plan.currency } : {}),
      ...(rec.amountBounds ? { amountBounds: rec.amountBounds } : {}),
      step: rec.step,
      expiresAt: new Date(rec.expiresAt).toISOString(),
      livemode: rec.livemode,
    }
  }

  function adapterCtx(rec: SessionRecord, a: Adapter, pathway: Pathway, index: number): AdapterContext {
    return {
      session: {
        id: rec.id,
        userId: rec.userId,
        direction: rec.direction,
        ...(rec.country ? { country: rec.country } : {}),
        locale: rec.locale,
        livemode: rec.livemode,
        ...(rec.email ? { email: rec.email } : {}),
        ...(rec.region ? { region: rec.region } : {}),
        ...(rec.ip ? { ip: rec.ip } : {}),
      },
      destination: rec.destination,
      pathway: { legs: pathway.legs, index },
      urls: { returnUrl: config.returnUrl ?? `${base}/return`, webhookUrl: `${base}/webhooks/${a.id}` },
      store: scopedKV(store, `a:${a.id}:${rec.id}`),
      shared: scopedKV(store, `a:${a.id}`),
      fetch: f,
      log,
      idempotencyKey: (scope) => `${rec.id}:${scope}`,
    }
  }

  // ---------------- plan and quotes ----------------

  async function plan(rec: SessionRecord, body: { walletConnected?: boolean; surfaces?: SurfaceKind[] }) {
    const currencyGuess = rec.destination.type === 'merchant' ? rec.destination.currency : undefined
    const legs = []
    for (const a of adapters.values()) {
      let specs = a.legs
      if (a.catalog) {
        try {
          specs = await a.catalog(
            { ...(rec.country ? { country: rec.country } : {}), currency: currencyGuess ?? currencyForCountry(rec.country), direction: rec.direction },
            { fetch: f, log, shared: scopedKV(store, `a:${a.id}`) },
          )
        } catch (e) {
          log.warn(`catalog failed for ${a.id}`, { error: String(e) })
        }
      }
      for (const spec of specs) legs.push({ adapterId: a.id, provider: a.name, spec })
    }
    const result = planPathways({
      direction: rec.direction,
      destination: rec.destination,
      user: { ...(rec.country ? { country: rec.country } : {}), ...(rec.region ? { region: rec.region } : {}), walletConnected: !!body.walletConnected },
      legs,
      policy: {
        ...config.policy,
        ...(rec.allowedMethods ? { disabledMethods: [...(config.policy?.disabledMethods ?? [])] } : {}),
        clientSurfaces: body.surfaces ?? ALL_SURFACES,
      },
    })
    if (rec.allowedMethods) {
      const allowed = new Set(rec.allowedMethods)
      result.methods = result.methods.filter((m) => allowed.has(m.method))
      result.pathways = result.pathways.filter((p) => allowed.has(p.method))
    }
    rec.plan = result
    rec.walletConnected = !!body.walletConnected
    return result
  }

  async function quotePathway(rec: SessionRecord, p: Pathway, amount: string, side: 'source' | 'destination', source?: { chain: string; token: string; address?: string }): Promise<{ quote: Quote; stored: StoredQuote }> {
    const deliverTo: Array<{ address: string } | undefined> = p.legs.map(() => undefined)
    const destAddr = rec.destination.type === 'crypto' ? { address: rec.destination.address } : undefined
    deliverTo[p.legs.length - 1] = destAddr
    // Bridge legs may give the address the previous leg must deliver to (e.g. a Relay open deposit address).
    for (let i = p.legs.length - 1; i > 0; i--) {
      const a = adapter(p.legs[i]!.adapterId)
      if (a.prepareDeposit) {
        const d = await a.prepareDeposit({ leg: p.legs[i]! }, adapterCtx(rec, a, p, i))
        deliverTo[i - 1] = { address: d.address }
      }
    }
    const legQuotes = []
    let nextIn: Amount | undefined
    if (side === 'destination' && p.legs.length === 1) {
      const a = adapter(p.legs[0]!.adapterId)
      const q = await a.quote({ leg: p.legs[0]!, amountOut: { amount, asset: p.legs[0]!.to.asset }, ...(deliverTo[0] ? { deliverTo: deliverTo[0] } : {}), ...(source ? { source } : {}) }, adapterCtx(rec, a, p, 0))
      legQuotes.push(q)
    } else {
      for (let i = 0; i < p.legs.length; i++) {
        const leg = p.legs[i]!
        const a = adapter(leg.adapterId)
        const amountIn: Amount = i === 0 ? { amount, asset: source && leg.from.asset.kind === 'crypto' ? { kind: 'crypto', chain: source.chain, token: source.token } : leg.from.asset } : nextIn!
        const q = await a.quote(
          { leg, amountIn, ...(deliverTo[i] ? { deliverTo: deliverTo[i]! } : {}), ...(i === 0 && source ? { source } : {}) },
          adapterCtx(rec, a, p, i),
        )
        legQuotes.push(q)
        nextIn = q.output
      }
    }
    const first = legQuotes[0]!
    const last = legQuotes[legQuotes.length - 1]!
    const fees: Fee[] = legQuotes.flatMap((q) => q.fees)
    const expiries = legQuotes.map((q) => q.expiresAt).filter(Boolean) as string[]
    const quote: Quote = {
      id: `q_${randomHex(8)}`,
      pathwayId: p.id,
      method: p.method,
      provider: p.provider,
      legs: legQuotes,
      input: first.input,
      output: last.output,
      fees,
      eta: legQuotes.reduce((acc, q) => ({ min: acc.min + q.eta.min, max: acc.max + q.eta.max }), { min: 0, max: 0 }),
      ...(expiries.length ? { expiresAt: expiries.sort()[0]! } : {}),
    }
    return { quote, stored: { quote, pathway: p, deliverTo } }
  }

  async function quotes(rec: SessionRecord, body: { method: string; amount: string; amountSide?: 'source' | 'destination'; source?: { chain: string; token: string } }) {
    if (!rec.plan) await plan(rec, { walletConnected: rec.walletConnected ?? false })
    const candidates = rec.plan!.pathways.filter((p) => p.method === body.method && p.group !== 'unavailable')
    if (!candidates.length) throw new OrkException(orkError('NO_QUOTES'), 422)
    const source = body.source ? { ...body.source, ...(rec.walletAddress ? { address: rec.walletAddress } : {}) } : undefined
    const settled = await Promise.allSettled(
      candidates.slice(0, 5).map((p) => withTimeout(quotePathway(rec, p, body.amount, body.amountSide ?? 'source', source), 9000)),
    )
    const out: Quote[] = []
    const errors: OrkError[] = []
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        out.push(s.value.quote)
        rec.quotes[s.value.quote.id] = s.value.stored
      } else {
        const reason = s.reason
        errors.push(reason instanceof OrkException ? reason.error : orkError('PROVIDER_UNAVAILABLE', { message: String(reason?.message ?? reason).slice(0, 200) }))
        log.warn('quote failed', { error: String(reason?.message ?? reason) })
      }
    }
    // keep only the latest 20 quotes
    const keys = Object.keys(rec.quotes)
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete rec.quotes[k]
    return { quotes: rankQuotes(out), errors }
  }

  // ---------------- legs ----------------

  function composeStep(rec: SessionRecord): Step {
    const act = rec.active!
    const leg = act.legs[act.index]!
    const ls = leg.step!
    const progress = { legs: act.legs.map((l) => ({ adapterId: l.adapterId, legId: l.legId, status: l.step?.status ?? 'pending', ...(l.step?.txHash ? { txHash: l.step.txHash } : {}) })) }
    const allDone = act.legs.every((l) => l.step?.status === 'succeeded')
    if (allDone) return { sessionId: rec.id, state: 'COMPLETED', transitions: [], progress, legIndex: act.index }
    return {
      sessionId: rec.id,
      state: ls.state === 'COMPLETED' ? 'PROCESSING' : ls.state,
      ...(ls.sub ? { sub: ls.sub } : {}),
      legIndex: act.index,
      ...(ls.surface ? { surface: ls.surface } : {}),
      transitions: ls.state === 'COMPLETED' ? [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10000, giveUpAfterMs: 30 * 60_000 } }] : ls.transitions,
      ...(ls.error ? { error: ls.error } : {}),
      progress,
      expiresAt: new Date(rec.expiresAt).toISOString(),
    }
  }

  async function wrapSurface(rec: SessionRecord, ls: LegStep): Promise<LegStep> {
    // Popup-safe start URL: the browser opens our URL inside the click, we 302 to the provider.
    if (ls.surface?.kind === 'REDIRECT') {
      const token = randomHex(12)
      rec.startUrls[token] = { url: ls.surface.url, exp: Date.now() + 10 * 60_000, ...(ls.surface.keepReferrer ? { keepReferrer: true } : {}) }
      const sig = (await hmacHex(config.secret, `${rec.id}.${token}`)).slice(0, 32)
      return { ...ls, surface: { ...ls.surface, url: `${base}/start/${rec.id}.${token}.${sig}` } }
    }
    return ls
  }

  async function setLegStep(rec: SessionRecord, i: number, ls: LegStep) {
    const act = rec.active!
    const leg = act.legs[i]!
    const wrapped = await wrapSurface(rec, ls)
    leg.step = wrapped
    if (wrapped.ref && wrapped.ref !== leg.ref) {
      leg.ref = wrapped.ref
      await store.kv.put(`ref:${leg.adapterId}:${wrapped.ref}`, rec.id, 60 * 60 * 24 * 30)
    }
    if (wrapped.status === 'succeeded') await notify(rec, 'leg.succeeded', { index: i, adapterId: leg.adapterId, legId: leg.legId })
    if (wrapped.status === 'failed') await notify(rec, 'leg.failed', { index: i, adapterId: leg.adapterId, error: wrapped.error })
    // advance to the next leg
    if (wrapped.status === 'succeeded' && i === act.index && i < act.legs.length - 1) {
      act.index = i + 1
      await startLeg(rec, act.index)
      return
    }
    rec.step = composeStep(rec)
    await settleStatus(rec)
  }

  async function startLeg(rec: SessionRecord, i: number) {
    const act = rec.active!
    const leg = act.legs[i]!
    const a = adapter(leg.adapterId)
    leg.started = true
    const ls = await a.start(
      { leg: act.pathway.legs[i]!, quote: leg.quote, ...(leg.deliverTo ? { deliverTo: leg.deliverTo } : {}), ...(i === 0 && rec.walletAddress && leg.quote.input.asset.kind === 'crypto' ? { source: { chain: leg.quote.input.asset.chain, token: leg.quote.input.asset.token, address: rec.walletAddress } } : {}) },
      adapterCtx(rec, a, act.pathway, i),
    )
    await setLegStep(rec, i, ls)
  }

  async function settleStatus(rec: SessionRecord) {
    const before = rec.status
    const s = rec.step.state
    const status: SessionStatus = s === 'COMPLETED' ? 'completed' : s === 'FAILED' || s === 'BLOCKED' ? 'failed' : s === 'EXPIRED' ? 'expired' : s === 'REFUNDED' ? 'refunded' : rec.active ? 'processing' : 'open'
    rec.status = status
    if (status !== before && ['completed', 'failed', 'expired', 'refunded'].includes(status)) {
      await notify(rec, `session.${status}`)
    }
  }

  async function refreshActive(rec: SessionRecord, force = false) {
    const act = rec.active
    if (!act || isTerminal(rec.step.state)) return false
    const leg = act.legs[act.index]!
    if (!leg.ref || !leg.step || isLegTerminal(leg.step.status)) return false
    const a = adapter(leg.adapterId)
    if (!a.status) return false
    if (!force && leg.lastCheckedAt && Date.now() - leg.lastCheckedAt < 2000) return false
    leg.lastCheckedAt = Date.now()
    try {
      const ls = await a.status({ leg: act.pathway.legs[act.index]!, ref: leg.ref }, adapterCtx(rec, a, act.pathway, act.index))
      if (ls.status !== leg.step.status || ls.state !== leg.step.state || ls.sub !== leg.step.sub) {
        await setLegStep(rec, act.index, { ...ls, ...(ls.surface ? {} : leg.step.surface ? { surface: leg.step.surface } : {}) })
        return true
      }
    } catch (e) {
      log.warn('status check failed', { adapter: a.id, error: String(e) })
    }
    return false
  }

  async function applyEvent(adapterId: string, ev: LegEvent) {
    const sid = await store.kv.get<string>(`ref:${adapterId}:${ev.ref}`)
    if (!sid) return log.warn('event for unknown ref', { adapterId, ref: ev.ref })
    for (let attempt = 0; attempt < 3; attempt++) {
      const rec = await store.get(sid)
      if (!rec?.active) return
      const i = rec.active.legs.findIndex((l) => l.adapterId === adapterId && l.ref === ev.ref)
      if (i === -1) return
      const cur = rec.active.legs[i]!.step
      if (cur && isLegTerminal(cur.status)) return // idempotent
      const ls: LegStep = {
        ...(cur ?? { transitions: [] }),
        status: ev.status,
        state: ev.status === 'succeeded' ? 'COMPLETED' : ev.status === 'failed' ? 'FAILED' : ev.status === 'refunded' ? 'REFUNDED' : ev.status === 'expired' ? 'EXPIRED' : 'PROCESSING',
        transitions: isLegTerminal(ev.status) ? [] : [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 2500, backoff: 1.2, maxIntervalMs: 10000, giveUpAfterMs: 30 * 60_000 } }],
        ...(ev.output ? { output: ev.output } : {}),
        ...(ev.txHash ? { txHash: ev.txHash } : {}),
        ...(ev.error ? { error: ev.error } : {}),
        ref: ev.ref,
      }
      if (isLegTerminal(ev.status)) delete ls.surface
      try {
        await setLegStep(rec, i, ls)
        await save(rec)
        return
      } catch (e) {
        if (e instanceof OrkException && e.status === 409) continue
        throw e
      }
    }
  }

  // ---------------- outbound webhooks ----------------

  async function notify(rec: SessionRecord, type: string, extra?: Record<string, unknown>) {
    if (!config.webhooks) return
    const key = `${type}:${JSON.stringify(extra ?? {})}`
    if (rec.notified.includes(key)) return
    rec.notified.push(key)
    const event = createEvent(type, { session: publicSession(rec), userId: rec.userId, metadata: rec.metadata ?? {}, ...extra }, { sessionId: rec.id, livemode: rec.livemode })
    const body = JSON.stringify(event)
    const ts = Math.floor(Date.now() / 1000)
    try {
      const res = await withTimeout(
        f(config.webhooks.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'openramp-id': event.id,
            'openramp-timestamp': String(ts),
            'openramp-signature': await signWebhook(config.webhooks.secret, event.id, ts, body),
          },
          body,
        }),
        4000,
      )
      if (!res.ok) log.warn('webhook delivery failed', { status: res.status, type })
    } catch (e) {
      log.warn('webhook delivery error', { error: String(e), type })
    }
  }

  // ---------------- HTTP ----------------

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin')
    const allowed = config.cors?.origins
    if (!origin || !allowed) return {}
    if (allowed !== '*' && !allowed.includes(origin)) return {}
    return {
      'access-control-allow-origin': allowed === '*' ? '*' : origin,
      'access-control-allow-headers': 'authorization, content-type, idempotency-key',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      vary: 'origin',
    }
  }

  function geoOf(req: Request) {
    if (config.geo) return config.geo(req) ?? {}
    const country = req.headers.get('cf-ipcountry') ?? req.headers.get('x-vercel-ip-country') ?? undefined
    const r = req.headers.get('x-vercel-ip-country-region')
    return { ...(country && country !== 'XX' ? { country } : {}), ...(country && r ? { region: `${country}-${r}` } : {}) }
  }

  async function withIdempotency(rec: SessionRecord, req: Request, run: () => Promise<Response>): Promise<Response> {
    const key = req.headers.get('idempotency-key')
    if (!key) return run()
    const k = `idem:${rec.id}:${key}`
    const hit = await store.kv.get<{ status: number; body: string }>(k)
    if (hit) return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' } })
    const res = await run()
    const body = await res.clone().text()
    await store.kv.put(k, { status: res.status, body }, 60 * 60 * 24)
    return res
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    let path = url.pathname
    if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length)
    const parts = path.split('/').filter(Boolean)
    const method = req.method.toUpperCase()

    // POST /sessions (browser-created sessions via the app's authorize hook)
    if (parts.length === 1 && parts[0] === 'sessions' && method === 'POST') {
      if (!config.authorize) return errorResponse(orkError('NOT_FOUND'), 404)
      const body = await req.json().catch(() => ({}))
      const input = await config.authorize(req, body)
      if (!input) return errorResponse(orkError('UNAUTHORIZED'), 401)
      const g = geoOf(req)
      return json(await createSession({ ...g, ...input }), 201)
    }

    if (parts[0] === 'sessions' && parts[1]) {
      const rec = await loadAuthed(req, parts[1])
      const ip = clientIp(req)
      if (ip) rec.ip = ip
      const action = parts[2]
      if (!action && method === 'GET') return json(publicSession(rec))

      if (action === 'step' && method === 'GET') {
        const changed = await refreshActive(rec)
        if (changed) await save(rec)
        return json(publicSession(rec))
      }

      if (action === 'plan' && method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { walletConnected?: boolean; walletAddress?: string; surfaces?: SurfaceKind[] }
        if (body.walletAddress) rec.walletAddress = body.walletAddress
        const result = await plan(rec, body)
        await save(rec)
        return json(result)
      }

      if (action === 'quotes' && method === 'POST') {
        if (rec.active) return errorResponse(orkError('BAD_REQUEST', { message: 'A payment is already in progress.' }), 409)
        const body = (await req.json()) as { method: string; amount: string; amountSide?: 'source' | 'destination'; source?: { chain: string; token: string } }
        const result = await quotes(rec, body)
        await save(rec)
        return json(result)
      }

      if (action === 'select' && method === 'POST') {
        return withIdempotency(rec, req, async () => {
          const body = (await req.json()) as { quoteId: string; walletAddress?: string }
          const stored = rec.quotes[body.quoteId]
          if (!stored) return errorResponse(orkError('QUOTE_EXPIRED'), 410)
          if (stored.quote.expiresAt && Date.parse(stored.quote.expiresAt) < Date.now()) return errorResponse(orkError('QUOTE_EXPIRED'), 410)
          if (rec.active && !isTerminal(rec.step.state)) return errorResponse(orkError('BAD_REQUEST', { message: 'A payment is already in progress.' }), 409)
          if (body.walletAddress) rec.walletAddress = body.walletAddress
          rec.active = {
            quoteId: body.quoteId,
            pathway: stored.pathway,
            index: 0,
            legs: stored.pathway.legs.map((l, i): ActiveLeg => ({
              adapterId: l.adapterId,
              legId: l.legId,
              quote: stored.quote.legs[i]!,
              ...(stored.deliverTo[i] ? { deliverTo: stored.deliverTo[i]! } : {}),
              started: false,
            })),
          }
          try {
            await startLeg(rec, 0)
          } catch (e) {
            rec.active = undefined
            throw e
          }
          await save(rec)
          return json(publicSession(rec))
        })
      }

      if (action === 'transitions' && parts[3] && method === 'POST') {
        const name = decodeURIComponent(parts[3])
        return withIdempotency(rec, req, async () => {
          const body = (await req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> }
          if (name === 'restart') {
            if (rec.active && !isTerminal(rec.step.state) && rec.step.state !== 'PAYMENT') return errorResponse(orkError('BAD_REQUEST', { message: 'This payment can no longer be changed.' }), 409)
            rec.active = undefined
            rec.status = 'open'
            rec.step = { sessionId: rec.id, state: 'SELECT_METHOD', transitions: [], expiresAt: new Date(rec.expiresAt).toISOString() }
            await save(rec)
            return json(publicSession(rec))
          }
          const act = rec.active
          if (!act) return errorResponse(orkError('BAD_REQUEST', { message: 'Nothing to continue.' }), 409)
          const allowed = rec.step.transitions.some((t) => t.name === name && t.kind !== 'AWAIT')
          if (!allowed) return errorResponse(orkError('BAD_REQUEST', { message: `Transition ${name} is not allowed now.` }), 409)
          const leg = act.legs[act.index]!
          const a = adapter(leg.adapterId)
          if (!a.transition) return errorResponse(orkError('BAD_REQUEST', { message: `Transition ${name} is not supported.` }), 409)
          const ls = await a.transition({ leg: act.pathway.legs[act.index]!, ref: leg.ref ?? '', name, ...(body.inputs ? { inputs: body.inputs } : {}) }, adapterCtx(rec, a, act.pathway, act.index))
          await setLegStep(rec, act.index, ls)
          await save(rec)
          return json(publicSession(rec))
        })
      }
      return errorResponse(orkError('NOT_FOUND'), 404)
    }

    // GET /start/:sessionId.token.sig  -> 302 to the provider
    if (parts[0] === 'start' && parts[1] && method === 'GET') {
      const [sid, token, sig] = parts[1].split('.')
      if (!sid || !token || !sig) return errorResponse(orkError('NOT_FOUND'), 404)
      const expected = (await hmacHex(config.secret, `${sid}.${token}`)).slice(0, 32)
      if (!safeEqual(sig, expected)) return errorResponse(orkError('UNAUTHORIZED'), 401)
      const rec = await store.get(sid)
      const entry = rec?.startUrls[token]
      if (!entry || entry.exp < Date.now()) return new Response('This link expired. Go back to the app and try again.', { status: 410 })
      return new Response(null, { status: 302, headers: { location: entry.url, 'cache-control': 'no-store', 'referrer-policy': entry.keepReferrer ? 'strict-origin' : 'no-referrer' } })
    }

    // GET /return -> tiny page that closes itself
    if (parts[0] === 'return' && method === 'GET') {
      return new Response('<!doctype html><meta charset="utf-8"><title>Payment</title><body style="font-family:system-ui;padding:32px">You can close this tab and go back to the app.<script>setTimeout(()=>window.close(),800)</script>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    // POST /webhooks/:adapterId
    if (parts[0] === 'webhooks' && parts[1] && method === 'POST') {
      const a = adapters.get(parts[1])
      if (!a?.webhook) return errorResponse(orkError('NOT_FOUND'), 404)
      const raw = await req.text()
      const wctx = { log, fetch: f, shared: scopedKV(store, `a:${a.id}`) }
      if (!(await a.webhook.verify(req, raw, wctx))) return errorResponse(orkError('UNAUTHORIZED'), 401)
      const events = await a.webhook.parse(raw, { ...wctx, url: req.url })
      for (const ev of events) await applyEvent(a.id, ev)
      return json({ received: true })
    }

    // /adapters/:id/*  -> adapter routes
    if (parts[0] === 'adapters' && parts[1]) {
      const a = adapters.get(parts[1])
      if (a?.routes) {
        const res = await a.routes(req, parts.slice(2).join('/'), {
          fetch: f,
          log,
          shared: scopedKV(store, `a:${a.id}`),
          baseUrl: base,
          applyEvent: (ev) => applyEvent(a.id, ev),
        })
        if (res) return res
      }
      return errorResponse(orkError('NOT_FOUND'), 404)
    }

    if (parts[0] === 'health' && method === 'GET') {
      const checks = await Promise.all([...adapters.values()].map(async (a) => ({ id: a.id, ...(a.health ? await a.health({ fetch: f, log }).catch((e) => ({ ok: false, detail: String(e) })) : { ok: true }) })))
      return json({ ok: checks.every((c) => c.ok), adapters: checks })
    }

    return errorResponse(orkError('NOT_FOUND'), 404)
  }

  async function handle(req: Request): Promise<Response> {
    const cors = corsHeaders(req)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    let res: Response
    try {
      res = await route(req)
    } catch (e) {
      if (e instanceof OrkException) res = errorResponse(e.error, e.status)
      else {
        log.error('unhandled error', { error: e instanceof Error ? e.stack ?? e.message : String(e) })
        res = errorResponse(orkError('INTERNAL'), 500)
      }
    }
    if (!Object.keys(cors).length) return res
    const h = new Headers(res.headers)
    for (const [k, v] of Object.entries(cors)) h.set(k, v)
    return new Response(res.body, { status: res.status, headers: h })
  }

  return {
    /** Web-standard handler. Mount it at `baseUrl`. */
    handle,
    /** Cloudflare Workers / Bun / Deno style export: `export default openramp` */
    fetch: handle,
    /** Next.js App Router: `export const { GET, POST, OPTIONS } = openramp.nextHandlers()` */
    nextHandlers: () => ({ GET: handle, POST: handle, OPTIONS: handle }),
    sessions: {
      create: createSession,
      async retrieve(id: string) {
        const rec = await store.get(id)
        return rec ? publicSession(rec) : null
      },
      /** Server-side status refresh, e.g. from a cron job */
      async refresh(id: string) {
        const rec = await store.get(id)
        if (!rec) return null
        if (await refreshActive(rec, true)) await save(rec)
        return publicSession(rec)
      },
    },
    webhooks: {
      verify: (req: Request, body: string) => (config.webhooks ? verifyWebhook(config.webhooks.secret, req.headers, body) : Promise.resolve(false)),
    },
  }
}

export type OpenRamp = ReturnType<typeof createOpenRamp>

function clientIp(req: Request): string | undefined {
  const h = req.headers
  return h.get('cf-connecting-ip') ?? h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined
}

function normalizeDestination(d: Destination): Destination {
  if (d.type === 'crypto') return { ...d, token: d.token.toLowerCase() }
  return { ...d, currency: d.currency.toUpperCase() }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}
