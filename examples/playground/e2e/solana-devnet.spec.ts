// Testnet mode on Solana devnet, with a fake Wallet Standard wallet injected into the page and a fake
// devnet JSON-RPC (a Playwright route). The widget, @openrampkit/solana, the in-page server and the
// mock adapter's `solanaLocalChain` leg run as they do with Phantom on devnet. The fake RPC "runs" the
// SPL transfer that the wallet signed and serves it back as a parsed transaction for the server check.

import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'
import { associatedTokenAddress } from '../../../packages/solana/src/index.ts'

const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const RPC_PATH = '/__fake-devnet-rpc'

type Chain = { lamports: number; tokenAccounts: number; tokenAmount: bigint }
type Sent = { signature: string; dest: string; amount: bigint; slot: number }

/** The fake devnet RPC. It answers what the wallet adapter, the page and the server ask. */
async function fakeDevnet(page: Page, chain: Chain) {
  let slot = 7000
  const sent: Sent[] = []
  const ata = await associatedTokenAddress(USER, MINT)
  await page.route(`**${RPC_PATH}`, async (route: Route) => {
    const { method, params } = route.request().postDataJSON() as { method: string; params: unknown[] }
    let result: unknown = null
    switch (method) {
      case 'getSlot':
        result = slot
        break
      case 'getLatestBlockhash':
        result = { context: { slot }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 99999 } }
        break
      case 'getAccountInfo':
        result = { value: { owner: TOKEN_PROGRAM, data: ['', 'base64'] } }
        break
      case 'getBalance':
        result = { value: chain.lamports }
        break
      case 'getTokenAccountsByOwner':
        result = {
          value: Array.from({ length: chain.tokenAccounts }, () => ({ pubkey: ata, account: { data: { parsed: { info: { tokenAmount: { amount: chain.tokenAmount.toString() } } } } } })),
        }
        break
      case 'sendTransaction': {
        const tx = getTransactionDecoder().decode(Buffer.from(params[0] as string, 'base64'))
        const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
          staticAccounts: string[]
          instructions: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>
        }
        const ix = msg.instructions.find((i) => msg.staticAccounts[i.programAddressIndex] === TOKEN_PROGRAM && i.data?.[0] === 12)!
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
          const bal = [{ accountIndex: 1, mint: MINT, owner: USER, uiTokenAmount: { amount: chain.tokenAmount.toString() } }]
          result = {
            slot: s.slot,
            blockTime: Math.floor(Date.now() / 1000),
            meta: { err: null, preTokenBalances: bal, postTokenBalances: bal, innerInstructions: [] },
            transaction: {
              message: {
                accountKeys: [{ pubkey: USER }, { pubkey: ata }, { pubkey: MINT }],
                instructions: [{ program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'transferChecked', info: { source: ata, destination: s.dest, mint: MINT, authority: USER, tokenAmount: { amount: s.amount.toString(), decimals: 6 } } } }],
              },
            },
          }
        }
        break
      }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
  })
  return { sent, ata }
}

/**
 * A fake Wallet Standard wallet (runs in the page). It registers through the Wallet Standard events,
 * connects on request and signs with a fake signature. `window.__solRejectNext` rejects the next requests.
 */
function injectSolanaWallet(args: { address: string; chains: string[] }) {
  const w = window as unknown as { __solRejectNext: number; __solSigned: number }
  w.__solRejectNext = 0
  w.__solSigned = 0
  const listeners: Array<(p: unknown) => void> = []
  const account = { address: args.address, publicKey: new Uint8Array(32), chains: args.chains, features: ['solana:signTransaction'] }
  let accounts: unknown[] = []
  const emit = () => listeners.forEach((fn) => fn({ accounts }))
  const wallet = {
    version: '1.0.0',
    name: 'Fake Phantom',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    chains: ['solana:mainnet', 'solana:devnet'],
    get accounts() {
      return accounts
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async (input?: { silent?: boolean }) => {
          if (input?.silent) return { accounts }
          accounts = [account]
          emit()
          return { accounts }
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          accounts = []
          emit()
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (_event: string, fn: (p: unknown) => void) => {
          listeners.push(fn)
          return () => listeners.splice(listeners.indexOf(fn), 1)
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) => {
          if (w.__solRejectNext > 0) {
            w.__solRejectNext--
            throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
          }
          return inputs.map((i) => {
            const out = new Uint8Array(i.transaction)
            out.fill(++w.__solSigned, 1, 65)
            return { signedTransaction: out }
          })
        },
      },
    },
  }
  const register = ({ register }: { register: (x: unknown) => void }) => register(wallet)
  window.addEventListener('wallet-standard:app-ready', (e) => register((e as CustomEvent).detail))
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
}

test.describe('testnet mode on Solana devnet (fake wallet, fake RPC)', () => {
  test.skip(({ isMobile }) => isMobile, 'one browser is enough for the wallet flow')

  async function openDevnet(page: Page, opts: { wallet?: boolean; chains?: string[]; chain?: Partial<Chain> } = {}) {
    const chain: Chain = { lamports: 2_000_000_000, tokenAccounts: 1, tokenAmount: 20_000_000n, ...opts.chain }
    const rpc = await fakeDevnet(page, chain)
    await page.addInitScript((path) => {
      ;(window as unknown as { __OPENRAMP_SOLANA__: unknown }).__OPENRAMP_SOLANA__ = { rpcUrl: `${location.origin}${path}` }
    }, RPC_PATH)
    if (opts.wallet !== false) await page.addInitScript(injectSolanaWallet, { address: USER, chains: opts.chains ?? ['solana:mainnet', 'solana:devnet'] })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/playground/?mode=testnet&network=solana-devnet')
    await expect(page.getByTestId('demo-banner')).toContainText('Devnet: real transactions on Solana devnet, test tokens with no value.')
    return { errors, chain, rpc }
  }

  test('no wallet: a clear message, nothing to connect', async ({ page }) => {
    await openDevnet(page, { wallet: false })
    await expect(page.getByTestId('testnet-message')).toContainText('No Solana wallet found. Install Phantom, Solflare or Backpack')
    await expect(page.getByRole('button', { name: 'Connect Solana wallet' })).toBeDisabled()
    await expect(page.getByTestId('testnet-placeholder')).toContainText('Wallet Standard wallet')
    // Back to an EVM testnet: the EVM panel and banner return.
    await page.locator('#tn-network').selectOption('arbitrum-sepolia')
    await expect(page.getByTestId('demo-banner')).toContainText('Testnet: real transactions on Arbitrum Sepolia')
    await expect(page.locator('#tn-hint-evm')).toBeVisible()
    await expect(page.locator('#tn-gas-faucet')).toBeHidden()
  })

  test('wrong cluster: an account without devnet gets a clear message', async ({ page }) => {
    await openDevnet(page, { chains: ['solana:mainnet'] })
    await page.getByRole('button', { name: 'Connect Solana wallet' }).click()
    await expect(page.getByTestId('testnet-message')).toContainText('does not support Solana devnet')
    await expect(page.getByTestId('testnet-wallet')).toHaveText('Wrong network')
  })

  test('no token account and low SOL: faucet links, no widget', async ({ page }) => {
    await openDevnet(page, { chain: { tokenAccounts: 0, lamports: 0 } })
    await page.getByRole('button', { name: 'Connect Solana wallet' }).click()
    const msg = page.getByTestId('testnet-message')
    await expect(msg).toContainText('no devnet USDC token account yet')
    await expect(msg).toContainText('Get devnet SOL for fees from the Solana faucet')
    await expect(page.getByRole('link', { name: 'Get devnet USDC (Circle faucet)' })).toHaveAttribute('href', 'https://faucet.circle.com/')
    await expect(page.getByRole('link', { name: 'Get devnet SOL (faucet)' })).toHaveAttribute('href', 'https://faucet.solana.com/')
    await expect(page.getByTestId('testnet-placeholder')).toContainText('Get devnet USDC and a little devnet SOL first')
  })

  test('connect, reject once, then pay devnet USDC to itself; the server checks it on chain', async ({ page }) => {
    const { errors, rpc } = await openDevnet(page)
    await expect(page.getByTestId('testnet-placeholder')).toContainText('Connect your Solana wallet')
    await expect(page.locator('#code')).toContainText('SOLANA_DEVNET_USDC_MINT')
    await page.getByRole('button', { name: 'Connect Solana wallet' }).click()
    await expect(page.getByTestId('testnet-wallet')).toContainText('20 USDC · 2 SOL')

    const modal = page.locator('openramp-modal')
    await modal.getByRole('button', { name: /Pay with wallet/ }).click()
    await expect(modal.getByRole('radio', { name: /USDC/ })).toBeVisible()
    await modal.getByRole('textbox', { name: 'Amount' }).fill('5')
    await modal.getByRole('button', { name: 'Continue' }).click()
    await modal.getByRole('button', { name: 'Confirm' }).click()
    await expect(modal.getByRole('button', { name: 'Confirm in wallet' })).toBeVisible()

    await page.evaluate(() => ((window as unknown as { __solRejectNext: number }).__solRejectNext = 1))
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await expect(modal).toContainText('You rejected the request in your wallet. Nothing was sent.')
    expect(rpc.sent).toHaveLength(0)

    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
    expect(rpc.sent).toHaveLength(1)
    expect(rpc.sent[0]).toMatchObject({ dest: rpc.ata, amount: 5_000_000n })

    const result = page.getByTestId('testnet-result')
    await expect(result).toContainText('Deposit complete on Solana devnet.')
    await expect(page.getByTestId('tx-link-solana-explorer')).toHaveAttribute('href', `https://explorer.solana.com/tx/${rpc.sent[0]!.signature}?cluster=devnet`)
    await expect(page.getByTestId('events')).toContainText('COMPLETED')
    await expect(page.getByTestId('webhooks')).toContainText('session.completed')
    expect(errors).toEqual([])
  })
})
