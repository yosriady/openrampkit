// Real-chain end to end: the server, the client controller and the real wagmi adapter against a local
// Anvil chain. The WALLET_TX leg sends a real ERC-20 transfer, and the mock adapter's `localChain` leg
// checks the receipt over JSON-RPC. Skipped when `anvil` (Foundry) is not on PATH, unless
// OPENRAMP_REQUIRE_ANVIL=1 (set on CI, so a missing anvil fails the job).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, createConfig, disconnect, http, mock } from '@wagmi/core'
import type { Config } from '@wagmi/core'
import { defineChain } from 'viem'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { DepositController, createOpenRampClient } from '@openrampkit/client'
import { createOpenRamp } from '@openrampkit/server'
import { wagmiWallet } from './index.js'
import { ANVIL_ACCOUNT, ANVIL_CHAIN, ANVIL_CHAIN_ID, erc20BalanceOf, hasAnvil, rpc, sendAndWait, startTestChain } from './testchain.js'
import type { TestChain } from './testchain.js'

const BASE = 'http://localhost/api/openramp'
const RECIPIENT = '0x000000000000000000000000000000000000bEEF'
const USDC_UNIT = 1_000_000n

async function waitFor(fn: () => boolean, ms = 15_000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor: timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.skipIf(!hasAnvil() && process.env.OPENRAMP_REQUIRE_ANVIL !== '1')('local Anvil chain: WALLET_TX with a real transaction', () => {
  let chain: TestChain
  let config: Config

  function setup() {
    const ramp = createOpenRamp({
      secret: 'test-secret-test-secret-test-secret-123',
      baseUrl: BASE,
      adapters: [mockAdapter({ settleMs: 0, localChain: { chain: ANVIL_CHAIN, rpcUrl: chain.rpcUrl, token: chain.usdc } })],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    const fetch: typeof globalThis.fetch = async (input, init) => ramp.handle(new Request(String(input), init))
    return { ramp, client: createOpenRampClient({ baseUrl: BASE, fetch }) }
  }

  const destination = () => ({ type: 'crypto' as const, chain: ANVIL_CHAIN, token: chain.usdc, symbol: 'USDC', decimals: 6, address: RECIPIENT })

  beforeAll(async () => {
    chain = await startTestChain({ mintTo: ANVIL_ACCOUNT, mintAmount: 1000n * USDC_UNIT })
    const local = defineChain({
      id: ANVIL_CHAIN_ID,
      name: 'Anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [chain.rpcUrl] } },
    })
    // The wagmi mock connector sends eth_sendTransaction to the chain RPC; Anvil signs with its unlocked dev account.
    config = createConfig({ chains: [local], connectors: [mock({ accounts: [ANVIL_ACCOUNT] })], transports: { [local.id]: http(chain.rpcUrl) } })
    await connect(config, { connector: config.connectors[0]! })
  }, 30_000)

  afterAll(async () => {
    if (config) await disconnect(config).catch(() => {})
    await chain?.stop()
  })

  it('deposit: plan, quote, select, pay with a real ERC-20 transfer, then COMPLETED', async () => {
    const { ramp, client } = setup()
    const wagmi = wagmiWallet(config, { tokens: { [ANVIL_CHAIN]: [{ address: chain.usdc, symbol: 'USDC', decimals: 6 }] } })
    const sent: string[] = []
    const wallet = { ...wagmi, sendTransactions: async (...args: Parameters<typeof wagmi.sendTransactions>) => {
      const r = await wagmi.sendTransactions(...args)
      sent.push(r.hash)
      return r
    } }
    const senderBefore = await erc20BalanceOf(chain.rpcUrl, chain.usdc, ANVIL_ACCOUNT)
    const recipientBefore = await erc20BalanceOf(chain.rpcUrl, chain.usdc, RECIPIENT)

    const s = await ramp.sessions.create({ userId: 'anvil-user', country: 'US', destination: destination() })
    const c = new DepositController({ client, clientSecret: s.clientSecret, wallet })
    await c.start()
    expect(c.getSnapshot().walletAddress?.toLowerCase()).toBe(ANVIL_ACCOUNT.toLowerCase())
    // The wagmi adapter read the mock USDC balance from the chain.
    expect(c.getSnapshot().balances).toContainEqual(expect.objectContaining({ chain: ANVIL_CHAIN, token: chain.usdc, symbol: 'USDC', amount: '1000' }))
    expect(c.getSnapshot().plan!.methods.map((m) => m.method)).toContain('wallet')

    await c.selectMethod('wallet')
    c.setSource({ chain: ANVIL_CHAIN, token: chain.usdc, symbol: 'USDC', decimals: 6 })
    if (c.getSnapshot().screen === 'amount') {
      c.setAmount('25')
      await c.submitAmount()
    }
    await waitFor(() => !c.getSnapshot().quotesLoading && c.getSnapshot().quotes.length > 0)
    expect(c.getSnapshot().quotes[0]).toMatchObject({ output: { amount: '25' } })
    await c.confirm()
    const surface = c.getSnapshot().session!.step.surface!
    expect(surface).toMatchObject({ kind: 'WALLET_TX', chain: ANVIL_CHAIN })

    // The real wagmi adapter sends the transfer to Anvil, then the controller reports the hash.
    await c.sendWalletTransactions()
    await waitFor(() => c.getSnapshot().screen === 'result')
    const done = await c.done
    expect(done.step.state).toBe('COMPLETED')
    expect(sent).toHaveLength(1)
    expect(done.step.progress?.legs[0]).toMatchObject({ legId: 'onchain', status: 'succeeded', txHash: sent[0] })

    // A sweep refreshes open sessions; this one is already final.
    await ramp.sweep()
    expect((await client.getSession(s.clientSecret)).step.state).toBe('COMPLETED')

    // The money moved on chain.
    expect(await erc20BalanceOf(chain.rpcUrl, chain.usdc, ANVIL_ACCOUNT)).toBe(senderBefore - 25n * USDC_UNIT)
    expect(await erc20BalanceOf(chain.rpcUrl, chain.usdc, RECIPIENT)).toBe(recipientBefore + 25n * USDC_UNIT)
    c.destroy()
  }, 30_000)

  it('a transaction still in the mempool stays PROCESSING until a sweep sees it mined', async () => {
    const { ramp, client } = setup()
    const wallet = wagmiWallet(config)
    const s = await ramp.sessions.create({ userId: 'anvil-user-3', country: 'US', destination: destination() })
    await client.plan(s.clientSecret, { walletConnected: true, walletAddress: ANVIL_ACCOUNT })
    const q = await client.quotes(s.clientSecret, { method: 'wallet', amount: '5', amountSide: 'source', source: { chain: ANVIL_CHAIN, token: chain.usdc } })
    const paying = await client.select(s.clientSecret, { quoteId: q.quotes[0]!.id, walletAddress: ANVIL_ACCOUNT })
    const surface = paying.step.surface!
    if (surface.kind !== 'WALLET_TX') throw new Error(`Expected WALLET_TX, got ${surface.kind}`)
    const recipientBefore = await erc20BalanceOf(chain.rpcUrl, chain.usdc, RECIPIENT)

    await rpc(chain.rpcUrl, 'evm_setAutomine', [false])
    try {
      const { hash } = await wallet.sendTransactions(surface.chain, surface.txs)
      const pending = await client.transition(s.clientSecret, 'submit_tx', { txHash: hash })
      expect(pending.step.state).toBe('PROCESSING')
      await ramp.sweep()
      expect((await client.getSession(s.clientSecret)).step.state).toBe('PROCESSING')

      await rpc(chain.rpcUrl, 'evm_mine')
      const swept = await ramp.sweep()
      expect(swept.sessions.changed).toBeGreaterThanOrEqual(1)
      const final = await client.getSession(s.clientSecret)
      expect(final.step.state).toBe('COMPLETED')
      expect(final.step.progress?.legs[0]?.txHash).toBe(hash)
    } finally {
      await rpc(chain.rpcUrl, 'evm_setAutomine', [true])
    }
    expect(await erc20BalanceOf(chain.rpcUrl, chain.usdc, RECIPIENT)).toBe(recipientBefore + 5n * USDC_UNIT)
  }, 30_000)

  it('a hash that does not pay the destination fails the payment', async () => {
    const { ramp, client } = setup()
    const s = await ramp.sessions.create({ userId: 'anvil-user-2', country: 'US', destination: destination() })
    await client.plan(s.clientSecret, { walletConnected: true, walletAddress: ANVIL_ACCOUNT })
    const q = await client.quotes(s.clientSecret, { method: 'wallet', amount: '10', amountSide: 'source', source: { chain: ANVIL_CHAIN, token: chain.usdc } })
    const paying = await client.select(s.clientSecret, { quoteId: q.quotes[0]!.id, walletAddress: ANVIL_ACCOUNT })
    expect(paying.step.surface?.kind).toBe('WALLET_TX')

    // A real, successful transaction, but one that sends the token to someone else.
    const other = await sendAndWait(chain.rpcUrl, {
      to: chain.usdc,
      data: `0xa9059cbb${'00'.repeat(12)}${'11'.repeat(20)}${(10n * USDC_UNIT).toString(16).padStart(64, '0')}`,
    })
    const after = await client.transition(s.clientSecret, 'submit_tx', { txHash: other.transactionHash })
    expect(after.step.state).toBe('FAILED')
    expect(after.step.error?.message).toMatch(/does not pay the destination/)
  }, 30_000)
})
