// The mock adapter's `solanaLocalChain` leg against a fake Solana JSON-RPC.

import { describe, expect, it } from 'vitest'
import { checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import type { SolanaParsedTx } from '@openrampkit/adapter'
import { SOLANA_DEVNET, SOLANA_DEVNET_USDC_MINT, SPL_TOKEN_PROGRAM } from '@openrampkit/core'
import type { CryptoAsset, PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, memoryKV } from '@openrampkit/adapter/testing'
import { mockAdapter } from './index.js'

const RPC = 'https://api.devnet.solana.com'
const MINT = SOLANA_DEVNET_USDC_MINT
const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const USER_ATA = 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'
const OTHER = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ'
const OTHER_ATA = 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc'
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const START_SLOT = 1000

const USDC: CryptoAsset = { kind: 'crypto', chain: SOLANA_DEVNET, token: MINT, symbol: 'USDC', decimals: 6 }
const SOL: CryptoAsset = { kind: 'crypto', chain: SOLANA_DEVNET, token: 'native', symbol: 'SOL', decimals: 9 }
const legOf = (asset: CryptoAsset, to = USER): PathwayLeg => ({
  adapterId: 'mock',
  legId: 'solana-onchain',
  from: { asset, location: { kind: 'user_wallet' } },
  to: { asset, location: { kind: 'address', address: to } },
})

/** A parsed SPL `transferChecked` from `source` to `dest` (token accounts), with the token balances of the accounts */
function splTx(p: { amount: bigint; dest?: string; destOwner?: string; mint?: string; slot?: number; err?: unknown; inner?: boolean }): SolanaParsedTx {
  const dest = p.dest ?? USER_ATA
  const mint = p.mint ?? MINT
  const ix = { program: 'spl-token', programId: SPL_TOKEN_PROGRAM, parsed: { type: 'transferChecked', info: { source: USER_ATA, destination: dest, mint, authority: USER, tokenAmount: { amount: p.amount.toString(), decimals: 6 } } } }
  const balances = [
    { accountIndex: 1, mint, owner: USER, uiTokenAmount: { amount: '9000000' } },
    ...(dest !== USER_ATA ? [{ accountIndex: 2, mint, owner: p.destOwner ?? OTHER, uiTokenAmount: { amount: '0' } }] : []),
  ]
  return {
    slot: p.slot ?? START_SLOT + 5,
    blockTime: 1_800_000_000,
    meta: { err: p.err ?? null, preTokenBalances: balances, postTokenBalances: balances, innerInstructions: p.inner ? [{ index: 0, instructions: [ix] }] : [] },
    transaction: { message: { accountKeys: [{ pubkey: USER }, { pubkey: USER_ATA }, { pubkey: dest }], instructions: p.inner ? [{ programId: 'Prog111111111111111111111111111111111111111' }] : [ix] } },
  }
}

function setup(p: { status?: unknown; tx?: unknown; mint?: string } = {}) {
  const rpc = fakeFetch([
    {
      method: 'POST',
      match: RPC,
      reply: (c) => {
        const method = (c.body as { method: string }).method
        const result = method === 'getSlot' ? START_SLOT : method === 'getSignatureStatuses' ? { value: [p.status === undefined ? { slot: START_SLOT + 5, err: null, confirmationStatus: 'confirmed' } : p.status] } : method === 'getTransaction' ? (p.tx ?? null) : null
        return { jsonrpc: '2.0', id: 1, result }
      },
    },
  ])
  const mint = p.mint ?? MINT
  const a = mockAdapter({ id: 'mock', methods: ['wallet'], solanaLocalChain: { chain: SOLANA_DEVNET, rpcUrl: RPC, mint } })
  const ctx = makeCtx({ fetch: rpc.fetch, destination: { type: 'crypto', chain: SOLANA_DEVNET, token: mint, address: USER } })
  return { a, ctx, rpc }
}

async function begin(p: Parameters<typeof setup>[0] & { shared?: ReturnType<typeof memoryKV>; sessionId?: string; amount?: string } = {}) {
  const { a, ctx, rpc } = setup(p)
  const c = { ...ctx, ...(p.shared ? { shared: p.shared } : {}), session: { ...ctx.session, id: p.sessionId ?? ctx.session.id } }
  const asset = p.mint === 'native' ? SOL : USDC
  const leg = legOf(asset)
  const q = await a.quote({ leg, amountIn: { value: p.amount ?? '5', asset } }, c)
  const start = await a.start({ leg, quote: q, deliverTo: { address: USER } }, c)
  const submit = (txHash = SIG) => a.transition!({ leg, ref: start.ref!, name: 'submit_tx', inputs: { txHash } }, c)
  return { a, c, q, start, leg, submit, rpc }
}

describe('mock adapter: solanaLocalChain', () => {
  it('declares one wallet leg on the cluster, with the mint as given, and quotes it 1:1', async () => {
    const { a, ctx } = setup()
    expect(a.legs.map((l) => l.id)).toEqual(['solana-onchain'])
    expect(a.legs[0]).toMatchObject({ methods: ['wallet'], surfaces: ['WALLET_TX'], from: { asset: { chains: { [SOLANA_DEVNET]: [MINT] } } } })
    const q = await a.quote({ leg: legOf(USDC), amountIn: { value: '5', asset: USDC } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q).toMatchObject({ input: { value: '5', asset: USDC }, output: { value: '5', asset: USDC }, fees: [], guarantee: 'firm' })
  })

  it('asks for one SPL transfer to the destination owner, and completes when the chain shows it', async () => {
    const { a, c, start, leg, submit, rpc } = await begin({ tx: splTx({ amount: 5_000_000n }) })
    expect(checkLegStep(start)).toEqual([])
    expect(start.action?.surface).toEqual({ kind: 'WALLET_TX', chain: SOLANA_DEVNET, txs: [{ kind: 'solana', type: 'transfer', to: USER, mint: MINT, amount: '5000000', decimals: 6 }] })
    // A plain chain transfer: no provider order, so no providerRef.
    expect(start.providerRef).toBeUndefined()
    // The leg read the slot at start.
    expect(rpc.calls[0]!.body).toMatchObject({ method: 'getSlot' })
    await expect(a.status!({ leg, ref: start.ref! }, c)).resolves.toMatchObject({ status: 'requires_action', action: { kind: 'payment', surface: { kind: 'WALLET_TX' } } })
    await expect(submit('0xabc')).rejects.toMatchObject({ status: 400 })
    const done = await submit()
    // One transfer on one cluster pays into the leg and delivers it: both roles, one signature.
    expect(done).toMatchObject({
      status: 'succeeded',
      output: { value: '5' },
      transactions: [{ role: 'source', chain: SOLANA_DEVNET, hash: SIG }, { role: 'destination', chain: SOLANA_DEVNET, hash: SIG }],
    })
    expect(rpc.calls.map((x) => (x.body as { method: string }).method)).toEqual(['getSlot', 'getSignatureStatuses', 'getTransaction'])
    expect(rpc.calls[2]!.body).toMatchObject({ params: [SIG, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] })
    await expect(a.status!({ leg, ref: start.ref! }, c)).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('counts a transfer in an inner instruction, and a self-transfer to the payer', async () => {
    await expect((await begin({ tx: splTx({ amount: 5_000_000n, inner: true }) })).submit()).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('waits for an unknown or unconfirmed signature', async () => {
    await expect((await begin({ status: null })).submit()).resolves.toMatchObject({ status: 'processing', detail: { code: 'confirming' }, transactions: [{ role: 'source', hash: SIG }] })
    await expect((await begin({ status: { err: null, confirmationStatus: 'processed' } })).submit()).resolves.toMatchObject({ status: 'processing' })
    await expect((await begin({ tx: null })).submit()).resolves.toMatchObject({ status: 'processing' })
  })

  it('fails a failed, old, short, wrong-mint or wrong-recipient transfer', async () => {
    const run = async (p: Parameters<typeof begin>[0]) => (await begin(p)).submit()
    await expect(run({ status: { err: { InstructionError: [0, 'x'] }, confirmationStatus: 'confirmed' } })).resolves.toMatchObject({ status: 'failed', error: { message: 'The transaction failed on chain.' } })
    await expect(run({ tx: splTx({ amount: 5_000_000n, err: { InstructionError: [0, 'x'] } }) })).resolves.toMatchObject({ status: 'failed', error: { message: 'The transaction failed on chain.' } })
    await expect(run({ tx: splTx({ amount: 5_000_000n, slot: START_SLOT - 1 }) })).resolves.toMatchObject({ status: 'failed', error: { message: /before this payment started/ } })
    await expect(run({ tx: splTx({ amount: 4_999_999n }) })).resolves.toMatchObject({ status: 'failed', error: { message: /quoted amount/ } })
    await expect(run({ tx: splTx({ amount: 5_000_000n, mint: 'So11111111111111111111111111111111111111112' }) })).resolves.toMatchObject({ status: 'failed', error: { message: /quoted amount/ } })
    await expect(run({ tx: splTx({ amount: 5_000_000n, dest: OTHER_ATA, destOwner: OTHER }) })).resolves.toMatchObject({ status: 'failed', error: { message: /quoted amount/ } })
  })

  it('one signature completes one payment only', async () => {
    const shared = memoryKV()
    const tx = splTx({ amount: 5_000_000n })
    const first = await begin({ tx, shared, sessionId: 'ors_one' })
    await expect(first.submit()).resolves.toMatchObject({ status: 'succeeded' })
    // The same session may check again.
    await expect(first.a.status!({ leg: first.leg, ref: first.start.ref! }, first.c)).resolves.toMatchObject({ status: 'succeeded' })
    const second = await begin({ tx, shared, sessionId: 'ors_two' })
    await expect(second.submit()).resolves.toMatchObject({ status: 'failed', error: { message: 'This transaction was already used for another payment.' } })
  })

  it('pays native SOL with a System Program transfer', async () => {
    const tx: SolanaParsedTx = {
      slot: START_SLOT + 1,
      meta: { err: null },
      transaction: { message: { accountKeys: [USER], instructions: [{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: USER, destination: USER, lamports: 10_000_000 } } }] } },
    }
    const { start, submit } = await begin({ mint: 'native', amount: '0.01', tx })
    expect(start.action?.surface).toMatchObject({ txs: [{ kind: 'solana', type: 'transfer', to: USER, mint: 'native', amount: '10000000', decimals: 9 }] })
    await expect(submit()).resolves.toMatchObject({ status: 'succeeded' })
  })
})
