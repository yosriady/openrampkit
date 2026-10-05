// One-off live check of the deployed playground's "Testnet (real wallet)" mode on Arbitrum Sepolia.
// Not part of the Playwright suite (the suite runs *.spec.ts only).
//
// Run from examples/playground:
//   node e2e/live-testnet.mjs
// Env: PLAYGROUND_URL (default: the live site), ENV_FILE (default: ../../contracts/.env)
//
// The page gets an injected EIP-1193 wallet. It signs and sends in Node through viem, with the key
// DEPLOYER_PRIVATE_KEY from ENV_FILE. The key never goes into the page, the logs or any file.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createPublicClient, createWalletClient, http } from 'viem'
import { nonceManager, privateKeyToAccount } from 'viem/accounts'
import { arbitrumSepolia } from 'viem/chains'

const URL_ = process.env.PLAYGROUND_URL ?? 'https://openrampkit-getformo.vercel.app/playground/'
const RPC = 'https://sepolia-rollup.arbitrum.io/rpc'
const SETTLEMENT = '0xBF66696115128B8f9f794780061348b4213A7132'
const TEST_TOKEN = '0x9A38C55160186C3E1e770e193fA96997e60ed425'
const VAULT = '0xA83fE1B79cEd7772f5d90D19833b2fDD844c7801'
const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MEDIA = `${ROOT}launch/media/`
const ENV_FILE = process.env.ENV_FILE ?? `${ROOT}contracts/.env`

function loadKey() {
  const line = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).find((l) => /^\s*DEPLOYER_PRIVATE_KEY\s*=/.test(l))
  if (!line) throw new Error(`DEPLOYER_PRIVATE_KEY is not in ${ENV_FILE}`)
  let v = line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '')
  if (!v.startsWith('0x')) v = `0x${v}`
  return v
}

const account = privateKeyToAccount(loadKey(), { nonceManager })
const pub = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC) })
const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: http(RPC) })
const ADDRESS = account.address

const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]
const settledAbi = [{ type: 'function', name: 'isSettled', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] }]
const bal = (token) => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [ADDRESS] })

/** Every eth_sendTransaction the page asked for */
const sent = []

async function walletSend(tx) {
  const req = { to: tx.to, data: tx.data ?? '0x' }
  if (tx.value && BigInt(tx.value) > 0n) req.value = BigInt(tx.value)
  if (tx.gas) req.gas = BigInt(tx.gas)
  const hash = await walletClient.sendTransaction(req)
  sent.push({ to: tx.to, selector: (tx.data ?? '0x').slice(0, 10), hash })
  console.log(`  wallet sent ${(tx.data ?? '0x').slice(0, 10)} to ${tx.to}: ${hash}`)
  return hash
}

async function walletRpc(method, params) {
  return pub.request({ method, params: params ?? [] })
}

/** Runs in the page: window.ethereum that forwards writes to Node */
function injectWallet({ address, chainId }) {
  const listeners = {}
  const fail = (code, message) => Object.assign(new Error(message), { code })
  const w = window
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [address]
        case 'eth_chainId':
          return chainId
        case 'net_version':
          return String(parseInt(chainId, 16))
        case 'wallet_requestPermissions':
        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }]
        case 'wallet_revokePermissions':
          return null
        case 'wallet_switchEthereumChain': {
          const want = String(params?.[0]?.chainId).toLowerCase()
          if (want !== chainId) throw fail(4902, 'Unrecognized chain ID')
          return null
        }
        case 'eth_sendTransaction':
          try {
            return await w.__liveWalletSend(params?.[0] ?? {})
          } catch (e) {
            throw fail(-32000, e?.message ?? String(e))
          }
        default:
          return w.__liveWalletRpc(method, params ?? [])
      }
    },
    on(ev, fn) {
      ;(listeners[ev] ??= []).push(fn)
    },
    removeListener(ev, fn) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)
    },
  }
  w.ethereum = provider
}

const results = []
const record = (r) => {
  results.push(r)
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.hash ? ` ${r.hash}` : ''}${r.note ? ` (${r.note})` : ''}`)
}

async function selectTestnet(page, tokenKey, dest) {
  await page.locator('#mode').selectOption('testnet')
  await page.locator('#tn-network').selectOption('arbitrum-sepolia')
  await page.locator('#tn-token').selectOption(tokenKey)
  await page.locator('#tn-dest').selectOption(dest)
}

async function ensureConnected(page) {
  const btn = page.locator('#tn-connect')
  await btn.waitFor()
  if ((await btn.textContent())?.trim() === 'Connect wallet') await btn.click()
  await page.getByTestId('testnet-wallet').filter({ hasText: /0x13B9/i }).waitFor({ timeout: 30_000 })
}

const createdCount = (page) => page.locator('#webhooks li', { hasText: 'session.created' }).count()

/** Run `fn` (a click or a select that reopens the widget), then wait until the new widget is in place. */
async function freshWidget(page, fn) {
  const n = await createdCount(page)
  await fn()
  const t0 = Date.now()
  while ((await createdCount(page)) <= n) {
    if (Date.now() - t0 > 30_000) throw new Error('No new session after the change')
    await page.waitForTimeout(250)
  }
  // Later refreshes (balance reads) can open one more widget; wait until the count holds still.
  let last = await createdCount(page)
  for (let still = 0; still < 6; ) {
    await page.waitForTimeout(250)
    const c = await createdCount(page)
    still = c === last ? still + 1 : 0
    last = c
  }
}

async function payInWidget(page, amount, symbolRe) {
  const modal = page.locator('openramp-modal')
  await modal.getByRole('button', { name: /Pay with wallet/ }).click({ timeout: 30_000 })
  await modal.getByRole('radio', { name: symbolRe }).waitFor({ timeout: 30_000 })
  await modal.getByRole('textbox', { name: 'Amount' }).fill(amount)
  await modal.getByRole('button', { name: 'Continue' }).click()
  await modal.getByRole('button', { name: 'Confirm' }).click()
  await modal.getByRole('button', { name: 'Confirm in wallet' }).waitFor({ timeout: 30_000 })
  return modal
}

async function settledHash(page) {
  const result = page.getByTestId('testnet-result')
  await result.filter({ hasText: 'Settled on Arbitrum Sepolia.' }).waitFor({ timeout: 60_000 })
  const href = await page.getByTestId('tx-link-arbiscan').getAttribute('href')
  return { href, hash: href?.split('/').pop() }
}

async function verifyOnChain(hash) {
  const r = await pub.waitForTransactionReceipt({ hash })
  const tx = await pub.getTransaction({ hash })
  const args = tx.input.slice(10)
  const word = `0x${args.slice(Number(BigInt(`0x${args.slice(0, 64)}`)) * 2).slice(0, 64)}`
  const settled = await pub.readContract({ address: SETTLEMENT, abi: settledAbi, functionName: 'isSettled', args: [word] })
  const sessionId = Buffer.from(word.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
  return { status: r.status, to: tx.to, settled, sessionId, gasUsed: r.gasUsed }
}

async function main() {
  mkdirSync(MEDIA, { recursive: true })
  console.log(`Live URL: ${URL_}`)
  console.log(`Wallet: ${ADDRESS}`)
  const before = { eth: await pub.getBalance({ address: ADDRESS }), test: await bal(TEST_TOKEN), usdc: await bal(USDC), shares: await bal(VAULT) }
  console.log(`Before: tUSDC ${before.test}, USDC ${before.usdc}, vault shares ${before.shares}, ETH wei ${before.eth}`)

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await context.exposeFunction('__liveWalletSend', walletSend)
  await context.exposeFunction('__liveWalletRpc', walletRpc)
  await context.addInitScript(injectWallet, { address: ADDRESS, chainId: `0x${arbitrumSepolia.id.toString(16)}` })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(URL_)
  const html = await page.content()
  if (!html.includes('Testnet (real wallet)')) throw new Error('The live page has no testnet mode')

  // Flow A: test token, mint, plain settlement of 3 tUSDC.
  try {
    await selectTestnet(page, 'test', 'plain')
    await page.getByTestId('demo-banner').filter({ hasText: 'Testnet: real transactions on Arbitrum Sepolia' }).waitFor()
    await ensureConnected(page)
    const preMint = await bal(TEST_TOKEN)
    await page.getByRole('button', { name: 'Mint 100 tUSDC' }).click()
    await page.getByTestId('testnet-message').filter({ hasText: 'Minted 100 tUSDC' }).waitFor({ timeout: 90_000 })
    const postMint = await bal(TEST_TOKEN)
    const mintHash = sent.at(-1)?.hash
    const mintR = await pub.getTransactionReceipt({ hash: mintHash })
    record({ name: 'A1 mint 100 tUSDC', pass: postMint - preMint === 100_000_000n && mintR.status === 'success', hash: mintHash, note: `balance ${preMint} -> ${postMint}` })

    await freshWidget(page, () => page.getByRole('button', { name: 'Start deposit' }).click())
    const modal = await payInWidget(page, '3', /tUSDC/)
    const n0 = sent.length
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await modal.getByText('Deposit complete').first().waitFor({ timeout: 180_000 })
    const { hash, href } = await settledHash(page)
    const v = await verifyOnChain(hash)
    const txs = sent.slice(n0).map((s) => s.selector)
    await page.screenshot({ path: `${MEDIA}live-testnet-a-plain-test-token.png`, fullPage: true })
    record({ name: 'A2 plain settlement 3 tUSDC', pass: v.status === 'success' && v.settled && v.to?.toLowerCase() === SETTLEMENT.toLowerCase(), hash, href, note: `wallet txs ${txs.join(', ')}; session ${v.sessionId}; isSettled ${v.settled}`, approve: sent.slice(n0)[0]?.hash })

    // Error path: the completed widget must not offer another payment of the same session.
    const confirmAgain = await modal.getByRole('button', { name: 'Confirm in wallet' }).count()
    record({ name: 'E2 settled session cannot be paid again in the UI', pass: confirmAgain === 0, note: confirmAgain ? 'Confirm in wallet is still shown' : 'the widget shows only the completed screen; no pay button' })
  } catch (e) {
    await page.screenshot({ path: `${MEDIA}live-testnet-a-error.png`, fullPage: true })
    record({ name: 'Flow A', pass: false, note: e.message.split('\n')[0] })
  }

  // Flow B: test token into the vault, 2 tUSDC.
  try {
    const sharesBefore = await bal(VAULT)
    await freshWidget(page, () => page.locator('#tn-dest').selectOption('vault'))
    await page.locator('#tn-amount').fill('2')
    await freshWidget(page, () => page.locator('#tn-amount').press('Tab'))
    await page.getByTestId('testnet-message').filter({ hasText: 'pay exactly 2 tUSDC' }).waitFor({ timeout: 30_000 })
    const modal = await payInWidget(page, '2', /tUSDC/)
    const n0 = sent.length
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await modal.getByText('Deposit complete').first().waitFor({ timeout: 180_000 })
    const { hash, href } = await settledHash(page)
    const v = await verifyOnChain(hash)
    const sharesAfter = await bal(VAULT)
    await page.screenshot({ path: `${MEDIA}live-testnet-b-vault.png`, fullPage: true })
    record({ name: 'B vault deposit 2 tUSDC', pass: v.status === 'success' && v.settled && sharesAfter > sharesBefore, hash, href, note: `wallet txs ${sent.slice(n0).map((s) => s.selector).join(', ')}; session ${v.sessionId}; vault shares ${sharesBefore} -> ${sharesAfter}` })
  } catch (e) {
    await page.screenshot({ path: `${MEDIA}live-testnet-b-error.png`, fullPage: true })
    record({ name: 'Flow B', pass: false, note: e.message.split('\n')[0] })
  }

  // Error path: an amount above the USDC balance. The guard must stop before the wallet.
  try {
    await freshWidget(page, () => page.locator('#tn-dest').selectOption('plain'))
    await freshWidget(page, () => page.locator('#tn-token').selectOption('usdc'))
    await page.getByTestId('testnet-wallet').filter({ hasText: /USDC/ }).waitFor({ timeout: 30_000 })
    const have = await bal(USDC)
    const tooMuch = String(Number(have / 1_000_000n) + 50)
    const modal = await payInWidget(page, tooMuch, /USDC/)
    const n0 = sent.length
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await modal.getByText(/Not enough USDC/).first().waitFor({ timeout: 30_000 })
    const msg = (await modal.getByText(/Not enough USDC/).first().textContent())?.trim()
    await page.screenshot({ path: `${MEDIA}live-testnet-e1-over-balance.png`, fullPage: true })
    record({ name: `E1 amount above balance (${tooMuch} USDC)`, pass: sent.length === n0, note: `message: "${msg}"; wallet requests: ${sent.length - n0}` })
  } catch (e) {
    await page.screenshot({ path: `${MEDIA}live-testnet-e1-error.png`, fullPage: true })
    record({ name: 'E1 amount above balance', pass: false, note: e.message.split('\n')[0] })
  }

  // Flow C: Circle test USDC, plain settlement of 1 USDC.
  try {
    await freshWidget(page, () => page.getByRole('button', { name: 'Start deposit' }).click())
    const modal = await payInWidget(page, '1', /USDC/)
    const n0 = sent.length
    await modal.getByRole('button', { name: 'Confirm in wallet' }).click()
    await modal.getByText('Deposit complete').first().waitFor({ timeout: 180_000 })
    const { hash, href } = await settledHash(page)
    const v = await verifyOnChain(hash)
    await page.screenshot({ path: `${MEDIA}live-testnet-c-circle-usdc.png`, fullPage: true })
    record({ name: 'C plain settlement 1 Circle USDC', pass: v.status === 'success' && v.settled, hash, href, note: `wallet txs ${sent.slice(n0).map((s) => s.selector).join(', ')}; session ${v.sessionId}` })
  } catch (e) {
    await page.screenshot({ path: `${MEDIA}live-testnet-c-error.png`, fullPage: true })
    record({ name: 'Flow C', pass: false, note: e.message.split('\n')[0] })
  }

  await browser.close()
  const after = { eth: await pub.getBalance({ address: ADDRESS }), test: await bal(TEST_TOKEN), usdc: await bal(USDC), shares: await bal(VAULT) }
  console.log(`After: tUSDC ${after.test}, USDC ${after.usdc}, vault shares ${after.shares}, ETH wei ${after.eth}`)
  if (pageErrors.length) console.log(`Page errors:\n  ${pageErrors.join('\n  ')}`)

  const out = { url: URL_, wallet: ADDRESS, before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, String(v)])), after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, String(v)])), results, sent, pageErrors }
  writeFileSync(`${MEDIA}live-testnet-results.json`, JSON.stringify(out, null, 2))
  process.exitCode = results.every((r) => r.pass) ? 0 : 1
}

main().catch((e) => {
  console.error(e.message.split('\n')[0])
  process.exitCode = 1
})
