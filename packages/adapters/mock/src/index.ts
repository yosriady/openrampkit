// Mock provider adapter for local development, demos and tests.
// It moves no money. It exercises every surface: hosted redirect checkout, QR, deposit address and wallet tx.

import { POLL as POLLS, awaitPoll, createAdapter } from '@openrampkit/adapter'
import type { AdapterContext, LegEvent } from '@openrampkit/adapter'
import { CHAINS, OrkException, USDC, bps, chainName, evmChainId, fromScaled, minorUnits, mulRatio, orkError, roundTo, sub, toBaseUnits, toScaled } from '@openrampkit/core'
import type { Amount, CryptoAsset, FieldSpec, LegQuote, LegSpec, LegStep, PollSpec, TxRequest } from '@openrampkit/core'

export type MockOptions = {
  /** How long a mock payment or bridge takes to settle (ms). Default 3000. */
  settleMs?: number
  /** Add mock `wallet` and `transfer` legs (use when the real Relay adapter is not configured) */
  crypto?: boolean
  /** Add a mock `bridge` leg for two-leg pathways (use when the real Relay adapter is not configured) */
  bridge?: boolean
  /**
   * Add a mock `offramp` leg (crypto_offramp) for withdraw to cash: USDC in, fiat out to the user's
   * bank or e-wallet (bank_transfer, gcash, momo, promptpay). It asks for the payout account (FORM),
   * then for a USDC transfer to a mock provider address (WALLET_TX), then settles after `settleMs`.
   */
  offramp?: boolean
  /** Name shown to users. Default "Test provider". */
  name?: string
}

/** Payout methods of the mock offramp leg */
export const MOCK_PAYOUT_METHODS = ['bank_transfer', 'gcash', 'momo', 'promptpay']

/** Rough FX to USD for quotes. Test data only. */
const USD_PER_UNIT: Record<string, string> = {
  USD: '1', EUR: '1.08', GBP: '1.27', SGD: '0.74', MYR: '0.22', THB: '0.029', PHP: '0.0175', IDR: '0.000062',
  VND: '0.0000395', INR: '0.012', BRL: '0.18', AUD: '0.66', CAD: '0.73', JPY: '0.0067', KRW: '0.00073',
}

/** Best-effort symbol for a token when the caller did not give one (test data only). */
function symbolOf(a: { chain: string; token: string; symbol?: string }): string {
  if (a.symbol) return a.symbol
  const t = a.token.toLowerCase()
  if (t === 'native' || t === '0x0000000000000000000000000000000000000000' || t === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return CHAINS[a.chain]?.nativeSymbol ?? 'ETH'
  return USDC[a.chain] === t ? 'USDC' : 'TOKEN'
}

const POLL: PollSpec = POLLS.dev
const ORDER_TTL_SEC = 24 * 60 * 60
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }
const usdcChains = Object.fromEntries(Object.entries(USDC).map(([c, t]) => [c, [t]]))

type MockOrder = {
  status: 'awaiting' | 'paid' | 'failed'
  paidAt?: number
  output: Amount
  kind: string
  /** Offramp: the payout method, the amount to send and where, and a masked payout account once given */
  method?: string
  input?: Amount
  payTo?: string
  account?: string
}

const WORK = 18
/** Exact decimal division, `a / b` (test data only) */
function div(a: string, b: string): string {
  return fromScaled((toScaled(a, WORK) * 10n ** BigInt(WORK)) / toScaled(b, WORK), WORK)
}

/** ERC-20 `transfer(to, amount)` calldata */
function erc20Transfer(to: string, amountBase: string): string {
  return `0xa9059cbb${to.toLowerCase().replace(/^0x/, '').padStart(64, '0')}${BigInt(amountBase).toString(16).padStart(64, '0')}`
}

/** Payout account fields per method. Labels are the provider's own (English). */
function payoutFields(method: string | undefined): FieldSpec[] {
  const name: FieldSpec = { id: 'account_name', label: 'Account holder name', type: 'text', required: true }
  if (!method || method === 'bank_transfer') {
    return [name, { id: 'bank_name', label: 'Bank name', type: 'text', required: true }, { id: 'account_number', label: 'Account number', type: 'text', required: true }]
  }
  if (method === 'promptpay') return [name, { id: 'phone', label: 'PromptPay phone number or ID', type: 'tel', required: true }]
  return [name, { id: 'phone', label: `${method === 'gcash' ? 'GCash' : method === 'momo' ? 'MoMo' : 'E-wallet'} phone number`, type: 'tel', required: true }]
}

const mask = (v: string) => (v.length <= 4 ? v : `${'*'.repeat(Math.min(6, v.length - 4))}${v.slice(-4)}`)

export function mockAdapter(opts: MockOptions = {}) {
  const settleMs = opts.settleMs ?? 3000
  const name = opts.name ?? 'Test provider'

  const legs: LegSpec[] = [
    {
      id: 'card',
      kind: 'fiat_onramp',
      methods: ['card', 'apple_pay', 'google_pay'],
      from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [BASE_USDC.token] } }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      limits: { min: '10', max: '20000', currency: 'USD' },
      eta: { min: 60, max: 300 },
      surfaces: ['REDIRECT'],
      requires: ['provider_kyc'],
    },
    {
      id: 'local',
      kind: 'fiat_onramp',
      methods: ['vietqr', 'momo', 'qris', 'gopay', 'dana', 'gcash', 'qrph', 'promptpay', 'duitnow', 'touchngo', 'paynow', 'bank_transfer'],
      from: { asset: { kind: 'fiat', currencies: ['VND', 'IDR', 'PHP', 'THB', 'MYR', 'SGD'] }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [BASE_USDC.token] } }, location: ['address'] },
      regions: { allow: ['VN', 'ID', 'PH', 'TH', 'MY', 'SG'], deny: [] },
      limits: { min: '5', max: '3000', currency: 'USD' },
      eta: { min: 10, max: 120 },
      surfaces: ['QR'],
      requires: ['provider_kyc'],
    },
    {
      id: 'payin',
      kind: 'fiat_payin',
      methods: ['qris', 'promptpay', 'vietqr', 'qrph', 'duitnow', 'paynow', 'card'],
      from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
      to: { asset: { kind: 'fiat', currencies: '*' }, location: ['merchant_account'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 5, max: 60 },
      surfaces: ['QR'],
    },
  ]
  if (opts.crypto) {
    legs.push(
      {
        id: 'wallet',
        kind: 'bridge_swap',
        methods: ['wallet'],
        from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
        to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
        regions: { allow: ['*'], deny: [] },
        eta: { min: 5, max: 30 },
        surfaces: ['WALLET_TX'],
        requires: ['wallet'],
      },
      {
        id: 'transfer',
        kind: 'bridge_swap',
        methods: ['transfer'],
        from: { asset: { kind: 'crypto', chains: '*' }, location: ['user_wallet'] },
        to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
        regions: { allow: ['*'], deny: [] },
        eta: { min: 10, max: 60 },
        surfaces: ['DEPOSIT_ADDRESS'],
      },
    )
  }
  if (opts.bridge) {
    legs.push({
      id: 'bridge',
      kind: 'bridge_swap',
      from: { asset: { kind: 'crypto', chains: usdcChains }, location: ['address'] },
      to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] },
      regions: { allow: ['*'], deny: [] },
      eta: { min: 5, max: 30 },
      surfaces: ['DEPOSIT_ADDRESS'],
    })
  }
  if (opts.offramp) {
    legs.push({
      id: 'offramp',
      kind: 'crypto_offramp',
      methods: MOCK_PAYOUT_METHODS,
      from: { asset: { kind: 'crypto', chains: usdcChains }, location: ['user_wallet', 'address'] },
      to: { asset: { kind: 'fiat', currencies: Object.keys(USD_PER_UNIT) }, location: ['user_account'] },
      regions: { allow: ['*'], deny: [] },
      limits: { min: '5', max: '5000', currency: 'USD' },
      eta: { min: 60, max: 900 },
      surfaces: ['FORM', 'WALLET_TX'],
    })
  }

  const baseOf = (ctx: AdapterContext) => ctx.urls.webhookUrl.replace(/\/webhooks\/mock$/, '')
  const orderKey = (ref: string) => `order:${ref}`

  function fakeAddress(seed: string): string {
    let h = 0n
    for (const c of seed) h = (h * 131n + BigInt(c.charCodeAt(0))) % (1n << 160n)
    return `0x${h.toString(16).padStart(40, '0')}`
  }

  function destAsset(ctx: AdapterContext): CryptoAsset {
    const d = ctx.destination
    if (d.type !== 'crypto') return BASE_USDC
    return { kind: 'crypto', chain: d.chain, token: d.token, symbol: d.symbol ?? 'USDC', decimals: d.decimals ?? 6 }
  }

  async function settled(ref: string, ctx: Pick<AdapterContext, 'shared'>): Promise<LegStep | undefined> {
    const o = await ctx.shared.get<MockOrder>(orderKey(ref))
    if (!o) return undefined
    if (o.status === 'failed') return { state: 'FAILED', status: 'failed', transitions: [], error: orkError('PAYMENT_FAILED'), ref }
    if (o.status === 'paid' && o.paidAt && Date.now() - o.paidAt >= settleMs) {
      return { state: 'COMPLETED', status: 'succeeded', transitions: [], output: o.output, ref, txHash: `0x${ref.replace(/[^0-9a-f]/g, '').padEnd(64, '0').slice(0, 64)}` }
    }
    if (o.status === 'paid') return { state: 'PROCESSING', sub: 'SETTLING', status: 'processing', transitions: [awaitPoll(POLL)], ref }
    return undefined
  }

  /** The offramp's user step: the payout account form, then the USDC transfer to the provider. */
  function offrampStep(ref: string, o: MockOrder): LegStep {
    if (!o.account) {
      return {
        state: 'PAYMENT', sub: 'PAYOUT_ACCOUNT', status: 'awaiting_user', ref,
        surface: { kind: 'FORM', fields: payoutFields(o.method) },
        transitions: [{ name: 'submit_details', kind: 'SUBMIT', label: 'Continue' }],
      }
    }
    const input = o.input ?? { amount: '0', asset: BASE_USDC }
    const asset = input.asset.kind === 'crypto' ? input.asset : BASE_USDC
    const tx: TxRequest = { to: asset.token, data: erc20Transfer(o.payTo ?? fakeAddress(ref), toBaseUnits(input.amount, asset.decimals ?? 6)), value: '0', chainId: evmChainId(asset.chain) ?? 8453 }
    return {
      state: 'PAYMENT', sub: 'SEND_CRYPTO', status: 'awaiting_user', ref,
      surface: { kind: 'WALLET_TX', chain: asset.chain, txs: [tx] },
      transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
    }
  }

  return createAdapter({
    id: 'mock',
    name,
    legs,

    async quote({ leg, amountIn, amountOut }, ctx): Promise<LegQuote> {
      const spec = legs.find((l) => l.id === leg.legId)
      if (!spec) throw unknownLeg(leg.legId)
      const now = Date.now()
      const expiresAt = new Date(now + 60_000).toISOString()
      if (spec.kind === 'crypto_offramp') {
        // USDC in, fiat out: 1 USDC = 1 USD, minus 1%.
        const fiat = (leg.to.asset.kind === 'fiat' ? leg.to.asset.currency : ctx.destination.type === 'fiat' ? ctx.destination.currency : 'USD').toUpperCase()
        const rate = USD_PER_UNIT[fiat]
        if (!rate) throw new OrkException(orkError('NO_QUOTES', { message: `${name} has no rate for ${fiat}.` }), 422)
        const inAsset: CryptoAsset = amountIn?.asset.kind === 'crypto' ? amountIn.asset : leg.from.asset.kind === 'crypto' ? leg.from.asset : BASE_USDC
        const usdc = amountIn ? amountIn.amount : roundTo(div(mulRatio(amountOut?.amount ?? '0', rate), '0.99'), 6)
        const fee = roundTo(bps(usdc, 100), 6)
        const out = roundTo(div(sub(usdc, fee), rate), minorUnits(fiat))
        return {
          adapterId: 'mock', legId: leg.legId,
          input: { amount: usdc, asset: { ...inAsset, symbol: 'USDC', decimals: 6 } },
          output: { amount: out.startsWith('-') ? '0' : out, asset: { kind: 'fiat', currency: fiat } },
          fees: [{ kind: 'provider', label: `${name} fee`, amount: fee, currency: 'USDC' }],
          eta: spec.eta, expiresAt,
        }
      }
      if (spec.kind === 'fiat_onramp' || spec.kind === 'fiat_payin') {
        const fiat = (amountIn?.asset.kind === 'fiat' ? amountIn.asset.currency : leg.from.asset.kind === 'fiat' ? leg.from.asset.currency : 'USD').toUpperCase()
        const rate = USD_PER_UNIT[fiat]
        if (!rate) throw new OrkException(orkError('NO_QUOTES', { message: `${name} has no rate for ${fiat}.` }), 422)
        const input = amountIn?.amount ?? '0'
        const feePct = spec.id === 'card' ? 250 : 100 // bps
        if (spec.kind === 'fiat_payin') {
          const fee = roundTo(bps(input, 70), minorUnits(fiat))
          return {
            adapterId: 'mock', legId: leg.legId,
            input: { amount: input, asset: { kind: 'fiat', currency: fiat } },
            output: { amount: roundTo(sub(input, fee), minorUnits(fiat)), asset: { kind: 'fiat', currency: fiat } },
            fees: [{ kind: 'provider', label: `${name} fee`, amount: fee, currency: fiat }],
            eta: spec.eta, expiresAt,
          }
        }
        const usd = mulRatio(input, rate)
        const fee = bps(usd, feePct)
        const out = roundTo(sub(usd, fee), 6)
        return {
          adapterId: 'mock', legId: leg.legId,
          input: { amount: input, asset: { kind: 'fiat', currency: fiat } },
          output: { amount: out.startsWith('-') ? '0' : out, asset: leg.to.asset.kind === 'crypto' ? { ...BASE_USDC, ...leg.to.asset, symbol: 'USDC', decimals: 6 } : BASE_USDC },
          fees: [{ kind: 'provider', label: `${name} fee`, amount: roundTo(mulRatio(fee, String(1 / Number(rate))), minorUnits(fiat)), currency: fiat }],
          eta: spec.eta, expiresAt,
        }
      }
      // crypto legs: 1:1 minus 5 bps
      const input = amountIn?.amount ?? amountOut?.amount ?? '0'
      const fee = bps(input, 5)
      const inAsset = amountIn?.asset.kind === 'crypto' ? amountIn.asset : BASE_USDC
      return {
        adapterId: 'mock', legId: leg.legId,
        input: { amount: input, asset: { ...inAsset, symbol: symbolOf(inAsset), decimals: inAsset.decimals ?? (symbolOf(inAsset) === 'USDC' ? 6 : 18) } },
        output: { amount: roundTo(sub(input, fee), 6), asset: destAsset(ctx) },
        fees: [{ kind: 'network', label: 'Network and bridge', amount: roundTo(fee, 6), currency: 'USDC' }],
        eta: spec.eta, expiresAt,
        ...(leg.legId === 'transfer' ? { data: { anyAmount: true } } : {}),
      }
    },

    async prepareDeposit({ leg }, ctx) {
      return { address: fakeAddress(`${ctx.session.id}:${leg.legId}:deposit`) }
    },

    async start({ leg, quote, deliverTo }, ctx): Promise<LegStep> {
      const ref = `mock_${ctx.session.id.slice(4, 14)}_${leg.legId}_${Date.now().toString(36)}`
      const order: MockOrder = { status: 'awaiting', output: quote.output, kind: leg.legId }
      await ctx.shared.put(orderKey(ref), order, ORDER_TTL_SEC)
      const base = baseOf(ctx)
      switch (leg.legId) {
        case 'card':
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'REDIRECT', url: `${base}/adapters/mock/checkout?ref=${encodeURIComponent(ref)}&amount=${quote.input.amount}&currency=${quote.input.asset.kind === 'fiat' ? quote.input.asset.currency : ''}&to=${encodeURIComponent(deliverTo?.address ?? '')}`, popup: true, provider: name },
            transitions: [awaitPoll(POLL)],
          }
        case 'local':
        case 'payin': {
          const cur = quote.input.asset.kind === 'fiat' ? quote.input.asset.currency : 'USD'
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'QR', payload: `MOCKQR|${ref}|${quote.input.amount}|${cur}`, amount: quote.input.amount, currency: cur, reference: ref.slice(-10).toUpperCase(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
            transitions: [
              { name: 'simulate_payment', kind: 'SUBMIT', label: 'Simulate payment (test mode)' },
              awaitPoll(POLL),
            ],
          }
        }
        case 'wallet': {
          const d = destAsset(ctx)
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'WALLET_TX', chain: quote.input.asset.kind === 'crypto' ? quote.input.asset.chain : d.chain, txs: [{ to: deliverTo?.address ?? fakeAddress(ref), data: '0x', value: '0', chainId: Number((quote.input.asset.kind === 'crypto' ? quote.input.asset.chain : d.chain).split(':')[1]) }] },
            transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }],
          }
        }
        case 'transfer': {
          const src = quote.input.asset.kind === 'crypto' ? quote.input.asset : BASE_USDC
          const address = fakeAddress(`${ctx.session.userId}:${src.chain}:${src.token}`)
          return {
            state: 'PAYMENT', status: 'awaiting_user', ref,
            surface: { kind: 'DEPOSIT_ADDRESS', chain: src.chain, chainName: chainName(src.chain), token: src.token, symbol: symbolOf(src), address, min: '1', warning: `Send only ${symbolOf(src)} on ${chainName(src.chain)}. This is a test address.` },
            transitions: [
              { name: 'simulate_deposit', kind: 'SUBMIT', label: 'Simulate deposit (test mode)' },
              awaitPoll(POLL),
            ],
          }
        }
        case 'offramp': {
          const offer: MockOrder = { ...order, ...(leg.method ? { method: leg.method } : {}), input: quote.input, payTo: fakeAddress(`offramp:${ref}`) }
          await ctx.shared.put(orderKey(ref), offer, ORDER_TTL_SEC)
          return offrampStep(ref, offer)
        }
        case 'bridge': {
          // The previous leg delivers into the deposit address; treat it as paid now.
          await ctx.shared.put(orderKey(ref), { ...order, status: 'paid', paidAt: Date.now() }, ORDER_TTL_SEC)
          return { state: 'PROCESSING', sub: 'BRIDGING', status: 'processing', ref, transitions: [awaitPoll(POLL)] }
        }
      }
      throw unknownLeg(leg.legId)
    },

    async transition({ ref, name: t, inputs }, ctx): Promise<LegStep> {
      const o = await ctx.shared.get<MockOrder>(orderKey(ref))
      if (!o) throw new OrkException(orkError('NOT_FOUND', { message: 'Unknown mock order.' }), 404)
      if (o.kind === 'offramp' && t === 'submit_details') {
        if (o.status !== 'awaiting') throw new OrkException(orkError('BAD_REQUEST', { message: 'The payout account is already set.' }), 409)
        const v = (id: string) => (typeof inputs?.[id] === 'string' ? (inputs[id] as string).trim() : '')
        for (const f of payoutFields(o.method)) {
          if (!v(f.id)) throw new OrkException(orkError('BAD_REQUEST', { message: `Enter the ${f.label.toLowerCase()}.` }), 400)
        }
        const acct = v('account_number') || v('phone')
        if (v('phone') && !/^\+?[0-9 ()-]{7,20}$/.test(v('phone'))) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid phone number.' }), 400)
        if (v('account_number') && !/^[0-9A-Za-z -]{4,34}$/.test(v('account_number'))) throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter a valid account number.' }), 400)
        const next: MockOrder = { ...o, account: mask(acct.replace(/\D/g, '') || acct) }
        await ctx.shared.put(orderKey(ref), next, ORDER_TTL_SEC)
        return offrampStep(ref, next)
      }
      if (o.kind === 'offramp' && t === 'submit_tx' && !o.account) {
        throw new OrkException(orkError('BAD_REQUEST', { message: 'Enter the payout account first.' }), 409)
      }
      if (t === 'simulate_payment' || t === 'simulate_deposit' || t === 'submit_tx') {
        await ctx.shared.put(orderKey(ref), { ...o, status: 'paid', paidAt: Date.now() }, ORDER_TTL_SEC)
        return {
          state: 'PROCESSING', sub: 'SETTLING', status: 'processing', ref,
          transitions: [awaitPoll(POLL)],
          ...(typeof inputs?.txHash === 'string' ? { txHash: inputs.txHash } : {}),
        }
      }
      throw new OrkException(orkError('BAD_REQUEST', { message: `Transition ${t} is not supported.` }), 409)
    },

    async status({ ref }, ctx): Promise<LegStep> {
      const done = await settled(ref, ctx)
      if (done) return done
      const o = await ctx.shared.get<MockOrder>(orderKey(ref))
      if (o?.kind === 'offramp') return offrampStep(ref, o)
      return { state: 'PAYMENT', status: 'awaiting_user', ref, transitions: [awaitPoll(POLL)] }
    },

    async routes(req, subpath, ctx) {
      const url = new URL(req.url)
      const ref = url.searchParams.get('ref') ?? ''
      if (subpath === 'checkout' && req.method === 'GET') {
        const amount = escapeHtml(url.searchParams.get('amount') ?? '')
        const currency = escapeHtml(url.searchParams.get('currency') ?? '')
        return new Response(checkoutPage(name, amount, currency, escapeHtml(ref), `${ctx.baseUrl}/adapters/mock/pay`), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (subpath === 'pay' && req.method === 'POST') {
        const form = await req.formData()
        const r = String(form.get('ref') ?? '')
        const outcome = String(form.get('outcome') ?? 'success')
        const o = await ctx.shared.get<MockOrder>(orderKey(r))
        if (!o) return new Response('Unknown order', { status: 404 })
        if (outcome === 'fail') {
          await ctx.shared.put(orderKey(r), { ...o, status: 'failed' }, ORDER_TTL_SEC)
          await ctx.applyEvent({ ref: r, status: 'failed', error: orkError('PAYMENT_FAILED') } satisfies LegEvent)
        } else {
          await ctx.shared.put(orderKey(r), { ...o, status: 'paid', paidAt: Date.now() }, ORDER_TTL_SEC)
          await ctx.applyEvent({ ref: r, status: 'processing' })
        }
        return new Response(donePage(outcome !== 'fail'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      return undefined
    },
  })
}

function unknownLeg(legId: string) {
  return new OrkException(orkError('NOT_FOUND', { message: `Unknown mock leg ${legId}` }), 404)
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function checkoutPage(name: string, amount: string, currency: string, ref: string, action: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} checkout</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border-radius:16px;padding:28px;width:min(360px,90vw);box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 4px}.muted{color:#667;font-size:13px}.amt{font-size:32px;font-weight:700;margin:18px 0}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccd;border-radius:8px;margin:4px 0 10px;font-size:15px}
button{width:100%;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-top:6px}
.pay{background:#2744c4;color:#fff}.fail{background:#eee;color:#333}.badge{display:inline-block;background:#fff4d6;color:#8a5a00;font-size:12px;padding:2px 8px;border-radius:99px}</style></head>
<body><div class="card"><span class="badge">Test mode</span><h1>${name}</h1><div class="muted">Mock card checkout. No money moves.</div>
<div class="amt">${amount} ${currency}</div>
<label class="muted">Card number<input value="4242 4242 4242 4242" readonly></label>
<form method="post" action="${action}"><input type="hidden" name="ref" value="${ref}"><input type="hidden" name="outcome" value="success"><button class="pay" type="submit">Pay ${amount} ${currency}</button></form>
<form method="post" action="${action}"><input type="hidden" name="ref" value="${ref}"><input type="hidden" name="outcome" value="fail"><button class="fail" type="submit">Decline payment</button></form>
</div></body></html>`
}

function donePage(ok: boolean) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${ok ? 'Payment received' : 'Payment declined'}</h2><p>You can close this tab and go back to the app.</p><script>setTimeout(()=>window.close(),1200)</script>`
}
