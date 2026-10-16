// Gas abstraction in the controller: when to ask for it (`FlowOptions.gasless`) and the WALLET_SIGN surface.
import { describe, expect, it, vi } from 'vitest'
import { USDC } from '@openrampkit/core'
import type { PublicSession, WalletBalance } from '@openrampkit/core'
import { DepositController, createMockWallet } from './index.js'
import type { ControllerOptions, FlowOptions } from './index.js'
import { fakeClient, session, step } from './testctx.js'

const BASE_USDC = USDC['eip155:8453']!
const usdcOnBase: WalletBalance = { chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6, amount: '40', usd: '40' }
const eth = (amount: string): WalletBalance => ({ chain: 'eip155:8453', token: 'native', symbol: 'ETH', decimals: 18, amount })

/** Confirm a wallet deposit of 10 USDC on Base; returns the `select` body */
async function confirmWallet(opts: { balances?: WalletBalance[]; canSign?: boolean; gasless?: FlowOptions['gasless']; surfaces?: string[]; source?: { chain: string; token: string } } = {}) {
  const client = fakeClient()
  const wallet = createMockWallet({ delayMs: 0, canSign: opts.canSign ?? true, balances: opts.balances ?? [usdcOnBase, eth('0')] })
  const c = new DepositController({
    client,
    clientSecret: 'ors_1.sig',
    wallet,
    ...(opts.gasless ? { flow: { gasless: opts.gasless } } : {}),
    ...(opts.surfaces ? { surfaces: opts.surfaces } : {}),
  } as ControllerOptions)
  await c.start()
  await c.selectMethod('wallet')
  c.setSource(opts.source ?? { chain: 'eip155:8453', token: BASE_USDC })
  c.setAmount('10')
  await c.submitAmount()
  await c.confirm()
  c.destroy()
  return client.select.mock.calls.at(-1)![1] as { quoteId: string; walletAddress?: string; gasless?: boolean }
}

describe('gas abstraction: when the controller asks for it', () => {
  it('auto: asks when the wallet reports zero native gas on the source chain', async () => {
    expect((await confirmWallet()).gasless).toBe(true)
  })

  it('auto: not with gas, or when the wallet did not report a native balance', async () => {
    expect((await confirmWallet({ balances: [usdcOnBase, eth('0.002')] })).gasless).toBeUndefined()
    expect((await confirmWallet({ balances: [usdcOnBase] })).gasless).toBeUndefined()
  })

  it('always: asks even with gas; never: never asks', async () => {
    expect((await confirmWallet({ balances: [usdcOnBase, eth('1')], gasless: 'always' })).gasless).toBe(true)
    expect((await confirmWallet({ gasless: 'never' })).gasless).toBeUndefined()
  })

  it('not for a wallet that cannot sign, a UI without WALLET_SIGN, a native source or a non-EVM chain', async () => {
    expect((await confirmWallet({ canSign: false })).gasless).toBeUndefined()
    expect((await confirmWallet({ surfaces: ['WALLET_TX'] })).gasless).toBeUndefined()
    expect((await confirmWallet({ surfaces: ['WALLET_TX', 'WALLET_SIGN'] })).gasless).toBe(true)
    expect((await confirmWallet({ gasless: 'always', source: { chain: 'eip155:8453', token: 'native' } })).gasless).toBeUndefined()
    // Tempo pays fees in stablecoins: there is no native gas to miss.
    expect((await confirmWallet({ gasless: 'always', source: { chain: 'eip155:4217', token: '0x20c000000000000000000000b9537d11c60e8b50' } })).gasless).toBeUndefined()
  })
})

describe('gas abstraction: the WALLET_SIGN surface', () => {
  const typed = (n: number) => ({ domain: { name: 'T', chainId: 8453 }, types: { M: [{ name: 'n', type: 'uint256' }] }, primaryType: 'M', message: { n } })
  const signSurface = session(
    step({
      state: 'PAYMENT',
      surface: { kind: 'WALLET_SIGN', chain: 'eip155:8453', address: '0x1111111111111111111111111111111111111111', signatures: [typed(1), typed(2)] },
      transitions: [{ name: 'submit_signatures', kind: 'SURFACE_RESULT', expects: 'signatures' }],
    }),
  ) as PublicSession

  async function atSign(wallet: ControllerOptions['wallet']) {
    const client = fakeClient({ select: vi.fn(async () => signSurface) })
    const c = new DepositController({ client, clientSecret: 'ors_1.sig', ...(wallet ? { wallet } : {}) })
    await c.start()
    await c.selectMethod('card')
    c.setAmount('100')
    await c.submitAmount()
    await c.confirm()
    return { c, client }
  }

  it('signs each message in order and reports the signatures', async () => {
    const wallet = createMockWallet({ delayMs: 0, canSign: true })
    const { c, client } = await atSign(wallet)
    await c.signWalletMessages()
    expect(wallet.signed.map((s) => s.data.message)).toEqual([{ n: 1 }, { n: 2 }])
    expect(wallet.signed.every((s) => s.chain === 'eip155:8453')).toBe(true)
    expect(wallet.sent).toHaveLength(0)
    expect(client.transition).toHaveBeenCalledWith('ors_1.sig', 'submit_signatures', { signatures: wallet.signed.map((s) => s.signature) })
    c.destroy()
  })

  it('a wallet that cannot sign shows an error; a refused signature shows the wallet error', async () => {
    const plain = await atSign(createMockWallet({ delayMs: 0 }))
    await plain.c.signWalletMessages()
    expect(plain.c.getSnapshot().error).toMatchObject({ code: 'BAD_REQUEST', message: 'This wallet cannot sign messages.' })
    const none = await atSign(undefined)
    await none.c.signWalletMessages()
    expect(none.c.getSnapshot().error).toMatchObject({ message: 'No wallet is connected.' })
    const refusing = createMockWallet({ delayMs: 0, canSign: true })
    refusing.signTypedData = async () => {
      throw new Error('User rejected the request.')
    }
    const r = await atSign(refusing)
    await r.c.signWalletMessages()
    expect(r.c.getSnapshot()).toMatchObject({ busy: false, error: { message: 'User rejected the request.' } })
    expect(r.client.transition).not.toHaveBeenCalled()
  })

  it('does nothing on another surface', async () => {
    const wallet = createMockWallet({ delayMs: 0, canSign: true })
    const client = fakeClient()
    const c = new DepositController({ client, clientSecret: 'ors_1.sig', wallet })
    await c.start()
    await c.signWalletMessages()
    expect(wallet.signed).toHaveLength(0)
    c.destroy()
  })
})
