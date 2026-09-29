// A tiny in-browser fake of the OpenRampKit server, so the modal can be tried without a backend.
// It answers the same routes as @openrampkit/server and walks a scripted flow per method.

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const DEST = { type: 'crypto', chain: 'eip155:143', token: '0x754704bc059f8c67012fed69bc8a327a5aafb603', address: '0x2222222222222222222222222222222222222222', symbol: 'USDC', decimals: 6 }
const AWAIT = { name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1200, backoff: 1, maxIntervalMs: 1200, giveUpAfterMs: 120000 } }

export function createMockFetch({ country = 'US' } = {}) {
  const currency = { US: 'USD', PH: 'PHP', VN: 'VND', ID: 'IDR', TH: 'THB' }[country] ?? 'USD'
  let step = { sessionId: 'ses_demo', state: 'SELECT_METHOD', transitions: [] }
  let selected
  let ticks = 0
  let lastAmount = '0'

  const session = () => ({
    id: 'ses_demo', direction: 'deposit', destination: DEST, status: 'open', country, currency,
    step, expiresAt: new Date(Date.now() + 3600e3).toISOString(), livemode: false,
  })
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const usdc = (amount) => ({ amount, asset: { kind: 'crypto', chain: DEST.chain, token: DEST.token, symbol: 'USDC', decimals: 6 } })
  const fiat = (amount) => ({ amount, asset: { kind: 'fiat', currency } })
  const rate = { USD: 1, PHP: 58, VND: 25400, IDR: 16200, THB: 36 }[currency] ?? 1

  const method = (m, name, kind, group, providers, eta, extra = {}) => ({ method: m, name, kind, group, providers, pathwayIds: [`pw_${m}`], eta, ...extra })
  const plan = (walletConnected) => {
    const local = { PH: ['qrph', 'QR Ph', 'gcash', 'GCash'], VN: ['vietqr', 'VietQR', 'momo', 'MoMo'], ID: ['qris', 'QRIS', 'gopay', 'GoPay'], TH: ['promptpay', 'PromptPay', null, null] }[country]
    const methods = [
      method('wallet', 'Pay with wallet', 'crypto', walletConnected ? 'connected' : 'unavailable', ['Relay'], { min: 5, max: 30 },
        walletConnected ? {} : { reason: { code: 'BAD_REQUEST', message: 'Connect a wallet to use this method.', retryable: false } }),
      method('transfer', 'Transfer crypto', 'crypto', walletConnected ? 'more' : 'recommended', ['Relay'], { min: 30, max: 300 }),
      method('exchange', 'Connect exchange', 'exchange', 'unavailable', [], { min: 60, max: 600 }, { reason: { code: 'REGION_UNSUPPORTED', message: 'This method is not available in your region.', retryable: false } }),
    ]
    if (local) {
      methods.push(method(local[0], local[1], 'qr', 'recommended', ['Swapped'], { min: 30, max: 300 }, { limits: { max: String(3000 * rate), currency } }))
      if (local[2]) methods.push(method(local[2], local[3], 'ewallet', 'recommended', ['Swapped'], { min: 60, max: 600 }))
    }
    methods.push(
      method('card', 'Card', 'card', local ? 'more' : 'recommended', ['Transak', 'Coinbase'], { min: 60, max: 300 }, { limits: { min: '20', max: '3000', currency: 'USD' } }),
      method('apple_pay', 'Apple Pay', 'wallet_pay', local ? 'more' : 'recommended', ['Coinbase'], { min: 30, max: 60 }, { limits: { max: '500', currency: 'USD' } }),
      method('bank_transfer', 'Bank transfer', 'bank', 'more', ['Transak'], { min: 86400, max: 172800 }, { limits: { max: '25000', currency: 'USD' } }),
      method('sepa', 'SEPA', 'bank', 'unavailable', [], { min: 86400, max: 172800 }, { reason: { code: 'REGION_UNSUPPORTED', message: 'This method is not available in your region.', retryable: false } }),
    )
    return { pathways: [], methods, currency }
  }

  const quotes = (body) => {
    const m = body.method
    const amt = Number(body.amount) || 0
    if (m === 'transfer') {
      const sym = body.source?.token === 'native' ? 'ETH' : 'USDC'
      return { quotes: [{ id: 'q_transfer', pathwayId: 'pw_transfer', method: m, provider: 'Relay', legs: [], input: { amount: '0', asset: { kind: 'crypto', chain: body.source?.chain, token: body.source?.token, symbol: sym } }, output: usdc('0'), fees: [{ kind: 'network', label: 'Network', amount: '0.02', currency: 'USD' }], eta: { min: 20, max: 60 }, badges: ['fastest'] }], errors: [] }
    }
    if (m !== 'wallet' && amt < 20 * rate) return { quotes: [], errors: [{ code: 'AMOUNT_TOO_LOW', message: 'The amount is below the minimum for this method.', retryable: false }] }
    const usd = m === 'wallet' ? amt : amt / rate
    const mk = (id, provider, feePct, eta, badges) => ({
      id, pathwayId: `pw_${m}`, method: m, provider, legs: [],
      input: m === 'wallet' ? { amount: String(amt), asset: { kind: 'crypto', chain: body.source?.chain, token: body.source?.token, symbol: 'USDC' } } : fiat(String(amt)),
      output: usdc((usd * (1 - feePct)).toFixed(2)),
      fees: [{ kind: 'provider', label: 'Provider fee', amount: (usd * feePct * rate).toFixed(2), currency: m === 'wallet' ? 'USD' : currency }],
      eta, expiresAt: new Date(Date.now() + 60e3).toISOString(), badges,
    })
    if (m === 'wallet') return { quotes: [mk('q_relay', 'Relay', 0.001, { min: 5, max: 30 }, ['best_price', 'fastest'])], errors: [] }
    if (m === 'card') return { quotes: [mk('q_transak', 'Transak', 0.021, { min: 120, max: 300 }, ['best_price']), mk('q_coinbase', 'Coinbase', 0.025, { min: 60, max: 120 }, ['fastest'])], errors: [] }
    return { quotes: [mk(`q_${m}`, m === 'apple_pay' ? 'Coinbase' : m === 'bank_transfer' ? 'Transak' : 'Swapped', 0.015, { min: 60, max: 300 }, ['best_price', 'fastest'])], errors: [{ code: 'PROVIDER_UNAVAILABLE', message: 'One provider is not available right now.', retryable: true }] }
  }

  const devButtons = [
    { name: 'simulate_paid', kind: 'SUBMIT', label: 'Simulate payment (dev)' },
    { name: 'simulate_fail', kind: 'SUBMIT', label: 'Simulate failure (dev)' },
  ]
  const progress = (a, b) => ({ legs: [{ adapterId: 'swapped', legId: 'onramp', status: a }, { adapterId: 'relay', legId: 'bridge', status: b }] })

  const startStep = (q) => {
    const base = { sessionId: 'ses_demo', legIndex: 0 }
    switch (q.method) {
      case 'card':
        return { ...base, state: 'PAYMENT', surface: { kind: 'REDIRECT', url: 'https://example.com/checkout', popup: true, provider: q.provider }, transitions: [AWAIT, { name: 'completed', kind: 'SURFACE_RESULT', expects: 'completed' }, ...devButtons], progress: progress('awaiting_user', 'pending') }
      case 'apple_pay':
        return { ...base, state: 'PAYMENT', surface: { kind: 'IFRAME', url: 'https://example.com/', origin: 'https://example.com', height: 420, provider: 'Coinbase' }, transitions: [AWAIT, ...devButtons] }
      case 'wallet':
        return { ...base, state: 'PAYMENT', surface: { kind: 'WALLET_TX', chain: 'eip155:42161', txs: [{ to: USDC_BASE, data: '0x', chainId: 42161 }, { to: USDC_BASE, data: '0x', chainId: 42161 }] }, transitions: [{ name: 'tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }] }
      case 'transfer':
        return { ...base, state: 'PAYMENT', surface: { kind: 'DEPOSIT_ADDRESS', chain: 'eip155:8453', symbol: 'USDC', token: USDC_BASE, address: '0x9f3c1a2b7d4e5f60718293a4b5c6d7e8f9012345', min: '1' }, transitions: [AWAIT, ...devButtons] }
      case 'bank_transfer':
        return { ...base, state: 'PAYMENT', surface: { kind: 'BANK_FIELDS', fields: [{ label: 'Bank', value: 'Demo Bank N.A.', copy: false }, { label: 'Account number', value: '0123456789', copy: true }, { label: 'Routing number', value: '021000021', copy: true }, { label: 'Reference', value: 'ORK-7F3A', copy: true }] }, transitions: [AWAIT, { name: 'simulate_paid', kind: 'SUBMIT', label: 'I have sent the transfer' }] }
      case 'gcash': case 'momo': case 'gopay':
        return { ...base, state: 'AUTH', surface: { kind: 'OTP', channel: 'sms', to: '+63 917 *** 1234' }, transitions: [{ name: 'verify', kind: 'SUBMIT', label: 'Verify', inputs: [{ id: 'code', label: 'Code', type: 'text', required: true }] }] }
      default:
        return { ...base, state: 'PAYMENT', surface: { kind: 'QR', payload: '00020101021228580011ph.ppmi.p2m0111DEMOPHM2XXX0315777148000000000520460165303608540' + q.input.amount + '5802PH5913OPENRAMP DEMO6006MANILA6304ABCD', amount: q.input.amount, currency, reference: 'ORK-DEMO-42', method: q.method, expiresAt: new Date(Date.now() + 15 * 60e3).toISOString() }, transitions: [AWAIT, ...devButtons], progress: progress('awaiting_user', 'pending') }
    }
  }

  const processing = () => {
    ticks = 0
    return { sessionId: 'ses_demo', state: 'PROCESSING', transitions: [AWAIT], progress: progress('processing', 'pending') }
  }

  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href)
    const path = url.pathname.replace(/^.*\/sessions\/[^/]+/, '')
    const body = init.body ? JSON.parse(init.body) : {}
    await new Promise((r) => setTimeout(r, 350))
    if (path === '') return json(session())
    if (path === '/plan') return json(plan(body.walletConnected))
    if (path === '/quotes') {
      lastAmount = body.amount
      return json(quotes(body))
    }
    if (path === '/select') {
      // Recover the method from the quote id made in quotes()
      const map = { q_transak: ['card', 'Transak'], q_coinbase: ['card', 'Coinbase'], q_relay: ['wallet', 'Relay'], q_transfer: ['transfer', 'Relay'] }
      const [m, provider] = map[body.quoteId] ?? [body.quoteId.slice(2), 'Swapped']
      selected = { method: m, provider, input: { amount: lastAmount } }
      step = startStep(selected)
      return json(session())
    }
    if (path.startsWith('/transitions/')) {
      const name = decodeURIComponent(path.slice('/transitions/'.length))
      if (name === 'restart') step = { sessionId: 'ses_demo', state: 'SELECT_METHOD', transitions: [] }
      else if (name === 'simulate_fail') step = { sessionId: 'ses_demo', state: 'FAILED', transitions: [], error: { code: 'PAYMENT_FAILED', message: 'The payment did not go through. You can try again.', retryable: true } }
      else if (name === 'verify') {
        if (String(body.inputs?.code ?? '') !== '123456') {
          step = { ...step, error: { code: 'BAD_REQUEST', message: 'That code is not right. Use 123456 in this demo.', retryable: true } }
        } else step = { ...startStep({ method: 'qrph', input: { amount: lastAmount } }), legIndex: 0 }
      } else step = processing()
      return json(session())
    }
    if (path === '/step') {
      if (step.state === 'PROCESSING') {
        ticks++
        if (ticks === 2) step = { ...step, progress: progress('succeeded', 'processing') }
        if (ticks >= 4) step = { sessionId: 'ses_demo', state: 'COMPLETED', transitions: [], progress: progress('succeeded', 'succeeded') }
      }
      return json(session())
    }
    return json({ error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false } }, 404)
  }
}

