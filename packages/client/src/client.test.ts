import { describe, expect, it, vi } from 'vitest'
import { OpenRampException, openRampError } from '@openrampkit/core'
import { OpenRampClientError, createOpenRampClient, toOpenRampError } from './index.js'
import { BASE_DEST, setupServer } from './testctx.js'

type Call = { url: string; init: RequestInit }

function recorder(respond: (c: Call) => Response = () => Response.json({ ok: true })) {
  const calls: Call[] = []
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} }
    calls.push(c)
    return respond(c)
  }) as unknown as typeof fetch
  return { f, calls }
}

const headers = (c: Call) => c.init.headers as Record<string, string>

describe('createOpenRampClient request shapes', () => {
  const secret = 'ors_abc.sig'

  it('strips a trailing slash from baseUrl', () => {
    expect(createOpenRampClient({ baseUrl: 'https://x.test/api/' }).baseUrl).toBe('https://x.test/api')
  })

  it('GET session sends the bearer secret and no body or idempotency key', async () => {
    const { f, calls } = recorder()
    const client = createOpenRampClient({ baseUrl: '/api/openramp/', fetch: f })
    await client.getSession(secret)
    expect(calls[0]!.url).toBe('/api/openramp/sessions/ors_abc')
    expect(calls[0]!.init.method).toBe('GET')
    expect(headers(calls[0]!)).toEqual({ authorization: `Bearer ${secret}` })
    expect(calls[0]!.init.body).toBeUndefined()
  })

  it('step uses GET /step', async () => {
    const { f, calls } = recorder()
    await createOpenRampClient({ baseUrl: '/b', fetch: f }).step(secret)
    expect(calls[0]!.url).toBe('/b/sessions/ors_abc/step')
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('plan and quotes POST JSON without an idempotency key', async () => {
    const { f, calls } = recorder()
    const client = createOpenRampClient({ baseUrl: '/b', fetch: f })
    await client.plan(secret, { walletConnected: true, walletAddress: '0x1' })
    await client.quotes(secret, { method: 'card', amount: '10', amountSide: 'source' })
    expect(calls.map((c) => c.url)).toEqual(['/b/sessions/ors_abc/plan', '/b/sessions/ors_abc/quotes'])
    for (const c of calls) {
      expect(c.init.method).toBe('POST')
      expect(headers(c)['content-type']).toBe('application/json')
      expect(headers(c)['idempotency-key']).toBeUndefined()
    }
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ walletConnected: true, walletAddress: '0x1' })
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ method: 'card', amount: '10', amountSide: 'source' })
  })

  it('select and transition POST with a fresh idempotency key each time', async () => {
    const { f, calls } = recorder()
    const client = createOpenRampClient({ baseUrl: '/b', fetch: f })
    await client.select(secret, { quoteId: 'q1' })
    await client.select(secret, { quoteId: 'q1' })
    await client.transition(secret, 'simulate payment', { a: 1 })
    await client.transition(secret, 'restart')
    const keys = calls.map((c) => headers(c)['idempotency-key'])
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{24}$/)
    expect(new Set(keys).size).toBe(4)
    expect(calls[2]!.url).toBe('/b/sessions/ors_abc/transitions/simulate%20payment')
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ inputs: { a: 1 } })
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ inputs: {} })
  })

  it('returns {} for an empty OK body', async () => {
    const { f } = recorder(() => new Response('', { status: 200 }))
    expect(await createOpenRampClient({ baseUrl: '/b', fetch: f }).getSession(secret)).toEqual({})
  })

  it('throws OpenRampClientError with the server error and status', async () => {
    const err = openRampError('QUOTE_EXPIRED')
    const { f } = recorder(() => Response.json({ error: err }, { status: 409 }))
    const p = createOpenRampClient({ baseUrl: '/b', fetch: f }).select(secret, { quoteId: 'q' })
    await expect(p).rejects.toBeInstanceOf(OpenRampClientError)
    await expect(p).rejects.toMatchObject({ status: 409, error: err, message: err.message })
  })

  it('maps a non-JSON error page to an OpenRampError by status', async () => {
    const html = (status: number) => recorder(() => new Response('<html>Bad gateway</html>', { status })).f
    const get = (status: number) => createOpenRampClient({ baseUrl: '/b', fetch: html(status) }).getSession(secret)
    await expect(get(502)).rejects.toMatchObject({ status: 502, error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(get(401)).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED' } })
    await expect(get(404)).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } })
    await expect(get(429)).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await expect(get(400)).rejects.toMatchObject({ error: { code: 'INTERNAL' } })
  })

  it('rejects an OK response that is not JSON', async () => {
    const { f } = recorder(() => new Response('not json', { status: 200 }))
    await expect(createOpenRampClient({ baseUrl: '/b', fetch: f }).getSession(secret)).rejects.toMatchObject({
      error: { code: 'INTERNAL' },
    })
  })

  it('uses the global fetch when none is given', async () => {
    const f = vi.fn(async () => Response.json({ id: 'x' }))
    vi.stubGlobal('fetch', f)
    try {
      expect(await createOpenRampClient({ baseUrl: '/b' }).getSession(secret)).toEqual({ id: 'x' })
      expect(f).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('talks to the real server handler', async () => {
    const { ramp, client, requests } = setupServer()
    const s = await ramp.sessions.create({ userId: 'u', country: 'US', destination: BASE_DEST })
    const pub = await client.getSession(s.clientSecret)
    expect(pub.step.state).toBe('SELECT_METHOD')
    expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${s.clientSecret}`)
    await expect(client.getSession(`${s.id}.wrong`)).rejects.toMatchObject({ status: 401 })
  })
})

describe('toOpenRampError', () => {
  it('maps every kind of thrown value', () => {
    const e = openRampError('NO_QUOTES')
    expect(toOpenRampError(new OpenRampClientError(e, 400))).toBe(e)
    expect(toOpenRampError(e)).toBe(e)
    expect(toOpenRampError(new OpenRampException(e))).toEqual(e)
    expect(toOpenRampError({ error: e })).toBe(e)
    expect(toOpenRampError(new Error('boom'))).toMatchObject({ code: 'INTERNAL', message: 'boom' })
    expect(toOpenRampError('str')).toMatchObject({ code: 'INTERNAL', message: 'str' })
    expect(toOpenRampError({ error: 'nope' })).toMatchObject({ code: 'INTERNAL' })
    expect(toOpenRampError(null)).toMatchObject({ code: 'INTERNAL', message: 'null' })
  })
})
