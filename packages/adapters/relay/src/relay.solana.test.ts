// Solana and Tempo through the Relay adapter: Solana origin and destination, deposit addresses,
// and on-chain checks of same-chain Solana moves (getSignatureStatuses and getTransaction).

import { describe, expect, it } from 'vitest'
import { checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { SOLANA_MAINNET, SOLANA_USDC_MINT, TEMPO_MAINNET, TEMPO_USDC, USDC, planPathways } from '@openrampkit/core'
import type { CryptoAsset, Destination, PathwayLeg } from '@openrampkit/core'
import { RELAY_SOLANA_CHAIN_ID, relay } from './index.js'
import type { RelayQuoteResponse } from './index.js'
import { fakeFetch, makeCtx, memoryKV } from '@openrampkit/adapter/testing'
import type { FakeCall } from '@openrampkit/adapter/testing'

const SOL = SOLANA_MAINNET
const SOL_RPC = 'api.mainnet-beta.solana.com'
const EVM_USER = '0x03508bB71268BBA25ECaCC8F620e01866650532c'
const EVM_DEST = '0x000000000000000000000000000000000000beef'
const SOL_USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const SOL_DEST = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ'
const SOL_DEST_ATA = 'FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B'
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const SIG2 = '4VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const DEPOSIT = '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af'

const SOL_USDC: CryptoAsset = { kind: 'crypto', chain: SOL, token: SOLANA_USDC_MINT }
const BASE_USDC: CryptoAsset = { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! }
const solDest: Destination = { type: 'crypto', chain: SOL, token: SOLANA_USDC_MINT, address: SOL_DEST }
const baseDest: Destination = { type: 'crypto', chain: 'eip155:8453', token: BASE_USDC.token, address: EVM_DEST }

const leg = (legId: string, to: CryptoAsset, address: string): PathwayLeg => ({
  adapterId: 'relay',
  legId,
  from: { asset: { kind: 'crypto', chain: '*', token: '*' }, location: { kind: 'user_wallet' } },
  to: { asset: to, location: { kind: 'address', address } },
})

const usdcOf = (chainId: number, address: string) => ({ chainId, address, symbol: 'USDC', name: 'USD Coin', decimals: 6 })

/** A Relay quote for Solana USDC -> Base USDC: one step with Solana instructions */
function solanaOriginQuote(): RelayQuoteResponse {
  return {
    requestId: '0xsolreq',
    steps: [
      {
        id: 'deposit',
        kind: 'transaction',
        requestId: '0xsolreq',
        items: [
          {
            status: 'incomplete',
            data: {
              instructions: [
                {
                  programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
                  keys: [{ pubkey: SOL_USER, isSigner: true, isWritable: true }],
                  data: '0b9c60da27a3b41380969800',
                },
              ],
              addressLookupTableAddresses: ['Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'],
            },
          },
        ],
      },
    ],
    details: {
      currencyIn: { currency: usdcOf(RELAY_SOLANA_CHAIN_ID, SOLANA_USDC_MINT), amount: '10000000' },
      currencyOut: { currency: usdcOf(8453, BASE_USDC.token), amount: '9975036' },
      timeEstimate: 3,
    },
  } as unknown as RelayQuoteResponse
}

/** A Relay quote into Solana USDC, from an EVM chain */
function intoSolanaQuote(deposit = false): RelayQuoteResponse {
  return {
    requestId: '0xtosol',
    steps: [
      {
        id: 'deposit',
        kind: 'transaction',
        requestId: '0xtosol',
        ...(deposit ? { depositAddress: DEPOSIT } : {}),
        items: [{ status: 'incomplete', data: { to: DEPOSIT, data: '0x', value: '0', chainId: 8453 } }],
      },
    ],
    details: {
      currencyIn: { currency: usdcOf(8453, BASE_USDC.token), amount: '10000000' },
      currencyOut: { currency: usdcOf(RELAY_SOLANA_CHAIN_ID, SOLANA_USDC_MINT), amount: '9966541' },
    },
  } as unknown as RelayQuoteResponse
}

type TokenBal = { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string } }

/** A fake Solana JSON-RPC. `txs` maps a signature to its parsed transaction. */
function solanaRpc(state: {
  statuses?: Record<string, { err: unknown; confirmationStatus: string } | null>
  txs?: Record<string, unknown>
  tokenAccounts?: string[]
  signatures?: Array<{ signature: string; err: unknown; blockTime: number }>
}) {
  return (c: FakeCall) => {
    const { method, params } = c.body as { method: string; params: unknown[] }
    switch (method) {
      case 'getSignatureStatuses':
        return { jsonrpc: '2.0', id: 1, result: { value: (params[0] as string[]).map((s) => state.statuses?.[s] ?? null) } }
      case 'getTransaction':
        return { jsonrpc: '2.0', id: 1, result: state.txs?.[params[0] as string] ?? null }
      case 'getTokenAccountsByOwner':
        return { jsonrpc: '2.0', id: 1, result: { value: (state.tokenAccounts ?? []).map((pubkey) => ({ pubkey })) } }
      case 'getSignaturesForAddress':
        return { jsonrpc: '2.0', id: 1, result: state.signatures ?? [] }
      default:
        return { jsonrpc: '2.0', id: 1, error: { message: `unexpected ${method}` } }
    }
  }
}

/** A parsed SPL transfer of `amount` USDC base units to SOL_DEST, at `blockTime` (seconds) */
function splTx(amount: bigint, opts: { blockTime?: number; err?: unknown; pre?: bigint; mint?: string; owner?: string } = {}) {
  const pre: TokenBal[] = opts.pre === undefined ? [] : [{ accountIndex: 2, mint: SOLANA_USDC_MINT, owner: SOL_DEST, uiTokenAmount: { amount: String(opts.pre) } }]
  return {
    blockTime: opts.blockTime ?? Math.floor(Date.now() / 1000),
    meta: {
      err: opts.err ?? null,
      preBalances: [1_000_000_000, 0, 2_039_280],
      postBalances: [999_995_000, 0, 2_039_280],
      preTokenBalances: pre,
      postTokenBalances: [
        { accountIndex: 1, mint: SOLANA_USDC_MINT, owner: SOL_USER, uiTokenAmount: { amount: '0' } },
        { accountIndex: 2, mint: opts.mint ?? SOLANA_USDC_MINT, owner: opts.owner ?? SOL_DEST, uiTokenAmount: { amount: String((opts.pre ?? 0n) + amount) } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: SOL_USER }, { pubkey: 'UserAta1111111111111111111111111111111111111' }, { pubkey: SOL_DEST_ATA }] } },
  }
}

describe('relay: Solana destination', () => {
  it('plans wallet, transfer and card > bridge hop pathways to USDC on Solana', () => {
    const a = relay()
    const plan = planPathways({
      direction: 'deposit',
      destination: solDest,
      user: { country: 'ID', walletConnected: true },
      legs: [
        ...a.legs.map((spec) => ({ adapterId: 'relay', provider: 'Relay', spec })),
        {
          adapterId: 'x',
          provider: 'X',
          spec: {
            id: 'card', kind: 'fiat_onramp', methods: ['card'],
            from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
            to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [BASE_USDC.token] } }, location: ['address'] },
            regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
          },
        },
      ],
    })
    const ids = plan.pathways.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['wallet:relay.wallet', 'transfer:relay.transfer', 'card:x.card>relay.bridge@eip155:8453']))
    // the base58 mint keeps its case in every leg endpoint
    const last = plan.pathways.find((p) => p.id.startsWith('card:'))!.legs[1]!
    expect(last.to.asset).toMatchObject({ chain: SOL, token: SOLANA_USDC_MINT })
  })

  it('EVM wallet to Solana USDC: the mint keeps its case and the recipient is the Solana address', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => intoSolanaQuote() }])
    const ctx = makeCtx({ fetch, destination: solDest })
    const q = await relay().quote({ leg: leg('wallet', SOL_USDC, SOL_DEST), amountIn: { amount: '10', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: EVM_USER } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q.output).toMatchObject({ amount: '9.966541', asset: { chain: SOL, token: SOLANA_USDC_MINT, symbol: 'USDC', decimals: 6 } })
    expect(calls[0]!.body).toMatchObject({ user: EVM_USER, recipient: SOL_DEST, originChainId: 8453, destinationChainId: RELAY_SOLANA_CHAIN_ID, destinationCurrency: SOLANA_USDC_MINT })
  })

  it('deposit address into Solana: `user` is an EVM placeholder (Relay rejects a Solana user on an EVM origin)', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: () => intoSolanaQuote(true) },
      { method: 'GET', match: '/requests/v3', reply: () => ({ requests: [{ id: 'r', status: 'success', createdAt: new Date().toISOString(), data: { outTxs: [{ hash: SIG }], route: { actual: { destination: { outputCurrency: { currency: usdcOf(RELAY_SOLANA_CHAIN_ID, SOLANA_USDC_MINT), amount: '9966541' } } } } } }] }) },
    ])
    const a = relay({ apiKey: 'k' })
    const ctx = makeCtx({ fetch, destination: solDest })
    const transfer = leg('transfer', SOL_USDC, SOL_DEST)
    const q = await a.quote({ leg: transfer, amountIn: { amount: '10', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token } }, ctx)
    expect(calls[0]!.body).toMatchObject({ user: '0x000000000000000000000000000000000000dEaD', recipient: SOL_DEST, useDepositAddress: true, refundTo: '0x0000000000000000000000000000000000000000' })
    expect(q.data).toMatchObject({ depositAddress: DEPOSIT })
    const step = await a.start({ leg: transfer, quote: q }, ctx)
    expect(step.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: 'eip155:8453', address: DEPOSIT, symbol: 'USDC' })
    const done = await a.status!({ leg: transfer, ref: step.ref! }, ctx)
    expect(checkLegStep(done)).toEqual([])
    expect(done).toMatchObject({ state: 'COMPLETED', txHash: SIG, output: { amount: '9.966541', asset: { chain: SOL, token: SOLANA_USDC_MINT } } })
  })

  it('the deposit address cache key keeps the case of a Solana recipient', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => intoSolanaQuote(true) }])
    const shared = memoryKV()
    const a = relay()
    const transfer = leg('transfer', SOL_USDC, SOL_DEST)
    await a.quote({ leg: transfer, amountIn: { amount: '10', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token } }, makeCtx({ fetch, shared, destination: solDest }))
    const key = `da:${SOL_DEST}:eip155:8453:${BASE_USDC.token}:${SOL}:${SOLANA_USDC_MINT}`
    expect(await shared.get(key)).toBe(DEPOSIT)
  })
})

describe('relay: Solana origin (wallet)', () => {
  const walletLeg = leg('wallet', BASE_USDC, EVM_DEST)
  const solSource = { chain: SOL, token: SOLANA_USDC_MINT, address: SOL_USER }

  it('quotes with a Solana placeholder user when the connected address is EVM', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => solanaOriginQuote() }])
    const ctx = makeCtx({ fetch, destination: baseDest })
    const q = await relay().quote({ leg: walletLeg, amountIn: { amount: '10', asset: SOL_USDC }, source: { chain: SOL, token: SOLANA_USDC_MINT, address: EVM_USER } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q.input).toMatchObject({ amount: '10', asset: { chain: SOL, token: SOLANA_USDC_MINT, symbol: 'USDC', decimals: 6 } })
    expect(calls[0]!.body).toMatchObject({ user: '11111111111111111111111111111111', originChainId: RELAY_SOLANA_CHAIN_ID, originCurrency: SOLANA_USDC_MINT })
  })

  it('start gives a Solana WALLET_TX with the instructions; a Solana signature moves it on; intent status completes it', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/quote/v2', reply: () => solanaOriginQuote() },
      { method: 'GET', match: '/intents/status/v3', reply: () => ({ status: 'success', inTxHashes: [SIG], txHashes: ['0xdest'] }) },
    ])
    const a = relay()
    const ctx = makeCtx({ fetch, destination: baseDest })
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '10', asset: SOL_USDC }, source: solSource }, ctx)
    expect(calls[0]!.body).toMatchObject({ user: SOL_USER })
    const step = await a.start({ leg: walletLeg, quote: q, source: solSource }, ctx)
    expect(calls).toHaveLength(1) // fresh quote for the same user: reused
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', ref: '0xsolreq', surface: { kind: 'WALLET_TX', chain: SOL } })
    const txs = (step.surface as { txs: unknown[] }).txs
    expect(txs).toEqual([
      {
        kind: 'solana',
        type: 'instructions',
        instructions: [{ programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', keys: [{ pubkey: SOL_USER, isSigner: true, isWritable: true }], data: '0b9c60da27a3b41380969800' }],
        addressLookupTableAddresses: ['Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'],
      },
    ])
    // an EVM hash is not a Solana signature
    await expect(a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: `0x${'ab'.repeat(32)}` } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const t = await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: SIG } }, ctx)
    expect(t).toMatchObject({ state: 'PROCESSING', txHash: SIG })
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'COMPLETED', txHash: '0xdest' })
  })

  it('re-quotes for the Solana user when the quote was built with a placeholder', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => solanaOriginQuote() }])
    const a = relay()
    const ctx = makeCtx({ fetch, destination: baseDest })
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '10', asset: SOL_USDC }, source: { chain: SOL, token: SOLANA_USDC_MINT } }, ctx)
    await a.start({ leg: walletLeg, quote: q, source: solSource }, ctx)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toMatchObject({ user: SOL_USER })
  })

  it('refuses to start without a Solana address', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', match: '/quote/v2', reply: () => solanaOriginQuote() }])
    const a = relay()
    const ctx = makeCtx({ fetch, destination: baseDest })
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '10', asset: SOL_USDC }, source: { chain: SOL, token: SOLANA_USDC_MINT, address: EVM_USER } }, ctx)
    await expect(a.start({ leg: walletLeg, quote: q, source: { chain: SOL, token: SOLANA_USDC_MINT, address: EVM_USER } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Connect a Solana wallet to pay from Solana.' } })
  })
})

describe('relay: same-chain Solana moves are checked on chain', () => {
  const walletLeg = leg('wallet', SOL_USDC, SOL_DEST)
  const solSource = { chain: SOL, token: SOLANA_USDC_MINT, address: SOL_USER }

  async function startDirect(fetch: typeof globalThis.fetch, shared = memoryKV()) {
    const a = relay()
    const ctx = makeCtx({ fetch, shared, destination: solDest })
    const q = await a.quote({ leg: walletLeg, amountIn: { amount: '12.5', asset: SOL_USDC }, source: solSource }, ctx)
    const step = await a.start({ leg: walletLeg, quote: q, source: solSource }, ctx)
    return { a, ctx, q, step }
  }

  it('no Relay call; the wallet gets an SPL transfer; confirmed and paid in full completes', async () => {
    const rpc = { statuses: {} as Record<string, { err: unknown; confirmationStatus: string } | null>, txs: {} as Record<string, unknown> }
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: SOL_RPC, reply: solanaRpc(rpc) }])
    const { a, ctx, q, step } = await startDirect(fetch)
    expect(q.fees).toEqual([])
    expect(q.output).toMatchObject({ amount: '12.5', asset: { chain: SOL, token: SOLANA_USDC_MINT } })
    expect(step.surface).toEqual({ kind: 'WALLET_TX', chain: SOL, txs: [{ kind: 'solana', type: 'transfer', to: SOL_DEST, mint: SOLANA_USDC_MINT, amount: '12500000', decimals: 6 }] })
    expect(calls).toHaveLength(0)

    // waiting for the signature
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: SIG } }, ctx)
    // unknown to the RPC yet, then only processed: still confirming
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PROCESSING', sub: 'confirming' })
    rpc.statuses[SIG] = { err: null, confirmationStatus: 'processed' }
    expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'PROCESSING', sub: 'confirming' })
    rpc.statuses[SIG] = { err: null, confirmationStatus: 'confirmed' }
    rpc.txs[SIG] = splTx(12_500_000n, { pre: 1_000_000n })
    const done = await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)
    expect(checkLegStep(done)).toEqual([])
    expect(done).toMatchObject({ state: 'COMPLETED', txHash: SIG })
    const sent = calls.map((c) => (c.body as { method: string }).method)
    expect(sent).toContain('getSignatureStatuses')
    expect(sent).toContain('getTransaction')
    expect((calls.find((c) => (c.body as { method: string }).method === 'getTransaction')!.body as { params: unknown[] }).params[1]).toMatchObject({ encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })
  })

  it('one signature completes one payment only', async () => {
    const rpc = { statuses: { [SIG]: { err: null, confirmationStatus: 'finalized' } }, txs: { [SIG]: splTx(12_500_000n) } }
    const { fetch } = fakeFetch([{ method: 'POST', match: SOL_RPC, reply: solanaRpc(rpc) }])
    const shared = memoryKV()
    const pay = async () => {
      const { a, ctx, step } = await startDirect(fetch, shared)
      await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: SIG } }, ctx)
      return a.status!({ leg: walletLeg, ref: step.ref! }, ctx)
    }
    expect(await pay()).toMatchObject({ state: 'COMPLETED' })
    expect(await pay()).toMatchObject({ state: 'FAILED', error: { message: 'This transaction was already used for another payment.' } })
  })

  it('fails when the transaction failed, pays too little, pays another owner or mint, or is older than the leg', async () => {
    const cases: Array<[unknown, { err: unknown; confirmationStatus: string }, string]> = [
      [splTx(12_500_000n), { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }, 'The transaction failed on chain.'],
      [splTx(12_500_000n, { err: { InstructionError: [0, 'Custom'] } }), { err: null, confirmationStatus: 'confirmed' }, 'The transaction failed on chain.'],
      [splTx(12_499_999n), { err: null, confirmationStatus: 'confirmed' }, 'The transaction does not pay the destination the quoted amount.'],
      [splTx(12_500_000n, { owner: SOL_USER }), { err: null, confirmationStatus: 'confirmed' }, 'The transaction does not pay the destination the quoted amount.'],
      [splTx(12_500_000n, { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }), { err: null, confirmationStatus: 'confirmed' }, 'The transaction does not pay the destination the quoted amount.'],
      [splTx(12_500_000n, { blockTime: Math.floor(Date.now() / 1000) - 3600 }), { err: null, confirmationStatus: 'confirmed' }, 'The transaction was sent before this payment started.'],
    ]
    for (const [tx, status, message] of cases) {
      const { fetch } = fakeFetch([{ method: 'POST', match: SOL_RPC, reply: solanaRpc({ statuses: { [SIG]: status }, txs: { [SIG]: tx } }) }])
      const { a, ctx, step } = await startDirect(fetch)
      await a.transition!({ leg: walletLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: SIG } }, ctx)
      expect(await a.status!({ leg: walletLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'FAILED', error: { code: 'DELIVERY_FAILED', message } })
    }
  })

  it('native SOL: a system transfer and the lamport change of the recipient', async () => {
    const tx = {
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err: null, preBalances: [5_000_000_000, 100], postBalances: [3_499_995_000, 1_500_000_100] },
      transaction: { message: { accountKeys: [SOL_USER, SOL_DEST] } },
    }
    const { fetch } = fakeFetch([{ method: 'POST', match: SOL_RPC, reply: solanaRpc({ statuses: { [SIG]: { err: null, confirmationStatus: 'confirmed' } }, txs: { [SIG]: tx } }) }])
    const a = relay()
    const native: CryptoAsset = { kind: 'crypto', chain: SOL, token: 'native' }
    const ctx = makeCtx({ fetch, destination: { type: 'crypto', chain: SOL, token: 'native', address: SOL_DEST } })
    const nativeLeg = leg('wallet', native, SOL_DEST)
    const q = await a.quote({ leg: nativeLeg, amountIn: { amount: '1.5', asset: native }, source: { chain: SOL, token: 'native', address: SOL_USER } }, ctx)
    const step = await a.start({ leg: nativeLeg, quote: q }, ctx)
    expect((step.surface as { txs: unknown[] }).txs).toEqual([{ kind: 'solana', type: 'transfer', to: SOL_DEST, mint: 'native', amount: '1500000000', decimals: 9 }])
    await a.transition!({ leg: nativeLeg, ref: step.ref!, name: 'submit_tx', inputs: { txHash: SIG } }, ctx)
    expect(await a.status!({ leg: nativeLeg, ref: step.ref! }, ctx)).toMatchObject({ state: 'COMPLETED' })
  })

  it('transfer leg to the destination itself: finds new deposits to its token account, each signature once', async () => {
    const now = Math.floor(Date.now() / 1000)
    const rpc = {
      tokenAccounts: [SOL_DEST_ATA],
      signatures: [] as Array<{ signature: string; err: unknown; blockTime: number }>,
      txs: { [SIG]: splTx(4_000_000n), [SIG2]: splTx(1_000_000n, { blockTime: now - 7200 }) } as Record<string, unknown>,
    }
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: SOL_RPC, reply: solanaRpc(rpc) }])
    const shared = memoryKV()
    const a = relay()
    const transfer = leg('transfer', SOL_USDC, SOL_DEST)
    const run = async (id = 'sess_1') => {
      const ctx = makeCtx({ fetch, shared, destination: solDest, session: { id } as never })
      const q = await a.quote({ leg: transfer, amountIn: { amount: '0', asset: SOL_USDC }, source: { chain: SOL, token: SOLANA_USDC_MINT } }, ctx)
      const step = await a.start({ leg: transfer, quote: q }, ctx)
      return { ctx, step }
    }
    const { ctx, step } = await run()
    // the address is the destination itself; no eth_blockNumber on Solana
    expect(step.surface).toMatchObject({ kind: 'DEPOSIT_ADDRESS', chain: SOL, address: SOL_DEST, token: SOLANA_USDC_MINT, symbol: 'USDC' })
    expect(calls).toHaveLength(0)
    expect(await a.status!({ leg: transfer, ref: step.ref! }, ctx)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    // an old deposit and a failed one do not count
    rpc.signatures = [
      { signature: SIG2, err: null, blockTime: now - 7200 },
      { signature: 'Fail1111111111111111111111111111111111111111111111111111111111111111', err: { x: 1 }, blockTime: now },
    ]
    expect(await a.status!({ leg: transfer, ref: step.ref! }, ctx)).toMatchObject({ state: 'PAYMENT' })
    rpc.signatures = [{ signature: SIG, err: null, blockTime: now }, ...rpc.signatures]
    const done = await a.status!({ leg: transfer, ref: step.ref! }, ctx)
    expect(done).toMatchObject({ state: 'COMPLETED', txHash: SIG, output: { amount: '4' } })
    // the same deposit does not complete another session that watches the same address
    const other = await run('sess_2')
    expect(await a.status!({ leg: transfer, ref: other.step.ref! }, other.ctx)).toMatchObject({ state: 'PAYMENT' })
    // and the first session still sees its own deposit
    expect(await a.status!({ leg: transfer, ref: step.ref! }, ctx)).toMatchObject({ state: 'COMPLETED', txHash: SIG })
  })
})

describe('relay: Tempo', () => {
  it('quotes Base USDC to USDC on Tempo (Relay chain id 4217)', async () => {
    const { fetch, calls } = fakeFetch([
      {
        method: 'POST',
        match: '/quote/v2',
        reply: () => ({
          requestId: '0xtempo',
          steps: [{ id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { to: DEPOSIT, data: '0x01', value: '0', chainId: 8453 } }] }],
          details: { currencyIn: { currency: usdcOf(8453, BASE_USDC.token), amount: '10000000' }, currencyOut: { currency: usdcOf(4217, TEMPO_USDC), amount: '9971627' } },
        }),
      },
    ])
    const tempo: CryptoAsset = { kind: 'crypto', chain: TEMPO_MAINNET, token: TEMPO_USDC }
    const ctx = makeCtx({ fetch, destination: { type: 'crypto', chain: TEMPO_MAINNET, token: TEMPO_USDC, address: EVM_DEST } })
    const q = await relay().quote({ leg: leg('wallet', tempo, EVM_DEST), amountIn: { amount: '10', asset: BASE_USDC }, source: { chain: BASE_USDC.chain, token: BASE_USDC.token, address: EVM_USER } }, ctx)
    expect(calls[0]!.body).toMatchObject({ destinationChainId: 4217, destinationCurrency: TEMPO_USDC })
    expect(q.output).toMatchObject({ amount: '9.971627', asset: { chain: TEMPO_MAINNET, symbol: 'USDC', decimals: 6 } })
  })
})
