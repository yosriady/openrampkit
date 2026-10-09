// Binance adapter: the user pays from their Binance account, and Binance sends the crypto on chain to
// the destination address. Product: the Binance Pay Onchain on-ramp APIs (earlier name: Binance Connect).
// Docs: https://developers.binance.com/en/docs/products/connect-2.0/introduction (read 2026-10-05).
//
// - Quote: POST /papi/v1/ramp/connect/buy/estimated-quote
// - Start: POST /papi/v1/ramp/connect/buy/pre-order gives a Binance landing page `link` (REDIRECT).
//   We set `payMethodCode` to `BUY_WALLET` ("Spot Account": the fiat balance in the Binance account)
//   by default, so the user pays from their Binance balance. Binance withdraws the crypto to `address`.
// - Status: POST /papi/v1/ramp/connect/order with our `externalOrderId` (the leg ref).
// - Webhook: `connect_order_event`, signed SHA256withRSA(body + timestamp) by Binance
//   (headers X-BN-Connect-Signature, X-BN-Connect-Timestamp, X-BN-Connect-For).
// - Request signing: X-Tesla-Signature = base64(SHA256withRSA(jsonBody + timestamp)) with the
//   partner private key, plus X-Tesla-ClientId, X-Tesla-SignAccessToken, X-Tesla-Timestamp (ms).
//
// Access: partner approval only. Binance gives the base URL, client id, access token and its webhook
// public key after onboarding. There is no sandbox ("Sandbox environment is not supported currently").
//
// TO VERIFY items are marked in the code. Nothing here was tested against the live API.
//
// Server-side only. Web-standard APIs only (fetch, WebCrypto), so it runs on Cloudflare Workers.

import { awaitPoll, createAdapter, deliverableToAsset, fetchJson, httpErrorToOrk, legStepFromEvent, POLL as POLLS, randomHex, requireDeliverAsset } from '@openrampkit/adapter'
import type { AdapterContext, LegEvent } from '@openrampkit/adapter'
import { OrkException, SOLANA_MAINNET, USDC, isDecimal, isWebUrl, orkError } from '@openrampkit/core'
import type { Amount, Asset, CryptoAsset, Fee, LegSpec, PollSpec, RegionPolicy } from '@openrampkit/core'
import { importRsaPrivateKey, importRsaPublicKey, rsaSign, rsaVerify } from './rsa.js'

export { importRsaPrivateKey, importRsaPublicKey, rsaSign, rsaVerify } from './rsa.js'

export type BinanceDeliverAsset = {
  /** CAIP-2 chain */
  chain: string
  /** Token address (lowercase for EVM) */
  token: string
  /** Binance coin, e.g. `USDC` */
  cryptoCurrency: string
  /** Binance network code, e.g. `BASE`, `ARBITRUM`, `ETH`, `BSC`, `SOL` (see `crypto-network`) */
  network: string
  symbol?: string
  decimals?: number
}

export type BinanceOptions = {
  /**
   * API base URL. Required: Binance gives it to approved partners ("Please ask for Binance Pay
   * Onchain team"). It is not public.
   */
  apiUrl: string
  /** X-Tesla-ClientId: partner client id from Binance */
  clientId: string
  /** X-Tesla-SignAccessToken: access token from Binance */
  accessToken: string
  /** Your RSA private key (PKCS#8, PEM or base64). You give Binance the public key. */
  privateKey: string
  /** Binance's webhook public key (SPKI, PEM or base64), from onboarding */
  binancePublicKey: string
  /**
   * When set, a webhook must carry this value in `X-BN-Connect-For`. The docs say the header
   * "matches your client ID"; onboarding also gives a "partner code for webhook". TO VERIFY which one.
   */
  webhookPartnerCode?: string
  /**
   * Binance `payMethodCode` for the order. Default `BUY_WALLET` (the fiat balance in the user's Binance
   * account). `null` lets Binance choose (card, P2P and others too).
   */
  payMethodCode?: string | null
  /** Method id for the leg. Default `exchange` ("Connect exchange"). */
  method?: string
  /** Assets Binance may deliver, most preferred first. Default: USDC on Base, Arbitrum, Ethereum, Optimism, BNB Chain, Solana. */
  deliverAssets?: BinanceDeliverAsset[]
  /** Region policy. Default: every country except where Binance does not serve users (see `BINANCE_REGIONS`). */
  regions?: RegionPolicy
  /** Request timeout in ms. Default 8000. */
  timeoutMs?: number
}

/** Binance order status codes (docs "Order Status", 2026-10-05) */
export const BINANCE_ORDER_STATUS = {
  INIT: 0,
  ON_RAMP_PROCESSING: 1,
  ON_RAMP_COMPLETED: 2,
  CONVERT_PROCESSING: 3,
  CONVERT_COMPLETED: 4,
  OFF_RAMP_PROCESSING: 6,
  WITHDRAW_INIT: 10,
  WITHDRAW_PROCESSING: 11,
  SWAP_PROCESSING: 15,
  COMPLETED: 20,
  SWAP_ABANDONED: 93,
  SWAP_FAILED: 94,
  OFF_RAMP_FAILED: 95,
  WITHDRAW_ABANDONED: 96,
  ON_RAMP_FAILED: 97,
  WITHDRAW_FAILED: 98,
  FAILED: 99,
} as const

/**
 * Default region policy. Binance does not serve the US (Binance.US is a separate company), Canada,
 * the Netherlands, Singapore, Malaysia, sanctioned countries and the occupied regions of Ukraine.
 * TO VERIFY with Binance for your partner setup: on-ramp coverage also depends on your approval.
 */
export const BINANCE_REGIONS: RegionPolicy = {
  allow: ['*'],
  deny: ['US', 'CA', 'NL', 'SG', 'MY', 'CU', 'IR', 'KP', 'SY', 'UA-43', 'UA-40', 'UA-14', 'UA-09'],
}

/** Binance network codes from the docs examples: ETH, BSC, ARBITRUM, SOL, OPTIMISM, BASE. */
export const DEFAULT_DELIVER_ASSETS: BinanceDeliverAsset[] = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, cryptoCurrency: 'USDC', network: 'BASE', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:42161', token: USDC['eip155:42161']!, cryptoCurrency: 'USDC', network: 'ARBITRUM', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:1', token: USDC['eip155:1']!, cryptoCurrency: 'USDC', network: 'ETH', symbol: 'USDC', decimals: 6 },
  { chain: 'eip155:10', token: USDC['eip155:10']!, cryptoCurrency: 'USDC', network: 'OPTIMISM', symbol: 'USDC', decimals: 6 },
  // Binance-Peg USDC on BNB Chain has 18 decimals
  { chain: 'eip155:56', token: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', cryptoCurrency: 'USDC', network: 'BSC', symbol: 'USDC', decimals: 18 },
  { chain: SOLANA_MAINNET, token: USDC[SOLANA_MAINNET]!, cryptoCurrency: 'USDC', network: 'SOL', symbol: 'USDC', decimals: 6 },
]

/** Common response envelope: `code` '000000' means success */
type Envelope<T> = { success?: boolean; code?: string; message?: string; data?: T }

type EstimatedQuote = {
  totalAmount?: string
  quotePrice?: string
  feeAmount?: string
  feeCurrency?: string
  networkFee?: string
  payMethodCode?: string
  payMethodSubCode?: string
}

/** Order fields shared by the query API and the webhook body */
export type BinanceOrder = {
  webhookEventType?: string
  externalOrderId?: string
  type?: number
  businessType?: number
  status?: number
  fiatCurrency?: string
  cryptoCurrency?: string
  fiatAmount?: string
  cryptoAmount?: string
  feeAmount?: string
  feeCurrency?: string
  networkFee?: string | null
  withdrawWalletAddress?: string
  withdrawNetwork?: string
  withdrawTxHash?: string | null
}

const POLL: PollSpec = POLLS.checkout
const ID = 'binance'
const NAME = 'Binance'
const LEG_ID = 'account'
const ORDER_TTL_SEC = 7 * 24 * 60 * 60
/** Binance takes up to 8 fraction digits in `requestedAmount` */
const AMOUNT_DIGITS = 8

export function binance(opts: BinanceOptions) {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '')
  const deliver = opts.deliverAssets?.length ? opts.deliverAssets : DEFAULT_DELIVER_ASSETS
  const payMethodCode = opts.payMethodCode === undefined ? 'BUY_WALLET' : opts.payMethodCode
  const toChains: Record<string, string[]> = {}
  for (const d of deliver) (toChains[d.chain] ??= []).push(d.chain.startsWith('eip155:') ? d.token.toLowerCase() : d.token)

  // Import the keys once, on first use (importKey is async).
  let signKey: Promise<CryptoKey> | undefined
  let verifyKey: Promise<CryptoKey> | undefined

  const legs: LegSpec[] = [
    {
      id: LEG_ID,
      kind: 'fiat_onramp',
      methods: [opts.method ?? 'exchange'],
      // TO VERIFY: the fiat currencies come from `trading-pairs` and depend on the partner setup.
      from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: toChains }, location: ['address'] },
      regions: opts.regions ?? BINANCE_REGIONS,
      // TO VERIFY: Binance publishes no static limits; quotes and the landing page carry them.
      eta: { min: 60, max: 1800 },
      surfaces: ['REDIRECT'],
      requires: ['provider_account', 'provider_kyc'],
    },
  ]

  /** The asset Binance delivers for `asset`. NO_QUOTES when Binance does not deliver that token on that chain (never another token). */
  function deliverAssetFor(asset: Asset | undefined): BinanceDeliverAsset {
    return requireDeliverAsset(deliver, asset, NAME)
  }

  const assetOf = deliverableToAsset

  /** Signed POST to the Binance API. Throws an OrkException for HTTP errors and for a non-success envelope. */
  async function call<T>(ctx: Pick<AdapterContext, 'fetch' | 'log'>, path: string, body: Record<string, unknown>, what: string): Promise<T> {
    const json = JSON.stringify(body)
    const timestamp = String(Date.now())
    let key: CryptoKey
    try {
      signKey ??= importRsaPrivateKey(opts.privateKey)
      key = await signKey
    } catch (e) {
      signKey = undefined
      ctx.log.error('binance: cannot import privateKey', { error: String((e as Error)?.message ?? e).slice(0, 200) })
      throw new OrkException(orkError('PROVIDER_UNAVAILABLE'), 502)
    }
    let res: Envelope<T>
    try {
      const signature = await rsaSign(key, json + timestamp)
      res = await fetchJson<Envelope<T>>(ctx.fetch, `${apiUrl}${path}`, {
        method: 'POST',
        body: json,
        headers: {
          'X-Tesla-ClientId': opts.clientId,
          'X-Tesla-SignAccessToken': opts.accessToken,
          'X-Tesla-Signature': signature,
          'X-Tesla-Timestamp': timestamp,
        },
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
    } catch (e) {
      throw httpErrorToOrk(e, NAME, { what, log: ctx.log })
    }
    if (res?.success === false || (res?.code !== undefined && res.code !== '000000') || res?.data === undefined || res.data === null) {
      ctx.log.warn('binance: request refused', { path, code: res?.code, message: res?.message })
      // TO VERIFY: map Binance error codes (docs "Error Codes") to finer OrkError codes.
      const message = res?.message ? `${NAME}: ${res.message}`.slice(0, 200) : `${NAME} could not ${what}.`
      throw new OrkException(orkError('NO_QUOTES', { message }), 422)
    }
    return res.data
  }

  function eventFrom(o: BinanceOrder): LegEvent | undefined {
    const ref = o.externalOrderId
    if (!ref) return undefined
    const d = deliver.find((x) => x.network === o.withdrawNetwork && x.cryptoCurrency === o.cryptoCurrency)
    const output = d && o.cryptoAmount && isDecimal(o.cryptoAmount) ? { output: { amount: o.cryptoAmount, asset: assetOf(d) } } : {}
    const txHash = o.withdrawTxHash ? { txHash: o.withdrawTxHash } : {}
    const S = BINANCE_ORDER_STATUS
    switch (o.status) {
      case S.COMPLETED:
        return { ref, status: 'succeeded', ...txHash, ...output }
      case S.ON_RAMP_PROCESSING:
      case S.ON_RAMP_COMPLETED:
      case S.CONVERT_PROCESSING:
      case S.CONVERT_COMPLETED:
      case S.OFF_RAMP_PROCESSING:
      case S.WITHDRAW_INIT:
      case S.WITHDRAW_PROCESSING:
      case S.SWAP_PROCESSING:
        return { ref, status: 'processing', ...txHash }
      case S.SWAP_ABANDONED:
      case S.WITHDRAW_ABANDONED:
        return {
          ref,
          status: 'failed',
          error: orkError('PAYMENT_FAILED', { message: 'The transfer was cancelled in Binance. Your crypto stays in your Binance account.', recovery: 'retry_payment' }),
        }
      case S.WITHDRAW_FAILED:
        return {
          ref,
          status: 'failed',
          error: orkError('DELIVERY_FAILED', { message: 'Binance could not send the crypto. It stays in your Binance account.', recovery: 'contact_support' }),
        }
      case S.SWAP_FAILED:
      case S.OFF_RAMP_FAILED:
      case S.ON_RAMP_FAILED:
      case S.FAILED:
        return { ref, status: 'failed', error: orkError('PAYMENT_FAILED', { recovery: 'retry_payment' }) }
      default:
        // INIT (0) and unknown codes: the user has not paid yet. No state change.
        return undefined
    }
  }

  return createAdapter({
    id: ID,
    name: NAME,
    legs,

    async quote(input, ctx) {
      const target = deliverAssetFor(input.leg.to.asset)
      const fiatAsset = input.amountIn?.asset ?? input.leg.from.asset
      if (fiatAsset.kind !== 'fiat') throw new OrkException(orkError('BAD_REQUEST', { message: 'Binance quotes need a fiat currency.' }))
      const fiat = fiatAsset.currency.toUpperCase()
      const byFiat = !!input.amountIn
      const raw = byFiat ? input.amountIn!.amount : input.amountOut?.amount
      const requested = raw && isDecimal(raw) ? trimDigits(raw, AMOUNT_DIGITS) : undefined
      if (!requested || Number(requested) <= 0) throw new OrkException(orkError('BAD_REQUEST', { message: 'Binance quotes need an amount.' }))
      const q = await call<EstimatedQuote>(
        ctx,
        '/papi/v1/ramp/connect/buy/estimated-quote',
        {
          fiatCurrency: fiat,
          cryptoCurrency: target.cryptoCurrency,
          requestedAmount: requested,
          amountType: byFiat ? 1 : 2,
          network: target.network,
          ...(payMethodCode ? { payMethodCode } : {}),
        },
        'price this amount',
      )
      if (!q.totalAmount || !isDecimal(q.totalAmount)) throw new OrkException(orkError('NO_QUOTES', { message: `${NAME} returned no price.` }), 422)
      const fees: Fee[] = []
      // `feeCurrency` is "fiat currency or crypto" per the docs.
      if (q.feeAmount && isDecimal(q.feeAmount) && Number(q.feeAmount) > 0) fees.push({ kind: 'provider', label: 'Binance fee', amount: q.feeAmount, currency: q.feeCurrency || fiat })
      // TO VERIFY: the docs do not say the unit of `networkFee`. We assume the delivered crypto.
      if (q.networkFee && isDecimal(q.networkFee) && Number(q.networkFee) > 0) fees.push({ kind: 'network', label: 'Network fee', amount: q.networkFee, currency: target.cryptoCurrency })
      // TO VERIFY: whether `totalAmount` is before or after the fees.
      const fiatAmount = byFiat ? requested : q.totalAmount
      const cryptoAmount = byFiat ? q.totalAmount : requested
      return {
        adapterId: ID,
        legId: input.leg.legId,
        input: { amount: fiatAmount, asset: { kind: 'fiat', currency: fiat } },
        output: { amount: cryptoAmount, asset: assetOf(target) },
        fees,
        eta: { min: 60, max: 1800 },
        // An estimate: Binance shows the final price on its page. TO VERIFY the quote lifetime.
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        data: {
          fiat,
          amountType: byFiat ? 1 : 2,
          requestedAmount: requested,
          cryptoCurrency: target.cryptoCurrency,
          network: target.network,
          ...(q.payMethodCode || payMethodCode ? { payMethodCode: q.payMethodCode || payMethodCode } : {}),
          estimate: true,
        },
      }
    },

    async start(input, ctx) {
      const data = (input.quote.data ?? {}) as Record<string, string | number | boolean | undefined>
      const target = deliverAssetFor(input.quote.output.asset)
      const address = input.deliverTo?.address ?? (ctx.destination.type === 'crypto' ? ctx.destination.address : undefined)
      if (!address) throw new OrkException(orkError('BAD_REQUEST', { message: 'Binance needs a wallet address to send to.' }))
      // externalOrderId: "Supports only letters and numbers". TO VERIFY the maximum length (we use 27 characters).
      const ref = `ork${randomHex(12)}`
      const amountType = data.amountType === 2 ? 2 : 1
      const requestedAmount = String(data.requestedAmount ?? (amountType === 1 ? input.quote.input.amount : input.quote.output.amount))
      const order = await call<{ link?: string; linkExpireTime?: number }>(
        ctx,
        '/papi/v1/ramp/connect/buy/pre-order',
        {
          externalOrderId: ref,
          fiatCurrency: data.fiat ?? (input.quote.input.asset.kind === 'fiat' ? input.quote.input.asset.currency : undefined),
          cryptoCurrency: data.cryptoCurrency ?? target.cryptoCurrency,
          amountType,
          requestedAmount: trimDigits(requestedAmount, AMOUNT_DIGITS),
          ...(data.payMethodCode ? { payMethodCode: data.payMethodCode } : {}),
          network: data.network ?? target.network,
          address,
          redirectUrl: ctx.urls.returnUrl,
          failRedirectUrl: ctx.urls.returnUrl,
          ...(ctx.session.ip ? { clientIp: ctx.session.ip } : {}),
        },
        'start the payment',
      )
      if (!isWebUrl(order.link, { allowHttp: !ctx.session.livemode })) {
        throw new OrkException(orkError('PROVIDER_UNAVAILABLE', { message: `${NAME} returned no payment link.` }), 502)
      }
      await ctx.store.put(`o:${ref}`, { since: Date.now() }, ORDER_TTL_SEC)
      return {
        state: 'PAYMENT',
        status: 'awaiting_user',
        ref,
        surface: { kind: 'REDIRECT', url: order.link, popup: true, provider: NAME },
        transitions: [awaitPoll(POLL)],
      }
    },

    async status({ ref }, ctx) {
      const o = await call<BinanceOrder>(ctx, '/papi/v1/ramp/connect/order', { externalOrderId: ref }, 'find this order')
      return legStepFromEvent(eventFrom({ ...o, externalOrderId: ref }), ref, POLL)
    },

    webhook: {
      // Without the binancePublicKey, no webhook can verify (see `resultChannels`).
      configured: !!opts.binancePublicKey,
      async verify(req, rawBody, ctx) {
        // An empty key would make every webhook fail to verify anyway; log the cause.
        if (!opts.binancePublicKey) {
          ctx.log.warn('binance: binancePublicKey is not set; rejecting webhook')
          return false
        }
        const signature = req.headers.get('x-bn-connect-signature')
        const timestamp = req.headers.get('x-bn-connect-timestamp')
        if (!signature || !timestamp) return false
        if (opts.webhookPartnerCode && req.headers.get('x-bn-connect-for') !== opts.webhookPartnerCode) return false
        let key: CryptoKey
        try {
          verifyKey ??= importRsaPublicKey(opts.binancePublicKey)
          key = await verifyKey
        } catch (e) {
          verifyKey = undefined
          ctx.log.error('binance: cannot import binancePublicKey', { error: String((e as Error)?.message ?? e).slice(0, 200) })
          return false
        }
        // Docs: "SHA256withRSA(requestBody + X-Connect-Timestamp)". We read the value from the
        // X-BN-Connect-Timestamp header (TO VERIFY: the docs name the header two ways).
        return rsaVerify(key, rawBody + timestamp, signature)
      },
      async parse(rawBody, ctx) {
        let o: BinanceOrder
        try {
          o = JSON.parse(rawBody) as BinanceOrder
        } catch {
          ctx.log.warn('binance: webhook body is not JSON')
          return []
        }
        if (o.webhookEventType && o.webhookEventType !== 'connect_order_event') return []
        const ev = eventFrom(o)
        if (!ev && !o.externalOrderId) ctx.log.warn('binance: webhook without externalOrderId')
        return ev ? [ev] : []
      },
    },

    async health(ctx) {
      try {
        await call(ctx, '/papi/v1/ramp/connect/buy/trading-pairs', {}, 'list trading pairs')
        return { ok: true }
      } catch (e) {
        return { ok: false, detail: String((e as { error?: { message?: string } })?.error?.message ?? (e as Error)?.message ?? e).slice(0, 200) }
      }
    },
  })
}

/** Cut a decimal string to `digits` fraction digits (no rounding up, so we never ask for more). */
function trimDigits(v: string, digits: number): string {
  const [i, f = ''] = v.split('.')
  const frac = f.slice(0, digits).replace(/0+$/, '')
  return frac ? `${i}.${frac}` : i!
}
