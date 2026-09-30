import { describe, expect, it } from 'vitest'
import { getBase58Decoder, getBase64Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { SOLANA_DEVNET, SOLANA_DEVNET_USDC_MINT, SOLANA_MAINNET, SOLANA_USDC_MINT, SPL_ASSOCIATED_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from '@openrampkit/core'
import type { SolanaTxRequest, TxRequest } from '@openrampkit/core'
import { associatedTokenAddress, isSolanaWallet, solanaWallet, walletStandardChain } from './index.js'

const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const DEST = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const ALT = 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'
const RELAY_PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'
const LOOKED_UP = 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc'

type Sent = { transaction: Uint8Array; chain?: string; account: WalletAccount }

/** A fake Wallet Standard wallet that records what it signs */
function fakeWallet(opts: { signAndSend?: boolean; accounts?: WalletAccount[]; connected?: boolean } = {}) {
  const sent: Sent[] = []
  let n = 0
  const account: WalletAccount = { address: USER, publicKey: new Uint8Array(32), chains: ['solana:mainnet', 'solana:devnet'], features: [] }
  const state = { accounts: opts.connected === false ? [] : (opts.accounts ?? [account]), connects: 0, disconnects: 0 }
  const signature = () => {
    const s = new Uint8Array(64)
    s[0] = ++n
    s[63] = 7
    return s
  }
  const features: Record<string, unknown> = {
    'standard:connect': {
      version: '1.0.0',
      connect: async () => {
        state.connects++
        state.accounts = [account]
        return { accounts: state.accounts }
      },
    },
    'standard:disconnect': { version: '1.0.0', disconnect: async () => void state.disconnects++ },
    'solana:signTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signTransaction: async (...inputs: Sent[]) =>
        inputs.map((i) => {
          sent.push(i)
          const out = new Uint8Array(i.transaction)
          out.set(signature(), 1) // first signature slot
          return { signedTransaction: out }
        }),
    },
  }
  if (opts.signAndSend !== false) {
    features['solana:signAndSendTransaction'] = {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signAndSendTransaction: async (...inputs: Sent[]) =>
        inputs.map((i) => {
          sent.push(i)
          return { signature: signature() }
        }),
    }
  }
  const wallet = {
    version: '1.0.0',
    name: 'Fake',
    icon: 'data:image/svg+xml;base64,AA==',
    chains: ['solana:mainnet', 'solana:devnet'],
    features,
    get accounts() {
      return state.accounts
    },
  } as unknown as Wallet
  return { wallet, sent, state }
}

type RpcCall = { method: string; params: unknown[] }

/** A fake Solana JSON-RPC over fetch */
function fakeRpc(over: Partial<Record<string, (params: unknown[]) => unknown>> = {}) {
  const calls: RpcCall[] = []
  const urls: string[] = []
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } }),
    getAccountInfo: () => ({ value: { owner: SPL_TOKEN_PROGRAM, data: ['', 'base64'] } }),
    getMultipleAccounts: () => ({ value: [{ data: { parsed: { info: { addresses: [LOOKED_UP] } } } }] }),
    getSignatureStatuses: () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }),
    sendTransaction: () => 'sentSig',
    getBalance: () => ({ value: 1_500_000_000 }),
    getTokenAccountsByOwner: () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '12345678' } } } } } }] }),
    ...over,
  }
  const fetch = (async (url: string, init?: RequestInit) => {
    urls.push(String(url))
    const { method, params } = JSON.parse(String(init?.body)) as RpcCall
    calls.push({ method, params })
    const h = handlers[method]
    if (!h) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `no ${method}` } }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: h(params) }))
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls, urls }
}

/** Decode the wire bytes a wallet received */
function decode(bytes: Uint8Array) {
  const tx = getTransactionDecoder().decode(bytes)
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    version: number | string
    staticAccounts: string[]
    lifetimeToken: string
    instructions: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>
    addressTableLookups?: Array<{ lookupTableAddress: string; readonlyIndexes?: number[]; writableIndexes?: number[] }>
  }
  const program = (i: number) => msg.staticAccounts[msg.instructions[i]!.programAddressIndex]
  return { msg, program }
}

const splTransfer = (amount = '12500000'): SolanaTxRequest => ({ kind: 'solana', type: 'transfer', to: DEST, mint: SOLANA_USDC_MINT, amount, decimals: 6 })

describe('solanaWallet', () => {
  it('maps CAIP-2 chains to Wallet Standard chains and detects Solana wallets', () => {
    expect(walletStandardChain(SOLANA_MAINNET)).toBe('solana:mainnet')
    expect(walletStandardChain(SOLANA_DEVNET)).toBe('solana:devnet')
    expect(() => walletStandardChain('eip155:1')).toThrow(/Not a Solana chain/)
    expect(isSolanaWallet(fakeWallet().wallet)).toBe(true)
    expect(isSolanaWallet({ features: {} } as unknown as Wallet)).toBe(false)
  })

  it('lists accounts on its chain; connect and disconnect use the standard features', async () => {
    const f = fakeWallet({ connected: false })
    const w = solanaWallet({ wallet: f.wallet })
    expect(w.id).toBe('solana')
    expect(w.namespaces).toEqual(['solana'])
    expect(await w.getAccounts()).toEqual([])
    expect(await w.connect()).toBe(USER)
    expect(f.state.connects).toBe(1)
    expect(await w.getAccounts()).toEqual([{ chain: SOLANA_MAINNET, address: USER }])
    await w.disconnect()
    expect(f.state.disconnects).toBe(1)
    // an account for another chain is not listed
    const other = fakeWallet({ accounts: [{ address: USER, publicKey: new Uint8Array(32), chains: ['solana:devnet'], features: [] }] })
    expect(await solanaWallet({ wallet: other.wallet }).getAccounts()).toEqual([])
    expect(await solanaWallet({ wallet: other.wallet, chain: SOLANA_DEVNET }).getAccounts()).toEqual([{ chain: SOLANA_DEVNET, address: USER }])
    // no wallet at all (server side: no registered wallets)
    const none = solanaWallet()
    expect(await none.getAccounts()).toEqual([])
    await expect(none.connect()).rejects.toThrow(/No Solana wallet found/)
  })

  it('SPL transfer: creates the recipient token account (idempotent) and sends TransferChecked; returns the base58 signature', async () => {
    const f = fakeWallet()
    const rpc = fakeRpc()
    const w = solanaWallet({ wallet: () => f.wallet, fetch: rpc.fetch })
    const { hash } = await w.sendTransactions(SOLANA_MAINNET, [splTransfer()])
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.chain).toBe('solana:mainnet')
    const { msg, program } = decode(f.sent[0]!.transaction)
    expect(msg.staticAccounts[0]).toBe(USER) // fee payer
    expect(msg.lifetimeToken).toBe(BLOCKHASH)
    expect(msg.instructions).toHaveLength(2)
    expect(program(0)).toBe(SPL_ASSOCIATED_TOKEN_PROGRAM)
    expect([...msg.instructions[0]!.data!]).toEqual([1])
    expect(program(1)).toBe(SPL_TOKEN_PROGRAM)
    const data = msg.instructions[1]!.data!
    expect(data[0]).toBe(12)
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(1, true)).toBe(12_500_000n)
    expect(data[9]).toBe(6)
    // the destination token account is the recipient's ATA
    const destAta = await associatedTokenAddress(DEST, SOLANA_USDC_MINT)
    expect(msg.staticAccounts).toContain(destAta)
    expect(msg.staticAccounts).toContain(await associatedTokenAddress(USER, SOLANA_USDC_MINT))
    const expected = new Uint8Array(64)
    expected[0] = 1
    expected[63] = 7
    expect(hash).toBe(getBase58Decoder().decode(expected))
    expect(rpc.urls[0]).toBe('https://api.mainnet-beta.solana.com')
    expect(rpc.calls.map((c) => c.method)).toEqual(['getAccountInfo', 'getLatestBlockhash'])
  })

  it('SPL transfer of a Token-2022 mint uses the Token-2022 program', async () => {
    const f = fakeWallet()
    const rpc = fakeRpc({ getAccountInfo: () => ({ value: { owner: SPL_TOKEN_2022_PROGRAM } }) })
    await solanaWallet({ wallet: f.wallet, fetch: rpc.fetch }).sendTransactions(SOLANA_MAINNET, [splTransfer()])
    expect(decode(f.sent[0]!.transaction).program(1)).toBe(SPL_TOKEN_2022_PROGRAM)
    // not a mint at all
    const bad = fakeRpc({ getAccountInfo: () => ({ value: { owner: '11111111111111111111111111111111' } }) })
    await expect(solanaWallet({ wallet: f.wallet, fetch: bad.fetch }).sendTransactions(SOLANA_MAINNET, [splTransfer()])).rejects.toThrow(/not an SPL token mint/)
  })

  it('native SOL transfer: one System Program transfer', async () => {
    const f = fakeWallet()
    await solanaWallet({ wallet: f.wallet, fetch: fakeRpc().fetch }).sendTransactions(SOLANA_MAINNET, [{ kind: 'solana', type: 'transfer', to: DEST, mint: 'native', amount: '1500000000', decimals: 9 }])
    const { msg, program } = decode(f.sent[0]!.transaction)
    expect(msg.instructions).toHaveLength(1)
    expect(program(0)).toBe('11111111111111111111111111111111')
    const data = msg.instructions[0]!.data!
    expect(new DataView(data.buffer, data.byteOffset).getUint32(0, true)).toBe(2)
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(4, true)).toBe(1_500_000_000n)
    await expect(solanaWallet({ wallet: f.wallet, fetch: fakeRpc().fetch }).sendTransactions(SOLANA_MAINNET, [{ kind: 'solana', type: 'transfer', to: DEST, mint: 'native', amount: '0', decimals: 9 }])).rejects.toThrow(/positive/)
  })

  it("Relay's instructions: builds a v0 transaction that uses the address lookup table", async () => {
    const f = fakeWallet()
    const rpc = fakeRpc()
    const tx: SolanaTxRequest = {
      kind: 'solana',
      type: 'instructions',
      instructions: [
        {
          programId: RELAY_PROGRAM,
          keys: [
            { pubkey: LOOKED_UP, isSigner: false, isWritable: false },
            { pubkey: USER, isSigner: true, isWritable: true },
          ],
          data: '0x0b9c60da',
        },
      ],
      addressLookupTableAddresses: [ALT],
    }
    await solanaWallet({ wallet: f.wallet, fetch: rpc.fetch }).sendTransactions(SOLANA_MAINNET, [tx])
    const { msg, program } = decode(f.sent[0]!.transaction)
    expect(msg.version).toBe(0)
    expect(program(0)).toBe(RELAY_PROGRAM)
    expect([...msg.instructions[0]!.data!]).toEqual([0x0b, 0x9c, 0x60, 0xda])
    expect(msg.addressTableLookups).toHaveLength(1)
    expect(msg.addressTableLookups![0]!.lookupTableAddress).toBe(ALT)
    // the looked-up account is not a static account any more
    expect(msg.staticAccounts).not.toContain(LOOKED_UP)
    expect(rpc.calls[0]).toEqual({ method: 'getMultipleAccounts', params: [[ALT], { encoding: 'jsonParsed', commitment: 'confirmed' }] })
    // a missing lookup table is an error
    const missing = fakeRpc({ getMultipleAccounts: () => ({ value: [null] }) })
    await expect(solanaWallet({ wallet: f.wallet, fetch: missing.fetch }).sendTransactions(SOLANA_MAINNET, [tx])).rejects.toThrow(/lookup table/)
  })

  it('a serialized transaction goes to the wallet as is', async () => {
    const f = fakeWallet()
    const rpc = fakeRpc()
    const w = solanaWallet({ wallet: f.wallet, fetch: rpc.fetch })
    const built = await w.buildTransaction(splTransfer(), USER)
    const b64 = getBase64Decoder().decode(built)
    await w.sendTransactions(SOLANA_MAINNET, [{ kind: 'solana', type: 'transaction', transaction: b64 }])
    expect([...f.sent[0]!.transaction]).toEqual([...built])
  })

  it('without signAndSendTransaction: signs with the wallet and sends through the RPC', async () => {
    const f = fakeWallet({ signAndSend: false })
    const rpc = fakeRpc()
    const { hash } = await solanaWallet({ wallet: f.wallet, fetch: rpc.fetch, rpcUrl: 'https://rpc.example' }).sendTransactions(SOLANA_MAINNET, [splTransfer()])
    expect(hash).toBe('sentSig')
    const send = rpc.calls.find((c) => c.method === 'sendTransaction')!
    expect(send.params[1]).toEqual({ encoding: 'base64', preflightCommitment: 'confirmed' })
    expect(rpc.urls.every((u) => u === 'https://rpc.example')).toBe(true)
  })

  it('several transactions: waits for each to confirm before the next; a failed one stops the chain', async () => {
    const f = fakeWallet()
    const rpc = fakeRpc()
    await solanaWallet({ wallet: f.wallet, fetch: rpc.fetch }).sendTransactions(SOLANA_MAINNET, [splTransfer('1'), splTransfer('2')])
    expect(f.sent).toHaveLength(2)
    expect(rpc.calls.filter((c) => c.method === 'getSignatureStatuses')).toHaveLength(1)
    // waitForLast confirms the last one too
    const rpc2 = fakeRpc()
    await solanaWallet({ wallet: f.wallet, fetch: rpc2.fetch, waitForLast: true }).sendTransactions(SOLANA_MAINNET, [splTransfer('1')])
    expect(rpc2.calls.filter((c) => c.method === 'getSignatureStatuses')).toHaveLength(1)
    const failing = fakeRpc({ getSignatureStatuses: () => ({ value: [{ err: { InstructionError: [0, 'x'] }, confirmationStatus: 'confirmed' }] }) })
    const f2 = fakeWallet()
    await expect(solanaWallet({ wallet: f2.wallet, fetch: failing.fetch }).sendTransactions(SOLANA_MAINNET, [splTransfer('1'), splTransfer('2')])).rejects.toThrow(/failed on chain/)
    expect(f2.sent).toHaveLength(1)
    // not confirmed in time
    const slow = fakeRpc({ getSignatureStatuses: () => ({ value: [null] }) })
    await expect(solanaWallet({ wallet: fakeWallet().wallet, fetch: slow.fetch, waitForLast: true, confirmTimeoutMs: 0 }).sendTransactions(SOLANA_MAINNET, [splTransfer('1')])).rejects.toThrow(/not confirmed in time/)
  })

  it('refuses EVM transactions, another chain, an empty list and a wallet with no account', async () => {
    const f = fakeWallet()
    const w = solanaWallet({ wallet: f.wallet, fetch: fakeRpc().fetch })
    const evm: TxRequest = { to: '0x0000000000000000000000000000000000000001', chainId: 8453 }
    await expect(w.sendTransactions(SOLANA_MAINNET, [evm])).rejects.toThrow(/Solana transactions only/)
    await expect(w.sendTransactions('eip155:8453', [splTransfer()])).rejects.toThrow(/set up for/)
    await expect(w.switchChain!('eip155:8453')).rejects.toThrow(/set up for/)
    await expect(w.switchChain!(SOLANA_MAINNET)).resolves.toBeUndefined()
    await expect(w.sendTransactions(SOLANA_MAINNET, [])).rejects.toThrow(/No transactions/)
    const empty = fakeWallet({ connected: false })
    await expect(solanaWallet({ wallet: empty.wallet }).sendTransactions(SOLANA_MAINNET, [splTransfer()])).rejects.toThrow(/Connect your Solana wallet/)
    const rpcError = fakeRpc({ getAccountInfo: undefined })
    await expect(solanaWallet({ wallet: f.wallet, fetch: rpcError.fetch }).sendTransactions(SOLANA_MAINNET, [splTransfer()])).rejects.toThrow(/getAccountInfo/)
  })

  it('balances: SOL and USDC (devnet USDC on devnet); one failing call does not hide the others', async () => {
    const rpc = fakeRpc()
    const w = solanaWallet({ wallet: fakeWallet().wallet, fetch: rpc.fetch, tokens: [{ mint: SOLANA_USDC_MINT, symbol: 'USDC', decimals: 6 }] })
    const b = await w.getBalances!([{ chain: SOLANA_MAINNET, address: USER }, { chain: 'eip155:1', address: '0x1' }])
    expect(b).toEqual([
      { chain: SOLANA_MAINNET, token: 'native', symbol: 'SOL', decimals: 9, amount: '1.5' },
      { chain: SOLANA_MAINNET, token: SOLANA_USDC_MINT, symbol: 'USDC', decimals: 6, amount: '12.345678', usd: '12.345678' },
    ])
    const tokenCall = rpc.calls.find((c) => c.method === 'getTokenAccountsByOwner')!
    expect(tokenCall.params.slice(0, 2)).toEqual([USER, { mint: SOLANA_USDC_MINT }])
    const dev = fakeRpc({ getBalance: () => { throw new Error('down') } })
    const devBalances = await solanaWallet({ wallet: fakeWallet().wallet, fetch: dev.fetch, chain: SOLANA_DEVNET }).getBalances!([{ chain: SOLANA_DEVNET, address: USER }])
    expect(devBalances).toEqual([{ chain: SOLANA_DEVNET, token: SOLANA_DEVNET_USDC_MINT, symbol: 'USDC', decimals: 6, amount: '12.345678', usd: '12.345678' }])
    expect(dev.urls[0]).toBe('https://api.devnet.solana.com')
  })
})
