// Testnet mode against a local Anvil chain: the real OpenRampSettlement contract (forge build), a test
// token with open mint and a test ERC-4626 vault. The page gets an injected EIP-1193 wallet that
// sends to Anvil from its unlocked dev account, so wagmi, the widget and the in-page server run as
// they do with MetaMask on Arbitrum Sepolia. Skipped when anvil or forge (Foundry) is missing.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { ANVIL_ACCOUNT, ANVIL_CHAIN_ID, deployMockUsdc, erc20BalanceOf, hasAnvil, rpc, sendAndWait, startAnvil } from '../../../packages/wagmi/src/testchain.ts'

const CONTRACTS = fileURLToPath(new URL('../../../contracts/', import.meta.url))
const hasForge = () => spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0
const ready = hasAnvil() && hasForge() && existsSync(`${CONTRACTS}lib/openzeppelin-contracts/contracts`)
const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0')
const UNIT = 1_000_000n

function bytecode(file: string, name: string): string {
  return (JSON.parse(readFileSync(`${CONTRACTS}out/${file}/${name}.json`, 'utf8')) as { bytecode: { object: string } }).bytecode.object
}

async function deploy(rpcUrl: string, code: string, args = ''): Promise<string> {
  return (await sendAndWait(rpcUrl, { data: `${code}${args}` })).contractAddress!.toLowerCase()
}

type Chain = { rpcUrl: string; stop(): Promise<void>; token: string; vault: string; settlement: string }

/** The page's wallet: an EIP-1193 provider that forwards to Anvil. `window.__rejectNext` rejects the next transactions. */
function injectWallet(args: { rpcUrl: string; account: string; chainId: string; startChainId?: string }) {
  const { rpcUrl, account } = args
  // The wallet can start on another network; it switches to the Anvil chain only.
  let chainId = args.startChainId ?? args.chainId
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const w = window as unknown as { __rejectNext: number; ethereum: unknown }
  w.__rejectNext = 0
  const fail = (code: number, message: string) => Object.assign(new Error(message), { code })
  const rpc = async (method: string, params: unknown[] = []) => {
    const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) })
    const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }
    if (body.error) throw Object.assign(fail(body.error.code, body.error.message), { data: body.error.data })
    return body.result
  }
  w.ethereum = {
    isMetaMask: true,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account]
        case 'eth_chainId':
          return chainId
        case 'wallet_requestPermissions':
        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }]
        case 'wallet_switchEthereumChain': {
          const want = String((params?.[0] as { chainId: string }).chainId).toLowerCase()
          if (want !== args.chainId) throw fail(4902, 'Unrecognized chain ID')
          chainId = want
          for (const fn of listeners.chainChanged ?? []) fn(want)
          return null
        }
        case 'eth_sendTransaction':
          if (w.__rejectNext > 0) {
            w.__rejectNext--
            throw fail(4001, 'User rejected the request.')
          }
          return rpc(method, [{ ...(params?.[0] as object), from: account }])
        default:
          return rpc(method, params)
      }
    },
    on(ev: string, fn: (...a: unknown[]) => void) {
      ;(listeners[ev] ??= []).push(fn)
    },
    removeListener(ev: string, fn: (...a: unknown[]) => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)
    },
  }
}

test.describe('testnet mode on a local chain', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!ready, 'anvil, forge or the contract libraries are missing')
  test.skip(({ isMobile }) => isMobile, 'one browser is enough for the chain flow')

  let chain: Chain

  test.beforeAll(async ({}, info) => {
    if (info.project.use.isMobile) return
    const build = spawnSync('forge', ['build'], { cwd: CONTRACTS, encoding: 'utf8' })
    if (build.status !== 0) throw new Error(`forge build failed: ${build.stderr}`)
    const { rpcUrl, stop } = await startAnvil()
    const token = await deployMockUsdc(rpcUrl)
    const vault = await deploy(rpcUrl, bytecode('Mocks.sol', 'MockVault'), word(token))
    // constructor(owner, signer = 0, targets = [vault]): no intent signer, like the testnet deployments
    const settlement = await deploy(rpcUrl, bytecode('OpenRampSettlement.sol', 'OpenRampSettlement'), `${word(ANVIL_ACCOUNT)}${word(0n)}${word(0x60n)}${word(1n)}${word(vault)}`)
    chain = { rpcUrl, stop, token, vault, settlement }
  })

  test.afterAll(async () => {
    await chain?.stop()
  })

  async function openTestnet(page: Page, opts: { wallet?: boolean; startChainId?: string } = {}) {
    const network = {
      key: 'anvil',
      chainId: ANVIL_CHAIN_ID,
      name: 'Anvil (local)',
      rpcUrl: chain.rpcUrl,
      settlement: chain.settlement,
      explorers: [
        { name: 'Arbiscan', url: 'https://sepolia.arbiscan.io' },
        { name: 'Blockscout', url: 'https://arbitrum-sepolia.blockscout.com' },
      ],
      tokens: [{ key: 'test', label: 'Test token (free, mint in one click)', address: chain.token, symbol: 'tUSDC', decimals: 6, mint: true, vault: chain.vault }],
    }
    await page.addInitScript((n) => {
      ;(window as unknown as { __OPENRAMP_TESTNET__: unknown }).__OPENRAMP_TESTNET__ = { networks: [n] }
    }, network)
    if (opts.wallet !== false) {
      await page.addInitScript(injectWallet, { rpcUrl: chain.rpcUrl, account: ANVIL_ACCOUNT, chainId: `0x${ANVIL_CHAIN_ID.toString(16)}`, ...(opts.startChainId ? { startChainId: opts.startChainId } : {}) })
    }
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/playground/?mode=testnet')
    await expect(page.getByTestId('demo-banner')).toContainText('Testnet: real transactions on Anvil (local), test tokens with no value.')
    return errors
  }

  async function payInWidget(page: Page, amount: string) {
    const modal = page.locator('openramp-modal')
    await modal.getByRole('button', { name: /Pay with wallet/ }).click()
    await expect(modal.getByRole('radio', { name: /tUSDC/ })).toBeVisible()
    await modal.getByRole('textbox', { name: 'Amount' }).fill(amount)
    await modal.getByRole('button', { name: 'Continue' }).click()
    await modal.getByRole('button', { name: 'Confirm' }).click()
    await expect(modal.getByRole('button', { name: 'Confirm in wallet' })).toBeVisible()
    return modal
  }

  const isSettled = async (sessionWord: string) => BigInt(await rpc<string>(chain.rpcUrl, 'eth_call', [{ to: chain.settlement, data: `0xbd07f3c9${sessionWord}` }, 'latest'])) !== 0n

  test('no wallet: a clear message, nothing to connect', async ({ page }) => {
    await openTestnet(page, { wallet: false })
    await expect(page.getByTestId('testnet-message')).toContainText('No browser wallet found. Install MetaMask or Rabby')
    await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeDisabled()
  })

  test('wrong network: the panel offers a switch, and the wallet switches', async ({ page }) => {
    // The wallet starts on Arbitrum Sepolia (0x66eee).
    await openTestnet(page, { startChainId: '0x66eee' })
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await expect(page.getByTestId('testnet-message')).toContainText('Your wallet is on another network. Switch to Anvil (local).')
    await page.getByRole('button', { name: 'Switch to Anvil (local)' }).click()
    await expect(page.getByRole('button', { name: 'Switch to Anvil (local)' })).toBeHidden()
  })

  test('connect, mint, reject once, then approve + settle on chain and verify by session id', async ({ page }) => {
    const errors = await openTestnet(page)
    await expect(page.getByTestId('testnet-placeholder')).toContainText('Connect your wallet')
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await expect(page.getByTestId('testnet-wallet')).toContainText('0 tUSDC')
    await expect(page.getByTestId('testnet-message')).toContainText('You have 0 tUSDC')

    await page.getByRole('button', { name: 'Mint 100 tUSDC' }).click()
    await expect(page.getByTestId('testnet-wallet')).toContainText('100 tUSDC')
    expect(await erc20BalanceOf(chain.rpcUrl, chain.token, ANVIL_ACCOUNT)).toBe(100n * UNIT)

    // Insufficient balance: the guard stops before the wallet opens.
    let modal = await payInWidget(page, '250')
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await expect(modal).toContainText('Not enough tUSDC. You have 100, and this payment needs 250.')

    // A new deposit for 5: the user rejects the first request, then accepts.
    await page.getByRole('button', { name: 'Start deposit' }).click()
    modal = await payInWidget(page, '5')
    await page.evaluate(() => ((window as unknown as { __rejectNext: number }).__rejectNext = 1))
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await expect(modal).toContainText('You rejected the request in your wallet. Nothing was sent.')
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })

    const result = page.getByTestId('testnet-result')
    await expect(result).toContainText('Settled on Anvil (local).')
    const href = await page.getByTestId('tx-link-arbiscan').getAttribute('href')
    expect(href).toMatch(/^https:\/\/sepolia\.arbiscan\.io\/tx\/0x[0-9a-f]{64}$/)
    await expect(page.getByTestId('tx-link-blockscout')).toHaveAttribute('href', /^https:\/\/arbitrum-sepolia\.blockscout\.com\/tx\/0x[0-9a-f]{64}$/)

    // The transaction is a settle of this session on the contract.
    const hash = href!.split('/').pop()!
    const tx = await rpc<{ to: string; input: string }>(chain.rpcUrl, 'eth_getTransactionByHash', [hash])
    expect(tx.to.toLowerCase()).toBe(chain.settlement)
    const args = tx.input.slice(10)
    const sessionWord = args.slice(Number(BigInt(`0x${args.slice(0, 64)}`)) * 2).slice(0, 64)
    expect(Buffer.from(sessionWord, 'hex').toString('utf8').replace(/\0+$/, '')).toMatch(/^ors_[0-9a-f]+$/)
    expect(await isSettled(sessionWord)).toBe(true)
    // Plain settlement to the payer itself: the balance is back to 100.
    expect(await erc20BalanceOf(chain.rpcUrl, chain.token, ANVIL_ACCOUNT)).toBe(100n * UNIT)
    await expect(page.getByTestId('events')).toContainText('COMPLETED')
    await expect(page.getByTestId('webhooks')).toContainText('session.completed')
    expect(errors).toEqual([])
  })

  test('deposit into the vault: the payer gets vault shares in the same transaction', async ({ page }) => {
    const errors = await openTestnet(page)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await expect(page.getByTestId('testnet-wallet')).toContainText(/\d+ tUSDC/)
    if (await erc20BalanceOf(chain.rpcUrl, chain.token, ANVIL_ACCOUNT) < 10n * UNIT) {
      await page.getByRole('button', { name: 'Mint 100 tUSDC' }).click()
    }
    const before = await erc20BalanceOf(chain.rpcUrl, chain.token, ANVIL_ACCOUNT)
    await page.locator('#tn-dest').selectOption('vault')
    await page.locator('#tn-amount').fill('7')
    await page.locator('#tn-amount').press('Tab')
    await expect(page.getByTestId('testnet-message')).toContainText('pay exactly 7 tUSDC')
    await expect(page.locator('#code')).toContainText("functionName: 'deposit'")
    const modal = await payInWidget(page, '7')
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await expect(modal).toContainText('Deposit complete', { timeout: 30_000 })
    await expect(page.getByTestId('testnet-result')).toContainText('Settled on Anvil (local).')
    expect(await erc20BalanceOf(chain.rpcUrl, chain.vault, ANVIL_ACCOUNT)).toBe(7n * UNIT)
    expect(await erc20BalanceOf(chain.rpcUrl, chain.token, ANVIL_ACCOUNT)).toBe(before - 7n * UNIT)
    expect(errors).toEqual([])
  })
})
