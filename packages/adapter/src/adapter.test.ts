import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRampException, openRampError, stateFor, timingSafeEqual as coreTimingSafeEqual } from '@openrampkit/core'
import type { LegQuote, LegSpec, LegStep, PathwayLeg } from '@openrampkit/core'
import {
  POLL,
  awaitPoll,
  checkAdapterShape,
  checkLegQuote,
  checkLegStep,
  createAdapter,
  decimalFrom,
  fetchJson,
  hmacSha256,
  httpErrorToOpenRamp,
  httpStatus,
  legStepFromEvent,
  providerMessage,
  providerSetupError,
  randomHex,
  timingSafeEqual,
} from './index.js'
import type { Adapter } from './index.js'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from './testing.js'

const spec = (extra: Partial<LegSpec> = {}): LegSpec => ({
  id: 'card',
  kind: 'fiat_onramp',
  from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
  to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
  regions: { allow: ['*'], deny: [] },
  eta: { min: 1, max: 2 },
  surfaces: ['REDIRECT'],
  ...extra,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createAdapter', () => {
  it('sets the API version and rejects bad ids and duplicate legs', () => {
    expect(createAdapter({ id: 'ok-1', name: 'Ok', legs: [spec()], quote: vi.fn(), start: vi.fn() }).apiVersion).toBe(2)
    expect(createAdapter({ id: 'ok-2', name: 'Ok', apiVersion: 2, legs: [spec()], quote: vi.fn(), start: vi.fn() }).apiVersion).toBe(2)
    // An adapter built for the version 1 contract (LegStep.state, txHash) is refused with a clear message.
    expect(() => createAdapter({ id: 'old', name: 'Old', apiVersion: 1, legs: [spec()], quote: vi.fn(), start: vi.fn() })).toThrow(/built for adapter API version 1.*supports version 2/)
    expect(() => createAdapter({ id: 'Bad Id', name: 'x', legs: [], quote: vi.fn(), start: vi.fn() })).toThrow(/lowercase/)
    expect(() => createAdapter({ id: '', name: 'x', legs: [], quote: vi.fn(), start: vi.fn() })).toThrow(/lowercase/)
    expect(() => createAdapter({ id: 'dup', name: 'x', legs: [spec(), spec()], quote: vi.fn(), start: vi.fn() })).toThrow(/duplicate leg id card/)
  })
})

describe('crypto helpers', () => {
  it('hmacSha256 gives hex and base64; timingSafeEqual compares', async () => {
    // RFC 4231 test case 2
    expect(await hmacSha256('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    expect(await hmacSha256('Jefe', 'what do ya want for nothing?', 'base64')).toBe('W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=')
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/)
    expect(randomHex()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('timingSafeEqual is the one implementation from core', () => {
    expect(timingSafeEqual).toBe(coreTimingSafeEqual)
  })
})

describe('fetchJson', () => {
  it('sends JSON with default and custom headers (plain object or Headers)', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/ok', reply: () => ({ a: 1 }) }])
    expect(await fetchJson(fetch, 'https://x.test/ok', { method: 'POST', body: '{"b":2}', headers: { 'X-Key': 'k' } })).toEqual({ a: 1 })
    expect(calls[0]!.headers.get('content-type')).toBe('application/json')
    expect(calls[0]!.headers.get('accept')).toBe('application/json')
    expect(calls[0]!.headers.get('x-key')).toBe('k')
    await fetchJson(fetch, 'https://x.test/ok', { headers: new Headers({ authorization: 'Bearer t' }) })
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer t')
    expect(calls[1]!.headers.get('content-type')).toBeNull()
  })

  it('an empty 200 body is undefined', async () => {
    const { fetch } = fakeFetch([{ match: '/', reply: () => undefined }])
    expect(await fetchJson(fetch, 'https://x.test/')).toBeUndefined()
  })

  it('HTTP errors carry status and the parsed body', async () => {
    const { fetch } = fakeFetch([{ match: '/', status: 422, reply: () => ({ message: 'nope' }) }])
    await expect(fetchJson(fetch, 'https://x.test/')).rejects.toMatchObject({ status: 422, body: { message: 'nope' }, message: expect.stringContaining('HTTP 422 from x.test') })
  })

  it('a non-JSON error page keeps its HTTP status (was a SyntaxError)', async () => {
    const { fetch } = fakeFetch([{ match: '/', reply: () => new Response('<html>Bad gateway</html>', { status: 502 }) }])
    const err = await fetchJson(fetch, 'https://x.test/').catch((e) => e)
    expect(err).not.toBeInstanceOf(SyntaxError)
    expect(err).toMatchObject({ status: 502, body: undefined })
    const rl = fakeFetch([{ match: '/', reply: () => new Response('Too many requests', { status: 429 }) }])
    expect(httpErrorToOpenRamp(await fetchJson(rl.fetch, 'https://x.test/').catch((e) => e), 'P').error.code).toBe('RATE_LIMITED')
  })

  it('invalid JSON in a 200 answer is an error with the status, not a SyntaxError', async () => {
    const { fetch } = fakeFetch([{ match: '/', reply: () => new Response('{oops', { status: 200 }) }])
    const err = await fetchJson(fetch, 'https://x.test/').catch((e: Error) => e)
    expect(err).not.toBeInstanceOf(SyntaxError)
    expect((err as Error).message).toMatch(/Invalid JSON from x.test/)
  })

  it('times out with a TimeoutError that maps to PROVIDER_UNAVAILABLE 504', async () => {
    vi.useFakeTimers()
    const { fetch } = fakeFetch([{ match: '/', hang: true }])
    const p = fetchJson(fetch, 'https://x.test/', { timeoutMs: 50 }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(60)
    const err = await p
    expect(err).toMatchObject({ name: 'TimeoutError', timeout: true })
    const log = recordingLog()
    const ork = httpErrorToOpenRamp(err, 'Acme', { log })
    expect(ork.status).toBe(504)
    expect(ork.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'Acme did not answer in time.' })
    expect(log.warnings).toEqual(['Acme: request timed out'])
  })

  it('network errors pass through', async () => {
    const { fetch } = fakeFetch([
      {
        match: '/',
        reply: () => {
          throw new TypeError('fetch failed')
        },
      },
    ])
    await expect(fetchJson(fetch, 'https://x.test/')).rejects.toThrow('fetch failed')
  })
})

describe('httpErrorToOpenRamp', () => {
  const httpErr = (status: number, body?: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, body })

  it('maps 429, no-quote 4xx, other 4xx, 5xx and unknown errors', () => {
    const same = new OpenRampException(openRampError('BAD_REQUEST'), 400)
    expect(httpErrorToOpenRamp(same, 'P')).toBe(same)
    expect(httpErrorToOpenRamp(httpErr(429), 'P')).toMatchObject({ status: 429, error: { code: 'RATE_LIMITED' } })
    for (const s of [400, 404, 409, 422]) {
      expect(httpErrorToOpenRamp(httpErr(s, { message: 'Amount too low' }), 'P')).toMatchObject({ status: 422, error: { code: 'NO_QUOTES', message: 'P: Amount too low' } })
    }
    expect(httpErrorToOpenRamp(httpErr(400), 'P', { what: 'price this' }).error.message).toBe('P could not price this.')
    expect(httpErrorToOpenRamp(httpErr(400), 'P').error.message).toBe('P could not handle this request.')
    expect(httpErrorToOpenRamp(httpErr(400, { message: 'x'.repeat(500) }), 'P').error.message).toHaveLength(200)
    const log = recordingLog()
    for (const s of [500, 503]) {
      expect(httpErrorToOpenRamp(httpErr(s, { message: 'Invalid API key' }), 'P', { log })).toMatchObject({ status: 502, error: { code: 'PROVIDER_UNAVAILABLE', message: 'P is not available right now.', retryable: true } })
    }
    expect(log.warnings).toHaveLength(2)
    expect(log.errors).toHaveLength(0)
    expect(httpErrorToOpenRamp(httpErr(404), 'P', { noQuoteStatuses: [400] }).error.code).toBe('PROVIDER_UNAVAILABLE')
    expect(httpErrorToOpenRamp('weird', 'P').error.code).toBe('PROVIDER_UNAVAILABLE')
    expect(httpErrorToOpenRamp(undefined, 'P').error.code).toBe('PROVIDER_UNAVAILABLE')
  })

  it('maps 401 and 403 to a setup error: not retryable, choose_other, neutral message, one error log that names the provider', () => {
    for (const s of [401, 403]) {
      const log = recordingLog()
      const ex = httpErrorToOpenRamp(httpErr(s, { message: 'Invalid API key' }), 'Acme', { what: 'price this amount', log })
      expect(ex.status).toBe(502)
      expect(ex.error).toEqual({ code: 'PROVIDER_UNAVAILABLE', message: 'Acme is not set up for this app yet. Try another method.', retryable: false, recovery: 'choose_other' })
      // The provider text stays out of the user message.
      expect(ex.error.message).not.toContain('Invalid API key')
      expect(log.errors).toHaveLength(1)
      expect(log.warnings).toHaveLength(0)
      expect(log.errors[0]).toMatch(new RegExp(`^Acme: cannot price this amount: .*HTTP ${s}.*setup error`))
    }
    // A setup hint goes into the operator log.
    const log = recordingLog()
    httpErrorToOpenRamp(httpErr(401), 'Acme', { log, setupHint: 'Set acme({ apiKey }).' })
    expect(log.errors[0]).toContain('Set acme({ apiKey }).')
    // A logger with only `warn` still gets the line.
    const warnOnly = { warnings: [] as string[], warn(m: string) { this.warnings.push(m) } }
    httpErrorToOpenRamp(httpErr(403), 'Acme', { log: warnOnly })
    expect(warnOnly.warnings).toHaveLength(1)
    // providerSetupError is the same error, for adapters with their own mapping.
    expect(providerSetupError('Acme').error).toEqual(httpErrorToOpenRamp(httpErr(401), 'Acme').error)
  })

  it('reads the provider message from common body shapes', () => {
    const e = (body: unknown) => ({ body })
    expect(providerMessage(e({ message: ' a ' }))).toBe('a')
    expect(providerMessage(e({ errorMessage: 'b' }))).toBe('b')
    expect(providerMessage(e({ error: { message: 'c' } }))).toBe('c')
    expect(providerMessage(e({ error: 'd' }))).toBe('d')
    expect(providerMessage(e({ message: '' }))).toBeUndefined()
    expect(providerMessage(e('text'))).toBeUndefined()
    expect(providerMessage(e(undefined))).toBeUndefined()
    expect(providerMessage(undefined)).toBeUndefined()
    expect(httpStatus({ status: '500' })).toBeUndefined()
    expect(httpStatus(null)).toBeUndefined()
  })
})

describe('util', () => {
  it('decimalFrom turns provider numbers into exact decimals', () => {
    expect(decimalFrom(95.93)).toBe('95.93')
    expect(decimalFrom(1e-7)).toBe('0.0000001')
    expect(decimalFrom(1e-7, 2)).toBe('0')
    expect(decimalFrom(100, 2)).toBe('100')
    expect(decimalFrom(12)).toBe('12')
    expect(decimalFrom('4.81')).toBe('4.81')
    expect(decimalFrom('1e2')).toBe('100')
    expect(decimalFrom(undefined)).toBe('0')
    expect(decimalFrom(null)).toBe('0')
    expect(decimalFrom(Number.NaN)).toBe('0')
    expect(decimalFrom(Number.POSITIVE_INFINITY)).toBe('0')
  })

  it('legStepFromEvent keeps the event and adds a poll; stateFor gives the state', () => {
    const ref = 'r1'
    const cases: Array<[Parameters<typeof legStepFromEvent>[0], string, string]> = [
      [undefined, 'PAYMENT', 'requires_action'],
      [{ ref, status: 'pending' }, 'PROCESSING', 'pending'],
      [{ ref, status: 'requires_action' }, 'PAYMENT', 'requires_action'],
      [{ ref, status: 'processing' }, 'PROCESSING', 'processing'],
      [{ ref, status: 'processing', phase: 'kyc' }, 'KYC', 'processing'],
      [{ ref, status: 'requires_action', action: { kind: 'kyc', transitions: [] } }, 'KYC', 'requires_action'],
      [{ ref, status: 'succeeded', transactions: [{ role: 'destination', hash: '0x1' }], output: { value: '1', asset: { kind: 'fiat', currency: 'USD' } } }, 'COMPLETED', 'succeeded'],
      [{ ref, status: 'failed', error: openRampError('PAYMENT_FAILED') }, 'FAILED', 'failed'],
      [{ ref, status: 'failed' }, 'FAILED', 'failed'],
      [{ ref, status: 'refunded' }, 'REFUNDED', 'refunded'],
      [{ ref, status: 'expired' }, 'EXPIRED', 'expired'],
    ]
    for (const [ev, state, status] of cases) {
      const s = legStepFromEvent(ev, ref, POLL.checkout)
      expect(s).toMatchObject({ status, ref })
      expect(stateFor(s)).toBe(state)
      expect(checkLegStep(s)).toEqual([])
    }
    expect(legStepFromEvent(undefined, ref, POLL.checkout)).toEqual({ status: 'requires_action', action: { kind: 'payment', transitions: [awaitPoll(POLL.checkout)] }, ref })
    expect(legStepFromEvent({ ref, status: 'processing', eventId: 'e1' }, ref, POLL.checkout)).toEqual({ ref, status: 'processing', poll: POLL.checkout })
    expect(legStepFromEvent({ ref, status: 'succeeded', transactions: [{ role: 'destination', hash: '0x1' }] }, ref, POLL.checkout).transactions).toEqual([{ role: 'destination', hash: '0x1' }])
    expect(legStepFromEvent({ ref, status: 'failed', error: openRampError('PAYMENT_FAILED') }, ref, POLL.checkout).error?.code).toBe('PAYMENT_FAILED')
    expect(awaitPoll(POLL.onchain, 'wait')).toEqual({ name: 'wait', kind: 'AWAIT', poll: POLL.onchain })
  })
})

describe('testkit checks', () => {
  const base = createAdapter({ id: 't', name: 'T', legs: [spec()], quote: vi.fn(), start: vi.fn() })

  it('checkAdapterShape reports every problem', () => {
    expect(checkAdapterShape(base)).toEqual([])
    const bad = {
      ...base,
      apiVersion: 1,
      legs: [spec({ eta: { min: 5, max: 1 }, surfaces: [], regions: { allow: [], deny: [] }, limits: { min: '1e3', max: 'ten', currency: 'USD' } }), spec({ id: 'ok', limits: { min: '1', currency: 'USD' } })],
    } as Adapter
    expect(checkAdapterShape(bad).map((p) => p.problem)).toEqual([
      'Unsupported apiVersion 1 (this kit checks version 2)',
      'eta.min > eta.max',
      'No surfaces declared',
      'Region policy allows nothing',
      'limits.min is not a decimal string',
      'limits.max is not a decimal string',
    ])
    expect(checkAdapterShape({ ...base, legs: [] })).toEqual([{ where: 'legs', problem: 'Adapter declares no legs' }])
    // Capabilities: only the two that the server reads. 'polling' and 'webhooks' come from status() and webhook.
    const caps = { ...base, legs: [spec({ capabilities: ['settlement', 'surface_after_processing', 'polling'] as never })] } as Adapter
    expect(checkAdapterShape(caps).map((p) => p.problem)).toEqual([expect.stringContaining('Unknown capability polling')])
  })

  it('checkLegQuote checks money strings and expiry', () => {
    const q: LegQuote = {
      adapterId: 't',
      legId: 'card',
      input: { value: '10', asset: { kind: 'fiat', currency: 'USD' } },
      output: { value: '9.5', asset: { kind: 'fiat', currency: 'USD' } },
      fees: [{ kind: 'provider', label: 'Fee', amount: { value: '0.5', asset: { kind: 'fiat', currency: 'USD' } }, included: true }],
      guarantee: 'estimate',
      eta: { min: 1, max: 2 },
      expiresAt: new Date().toISOString(),
    }
    expect(checkLegQuote(q)).toEqual([])
    const bad = { ...q, input: { ...q.input, value: '1e1' }, output: { ...q.output, value: '' }, fees: [{ ...q.fees[0]!, amount: { value: 'x', asset: { kind: 'fiat' as const, currency: 'USD' } } }], expiresAt: 'tomorrow' }
    expect(checkLegQuote(bad).map((p) => p.where)).toEqual(['quote.input', 'quote.output', 'fee Fee', 'quote.expiresAt'])
  })

  it('checkLegStep checks the v2 rules', () => {
    const ok: LegStep = { status: 'requires_action', action: { kind: 'payment', transitions: [awaitPoll(POLL.dev)] }, ref: 'r' }
    expect(checkLegStep(ok)).toEqual([])
    expect(checkLegStep({ status: 'succeeded', transactions: [{ role: 'source', hash: '0x1' }, { role: 'destination', hash: '0x2' }] })).toEqual([])
    expect(checkLegStep({ status: 'processing', phase: 'kyc', detail: { code: 'kyc_review', providerStatus: 'UNDER_REVIEW' } })).toEqual([])
    const problems = (s: unknown) => checkLegStep(s as LegStep).map((p) => p.problem)
    expect(problems({ status: 'bogus' })).toEqual(['unknown leg status bogus'])
    expect(problems({ status: 'requires_action' })).toEqual(['requires_action without an action'])
    expect(problems({ status: 'processing', action: { kind: 'payment', transitions: [] } })).toEqual(['an action with status processing (only requires_action has one)'])
    expect(problems({ status: 'succeeded', phase: 'kyc' })).toEqual(['phase kyc with status succeeded (only pending or processing)'])
    expect(problems({ status: 'requires_action', action: { kind: 'pay', transitions: [] } })).toEqual(['unknown action kind pay'])
    expect(problems({ status: 'processing', detail: { code: 'SETTLING' } })).toEqual(['detail code SETTLING is not in STEP_DETAIL_CODES'])
    expect(problems({ status: 'succeeded', transactions: [{ role: 'hop', hash: '0x1' }, { role: 'source', hash: '' }] })).toEqual(['transaction role hop (hop is set by the server)', 'transaction without a hash'])
    expect(problems({ state: 'PAYMENT', status: 'requires_action', action: { kind: 'payment', transitions: [] }, txHash: '0x1' })).toEqual([
      'has the adapter API v1 field state (v2: status, action, detail, transactions)',
      'has the adapter API v1 field txHash (v2: status, action, detail, transactions)',
    ])
    expect(problems({ status: 'requires_action', action: { kind: 'payment', transitions: [awaitPoll(POLL.dev), awaitPoll(POLL.dev)] } })).toEqual(['Duplicate transition poll'])
  })
})

describe('testing helpers', () => {
  it('memoryKV expires entries by TTL', async () => {
    vi.useFakeTimers()
    const kv = memoryKV()
    await kv.put('a', 1, 10)
    await kv.put('b', 2)
    expect(await kv.get('a')).toBe(1)
    expect(kv.data.get('a')).toBe(1)
    vi.advanceTimersByTime(10_001)
    expect(await kv.get('a')).toBeUndefined()
    expect(kv.data.has('a')).toBe(false)
    expect(await kv.get('b')).toBe(2)
    expect(await kv.get('missing')).toBeUndefined()
  })

  it('fakeFetch records calls, keeps non-JSON bodies, 404s unknown routes', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: /\/x$/, reply: (c) => ({ echo: c.body }) }])
    const res = await fetch('https://a.test/x', { method: 'POST', body: 'not json' })
    expect(await res.json()).toEqual({ echo: 'not json' })
    expect((await fetch(new Request('https://a.test/y'))).status).toBe(404)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://a.test/x'],
      ['GET', 'https://a.test/y'],
    ])
  })

  it('fakeFetch hang rejects at once when the signal is already aborted', async () => {
    const { fetch } = fakeFetch([{ match: '/', hang: true }])
    await expect(fetch('https://a.test/', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('makeCtx has test defaults and takes overrides', () => {
    const { fetch } = fakeFetch([])
    const log = recordingLog()
    const ctx = makeCtx({ fetch, session: { id: 'sess_9', country: 'VN' }, urls: { returnUrl: 'https://r.test' }, log })
    expect(ctx.session).toMatchObject({ id: 'sess_9', country: 'VN', userId: 'user_1', livemode: false })
    expect(ctx.urls.returnUrl).toBe('https://r.test')
    expect(ctx.urls.webhookUrl).toMatch(/webhooks/)
    expect(ctx.idempotencyKey('q')).toBe('sess_9:q')
    ctx.log.warn('w')
    ctx.log.error('e')
    ctx.log.info('i')
    ctx.log.debug('d')
    expect(log.warnings).toEqual(['w'])
    expect(log.errors).toEqual(['e'])
    expect(makeCtx({ fetch }).log).toBe(silentLog)
    expect(makeWebhookCtx().log).toBe(silentLog)
  })
})

describe('runAdapterConformance', () => {
  const leg: PathwayLeg = {
    adapterId: 'conf',
    legId: 'card',
    from: { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } },
    to: { asset: { kind: 'crypto', chain: 'eip155:8453', token: '0xa' }, location: { kind: 'address', address: '0xb' } },
  }
  const quote = (over: Partial<LegQuote> = {}): LegQuote => ({
    adapterId: 'conf',
    legId: 'card',
    input: { value: '10', asset: { kind: 'fiat', currency: 'USD' } },
    output: { value: '9', asset: { kind: 'fiat', currency: 'USD' } },
    fees: [{ kind: 'provider', label: 'Fee', amount: { value: '1', asset: { kind: 'fiat', currency: 'USD' } }, included: true }],
    guarantee: 'estimate',
    eta: { min: 1, max: 2 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  })
  const good = () =>
    createAdapter({
      id: 'conf',
      name: 'Conf',
      legs: [spec()],
      quote: async () => quote(),
      start: async () => ({ status: 'requires_action', action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'https://p.test', popup: true }, transitions: [awaitPoll(POLL.dev)] }, ref: 'r1' }),
      transition: async (i) => ({ status: 'processing', poll: POLL.dev, ref: i.ref }),
      status: async (i) => ({ status: 'succeeded', ref: i.ref }),
      webhook: {
        verify: async (req) => req.headers.get('sig') === 'ok',
        parse: async (raw) => [{ ref: JSON.parse(raw).ref as string, status: 'succeeded' }],
      },
    })
  const hook = (sig: string, valid?: boolean) => ({
    rawBody: '{"ref":"r1"}',
    request: () => new Request('https://x.test/wh', { method: 'POST', headers: { sig } }),
    ...(valid === undefined ? {} : { valid }),
  })

  it('passes a well-behaved adapter and returns quotes, steps and events', async () => {
    const r = await runAdapterConformance(good(), {
      fixtures: [{ leg, quote: { amountIn: { value: '10', asset: { kind: 'fiat', currency: 'USD' } } }, transitions: [{ name: 'go', inputs: { a: 1 } }], expect: { start: 'PAYMENT', status: 'COMPLETED' } }],
      webhooks: [{ ...hook('ok'), events: 1 }, hook('bad', false)],
    })
    expect(r.problems).toEqual([])
    expect(r.quotes).toHaveLength(1)
    expect(r.steps.map((s) => stateFor(s))).toEqual(['PAYMENT', 'PROCESSING', 'COMPLETED'])
    expect(r.events).toEqual([[{ ref: 'r1', status: 'succeeded' }]])
  })

  it('reports every kind of problem', async () => {
    let n = 0
    const bad = createAdapter({
      id: 'conf',
      name: 'Conf',
      legs: [spec({ eta: { min: 3, max: 1 } })],
      quote: async (i) => {
        if (i.leg.legId === 'throws') throw new OpenRampException(openRampError('NO_QUOTES'), 422)
        return quote({ adapterId: 'other', legId: 'x', eta: { min: 5, max: 1 }, output: { value: '-1', asset: { kind: 'fiat', currency: 'USD' } } })
      },
      start: async (i) => {
        if (i.leg.legId === 'nostart') throw new Error('start boom')
        if (i.leg.legId === 'noref') return { status: 'requires_action', action: { kind: 'payment', transitions: [] } }
        return { status: 'bogus' as never, ref: 'r' }
      },
      transition: async () => {
        throw new Error('transition boom')
      },
      status: async () => ({ status: 'requires_action', action: { kind: 'payment', transitions: [] } }),
      webhook: {
        verify: async () => true,
        parse: async () => [{ ref: '', status: `s${n++}` as never }],
      },
    })
    const r = await runAdapterConformance(bad, {
      fixtures: [
        { name: 'main', leg: { ...leg, adapterId: 'zzz' }, quote: {}, transitions: [{ name: 't1' }], expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: { ...leg, legId: 'throws' }, quote: {} },
        { leg: { ...leg, legId: 'nostart' }, quote: {} },
        { leg: { ...leg, legId: 'noref' }, quote: {} },
        { leg, quote: {}, start: false },
      ],
      webhooks: [{ ...hook('x'), valid: false }, { ...hook('x'), events: 2 }],
    })
    const text = r.problems.map((p) => `${p.where}: ${p.problem}`)
    const expected = [
      'leg card: eta.min > eta.max',
      'main: fixture leg is for adapter zzz, not conf',
      'main quote: adapterId other is not conf',
      'main quote: legId x is not card',
      'main quote: eta.min > eta.max',
      'main quote.output: negative amount',
      'main start: step bogus: unknown leg status bogus',
      'main start: state PROCESSING, expected PAYMENT',
      'main transition t1: threw transition boom',
      'main status: state PAYMENT, expected COMPLETED',
      'throws: adapter declares no leg throws',
      'throws quote: threw NO_QUOTES: No provider can serve this amount right now. Try another method or amount.',
      'nostart: adapter declares no leg nostart',
      'nostart start: threw start boom',
      'noref: adapter declares no leg noref',
      'noref start: step has no ref, so webhooks and status checks cannot find it',
      'noref start: the first requires_action step has no surface',
      'webhook 0: verify() returned true, expected false',
      'webhook 1: parse() is not idempotent: a replay gave other events',
      'webhook 1: parse() gave 1 events, expected 2',
      'webhook 1: event without ref',
      'webhook 1: unknown leg status s0',
    ]
    for (const e of expected) expect(text).toContain(e)
  })

  it('reports missing transition(), status() and webhook handlers', async () => {
    const bare = createAdapter({
      id: 'conf',
      name: 'Conf',
      legs: [spec()],
      quote: async () => quote(),
      start: async () => ({ status: 'requires_action', action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'https://p.test', popup: true }, transitions: [] }, ref: 'r' }),
    })
    const r = await runAdapterConformance(bare, {
      fixtures: [{ leg, quote: {}, transitions: [{ name: 'a' }, { name: 'b' }], status: true, ctx: makeCtx({ fetch: fakeFetch([]).fetch }) }],
      webhooks: [hook('ok'), hook('ok')],
    })
    expect(r.problems).toEqual([
      { where: 'card transition a', problem: 'adapter has no transition()' },
      { where: 'card status', problem: 'adapter has no status()' },
      { where: 'webhook 0', problem: 'adapter has no webhook handler' },
    ])
    const thrower = { ...good(), webhook: { verify: async () => { throw new Error('verify boom') }, parse: async () => [] } }
    const r2 = await runAdapterConformance(thrower, { webhooks: [hook('ok')], ctx: () => makeCtx({ fetch: fakeFetch([]).fetch }) })
    expect(r2.problems).toEqual([{ where: 'webhook 0', problem: 'threw verify boom' }])
    const statusThrows = { ...good(), status: async () => { throw 'plain' } }
    const r3 = await runAdapterConformance(statusThrows as Adapter, { fixtures: [{ leg, quote: {} }] })
    expect(r3.problems).toEqual([{ where: 'card status', problem: 'threw plain' }])
  })
})
