// Solana devnet in the playground, end to end in Node: the real server, the mock adapter's
// `solanaLocalChain` leg, the real `solanaWallet` with a fake Wallet Standard wallet, and a fake
// devnet JSON-RPC behind `fetch` that runs the SPL transfer that the wallet signed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { createOpenRampClient } from '@openrampkit/client'
import { SPL_TOKEN_PROGRAM } from '@openrampkit/core'
import type { WalletAdapter } from '@openrampkit/core'
import { associatedTokenAddress, solanaWallet } from '@openrampkit/solana'
import { DEFAULT_NETWORKS, DEVNET_BANNER, SOLANA_DEVNET_CONFIG, solanaTxLink } from './config.js'
import { createTestnetServer, solanaAdapter } from './server.js'
import { MIN_FEE_LAMPORTS, accountOnDevnet, friendlySolanaError, guardSolanaWallet, signOnly, solanaSessionInput } from './solana.js'

const cfg = SOLANA_DEVNET_CONFIG
const MINT = cfg.token.mint
const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const BASE_URL = 'https://playground.openrampkit.invalid/api/openramp'
const ctx = { symbol: 'USDC', faucet: cfg.token.faucet, gasFaucet: cfg.gasFaucet }

/** A fake Wallet Standard wallet: it signs (one fake signature) and records what it signed */
function fakeWallet(opts: { reject?: boolean; chains?: string[] } = {}) {
  const signed: Uint8Array[] = []
  const account: WalletAccount = { address: USER, publicKey: new Uint8Array(32), chains: (opts.chains ?? ['solana:mainnet', 'solana:devnet']) as WalletAccount['chains'], features: [] }
  let n = 0
  const wallet = {
    version: '1.0.0',
    name: 'Fake Wallet',
    icon: 'data:image/svg+xml;base64,AA==',
    chains: ['solana:devnet'],
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) => {
          if (opts.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
          return inputs.map((i) => {
            signed.push(i.transaction)
            const out = new Uint8Array(i.transaction)
            out.fill(++n, 1, 65) // the first signature slot
            return { signedTransaction: out }
          })
        },
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async () => {
          throw new Error('signOnly must hide signAndSendTransaction')
        },
      },
    },
  } as unknown as Wallet
  return { wallet, signed }
}

type Sent = { signature: string; dest: string; amount: bigint; slot: number }

/** A fake devnet RPC: it "runs" each sent SPL TransferChecked and serves it back as a parsed transaction */
function fakeDevnet(opts: { lamports?: number; tokenAccounts?: number; tokenAmount?: bigint } = {}) {
  let slot = 5000
  const sent: Sent[] = []
  const methods: string[] = []
  const passed = new Set<string>()
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    passed.add(req.url)
    if (req.url !== new URL(cfg.rpcUrl).href) return new Response('not here', { status: 404 })
    const { method, params } = (await req.json()) as { method: string; params: unknown[] }
    methods.push(method)
    let result: unknown = null
    switch (method) {
      case 'getSlot':
        result = slot
        break
      case 'getLatestBlockhash':
        result = { context: { slot }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 9999 } }
        break
      case 'getAccountInfo':
        result = { value: { owner: SPL_TOKEN_PROGRAM, data: ['', 'base64'] } }
        break
      case 'getBalance':
        result = { value: opts.lamports ?? 2_000_000_000 }
        break
      case 'getTokenAccountsByOwner': {
        const accounts = opts.tokenAccounts ?? 1
        result = { value: Array.from({ length: accounts }, () => ({ pubkey: 'x', account: { data: { parsed: { info: { tokenAmount: { amount: String(opts.tokenAmount ?? 20_000_000n) } } } } } })) }
        break
      }
      case 'sendTransaction': {
        const bytes = Uint8Array.from(atob(params[0] as string), (c) => c.charCodeAt(0))
        const tx = getTransactionDecoder().decode(bytes)
        const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
          staticAccounts: string[]
          instructions: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>
        }
        const ix = msg.instructions.find((i) => msg.staticAccounts[i.programAddressIndex] === SPL_TOKEN_PROGRAM && i.data?.[0] === 12)!
        const amount = new DataView(ix.data!.buffer, ix.data!.byteOffset).getBigUint64(1, true)
        const signature = getBase58Decoder().decode(Object.values(tx.signatures)[0] as Uint8Array)
        sent.push({ signature, dest: msg.staticAccounts[ix.accountIndices![2]!]!, amount, slot: ++slot })
        result = signature
        break
      }
      case 'getSignatureStatuses': {
        const s = sent.find((x) => x.signature === (params[0] as string[])[0])
        result = { value: [s ? { slot: s.slot, err: null, confirmationStatus: 'confirmed' } : null] }
        break
      }
      case 'getTransaction': {
        const s = sent.find((x) => x.signature === params[0])
        if (s) {
          const ata = await associatedTokenAddress(USER, MINT)
          const bal = (amount: string) => [{ accountIndex: 1, mint: MINT, owner: USER, uiTokenAmount: { amount } }]
          result = {
            slot: s.slot,
            blockTime: 1_800_000_000,
            meta: { err: null, preTokenBalances: bal('20000000'), postTokenBalances: bal('20000000'), innerInstructions: [] },
            transaction: {
              message: {
                accountKeys: [{ pubkey: USER }, { pubkey: ata }, { pubkey: MINT }],
                instructions: [{ program: 'spl-token', programId: SPL_TOKEN_PROGRAM, parsed: { type: 'transferChecked', info: { source: ata, destination: s.dest, mint: MINT, authority: USER, tokenAmount: { amount: s.amount.toString(), decimals: 6 } } } }],
              },
            },
          }
        }
        break
      }
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result })
  })
  return { sent, methods, passed }
}

/** The page's wallet: solanaWallet over the fake wallet (sign only), guarded for devnet USDC */
function pageWallet(w: Wallet, read: { lamports?: bigint; accounts?: number; amount?: bigint } = {}): WalletAdapter {
  const base = solanaWallet({ wallet: signOnly(w), chain: cfg.chain, rpcUrl: cfg.rpcUrl, waitForLast: true, confirmTimeoutMs: 2000 })
  return guardSolanaWallet(base, {
    chain: cfg.chain,
    token: cfg.token,
    gasFaucet: cfg.gasFaucet,
    readSol: async () => read.lamports ?? 2_000_000_000n,
    readToken: async () => ({ accounts: read.accounts ?? 1, amount: read.amount ?? 20_000_000n }),
  })
}

afterEach(() => vi.unstubAllGlobals())

async function payOnce(server: ReturnType<typeof createTestnetServer>, wallet: WalletAdapter, amount = '5') {
  const client = createOpenRampClient({ baseUrl: BASE_URL, fetch: server.fakeFetch })
  const { clientSecret, id } = await server.openramp.sessions.create(solanaSessionInput(cfg, USER))
  const plan = await client.plan(clientSecret, { walletConnected: true, walletAddress: USER })
  expect(plan.methods.map((m) => m.method)).toEqual(['wallet'])
  const q = await client.quotes(clientSecret, { method: 'wallet', amount, amountSide: 'source', source: { chain: cfg.chain, token: MINT } })
  expect(q.quotes).toHaveLength(1)
  const paying = await client.select(clientSecret, { quoteId: q.quotes[0]!.id, walletAddress: USER })
  const surface = paying.step.surface!
  if (surface.kind !== 'WALLET_TX') throw new Error(`Expected WALLET_TX, got ${surface.kind}`)
  return { client, clientSecret, id, surface }
}

describe('Solana devnet in testnet mode', () => {
  it('has the devnet chain, mint, faucets, banner and explorer link', () => {
    expect(cfg).toMatchObject({ chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', rpcUrl: 'https://api.devnet.solana.com', gasFaucet: 'https://faucet.solana.com/' })
    expect(cfg.token).toMatchObject({ mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', symbol: 'USDC', decimals: 6, faucet: 'https://faucet.circle.com/' })
    expect(DEVNET_BANNER).toBe('Devnet: real transactions on Solana devnet, test tokens with no value.')
    expect(solanaTxLink(cfg, 'abc')).toBe('https://explorer.solana.com/tx/abc?cluster=devnet')
    expect(solanaAdapter(cfg).legs.map((l) => l.id)).toEqual(['solana-onchain'])
  })

  it('signOnly hides signAndSendTransaction, keeps the accounts live, and leaves sign-only wallets alone', () => {
    const { wallet } = fakeWallet()
    const w = signOnly(wallet)
    expect(Object.keys(w.features)).toEqual(['standard:connect', 'solana:signTransaction'])
    expect(w.accounts[0]!.address).toBe(USER)
    expect(w.name).toBe('Fake Wallet')
    expect(signOnly(w)).toBe(w)
    expect(accountOnDevnet({ chains: ['solana:mainnet'] })).toBe(false)
    expect(accountOnDevnet({ chains: ['solana:devnet'] })).toBe(true)
    expect(accountOnDevnet({ chains: [] })).toBe(true)
  })

  it('pays devnet USDC to the wallet itself, and the server completes it from the chain', async () => {
    const chain = fakeDevnet()
    const server = createTestnetServer(DEFAULT_NETWORKS, cfg)
    const { wallet, signed } = fakeWallet()
    const w = pageWallet(wallet)
    const { client, clientSecret, surface } = await payOnce(server, w)
    expect(surface).toEqual({ kind: 'WALLET_TX', chain: cfg.chain, txs: [{ kind: 'solana', type: 'transfer', to: USER, mint: MINT, amount: '5000000', decimals: 6 }] })

    const { hash } = await w.sendTransactions(surface.chain, surface.txs)
    expect(signed).toHaveLength(1)
    expect(chain.sent).toEqual([expect.objectContaining({ signature: hash, amount: 5_000_000n, dest: await associatedTokenAddress(USER, MINT) })])
    const done = await client.transition(clientSecret, 'submit_tx', { txHash: hash })
    expect(done.step.state).toBe('COMPLETED')
    expect(done.payment?.legs[0]).toMatchObject({ legId: 'solana-onchain', status: 'succeeded', transactions: [{ role: 'source', chain: cfg.chain, hash }, { role: 'destination', chain: cfg.chain, hash }] })
    expect(chain.methods).toEqual(expect.arrayContaining(['getSlot', 'getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses', 'getTransaction']))
    // Only the devnet RPC left the page.
    expect([...chain.passed]).toEqual([new URL(cfg.rpcUrl).href])

    // The same signature cannot pay a second session.
    const again = await payOnce(server, w)
    const reused = await again.client.transition(again.clientSecret, 'submit_tx', { txHash: hash })
    expect(reused.step.state).toBe('FAILED')
    expect(reused.step.error?.message).toBe('This transaction was already used for another payment.')
  })

  it('the guard stops before the wallet opens: no token account, low balance, low SOL', async () => {
    fakeDevnet()
    const server = createTestnetServer(DEFAULT_NETWORKS, cfg)
    const { wallet, signed } = fakeWallet()
    const { surface } = await payOnce(server, pageWallet(wallet))
    const send = (read: Parameters<typeof pageWallet>[1]) => pageWallet(wallet, read).sendTransactions(surface.chain, surface.txs)
    await expect(send({ accounts: 0, amount: 0n })).rejects.toMatchObject({ message: /no devnet USDC token account yet.*faucet\.circle\.com/ })
    await expect(send({ amount: 1_000_000n })).rejects.toMatchObject({ message: 'Not enough USDC. You have 1, and this payment needs 5. Get devnet USDC at https://faucet.circle.com/' })
    await expect(send({ lamports: MIN_FEE_LAMPORTS - 1n })).rejects.toMatchObject({ message: /Not enough devnet SOL for fees. You have 0\.000999999 SOL\. Get devnet SOL at https:\/\/faucet\.solana\.com\// })
    expect(signed).toHaveLength(0)
  })

  it('a rejected request gives a short message and sends nothing', async () => {
    const chain = fakeDevnet()
    const server = createTestnetServer(DEFAULT_NETWORKS, cfg)
    const { wallet } = fakeWallet({ reject: true })
    const w = pageWallet(wallet)
    const { surface } = await payOnce(server, w)
    await expect(w.sendTransactions(surface.chain, surface.txs)).rejects.toMatchObject({ message: 'You rejected the request in your wallet. Nothing was sent.' })
    expect(chain.sent).toEqual([])
  })

  it('reports only devnet USDC as a balance, and only devnet accounts', async () => {
    fakeDevnet()
    const { wallet } = fakeWallet()
    const w = pageWallet(wallet)
    const accounts = await w.getAccounts()
    expect(accounts).toEqual([{ chain: cfg.chain, address: USER }])
    expect(await w.getBalances!(accounts)).toEqual([expect.objectContaining({ chain: cfg.chain, token: MINT, symbol: 'USDC', amount: '20' })])
    // A wallet account that is not on devnet is not listed.
    expect(await pageWallet(fakeWallet({ chains: ['solana:mainnet'] }).wallet).getAccounts()).toEqual([])
  })
})

describe('friendlySolanaError', () => {
  it('maps wallet and RPC errors to short messages', () => {
    expect(friendlySolanaError(Object.assign(new Error('x'), { code: 4001 }), ctx)).toBe('You rejected the request in your wallet. Nothing was sent.')
    expect(friendlySolanaError(new Error('Approval Denied'), ctx)).toMatch(/You rejected/)
    expect(friendlySolanaError(new Error('Solana RPC sendTransaction: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.'), ctx)).toBe(
      'Not enough devnet SOL for fees. Get devnet SOL at https://faucet.solana.com/, then try again.',
    )
    expect(friendlySolanaError(new Error('Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1'), ctx)).toBe('Not enough USDC in your wallet for this amount.')
    expect(friendlySolanaError(new Error('Transaction simulation failed: Blockhash not found'), ctx)).toMatch(/another Solana network. Switch your wallet to Devnet/)
    expect(friendlySolanaError(new Error('AccountNotFound'), ctx)).toMatch(/no devnet USDC token account yet/)
    expect(friendlySolanaError(new Error('Transaction abc was not confirmed in time'), ctx)).toMatch(/not confirmed in time/)
    expect(friendlySolanaError(new Error('Something else\nwith details'), ctx)).toBe('Something else')
    expect(friendlySolanaError(undefined, ctx)).toBe('The wallet could not send the transaction.')
  })
})
