// OpenRampSettlement on a local Anvil chain: the TypeScript helpers against the real compiled contract.
// Builds the contract with `forge build`, deploys it with a mock USDC and an ERC-4626 vault, pays a
// session with the WALLET_TX calls from `buildSettlementTxs`, and checks it with `verifySettlement`.
// Also signs an intent with Anvil's `eth_signTypedData_v4` to prove EIP-712 parity.
//
// Skipped when `anvil` or `forge` (Foundry) is not on PATH, or the contract libraries are not checked
// out (git submodules), unless OPENRAMP_REQUIRE_SETTLEMENT_CHAIN=1 (set on CI).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANVIL_ACCOUNT, ANVIL_CHAIN_ID, deployMockUsdc, erc20BalanceOf, hasAnvil, mintMockUsdc, rpc, sendAndWait, startAnvil } from '../../wagmi/src/testchain.js'
import { SETTLEMENT_SELECTORS, buildSettlementTxs, encodeSettle, hashSettlementCalls, settlementIntentTypedData, verifySettlement } from './settlement.js'

const CONTRACTS = fileURLToPath(new URL('../../../contracts/', import.meta.url))
const RECIPIENT = '0x000000000000000000000000000000000000beef'
const USDC_UNIT = 1_000_000n

const hasForge = () => spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0
const ready = hasAnvil() && hasForge() && existsSync(`${CONTRACTS}lib/openzeppelin-contracts/contracts`)
const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0')

function bytecode(file: string, name: string): string {
  const artifact = JSON.parse(readFileSync(`${CONTRACTS}out/${file}/${name}.json`, 'utf8')) as { bytecode: { object: string } }
  return artifact.bytecode.object
}

async function deploy(rpcUrl: string, code: string, args = ''): Promise<string> {
  const r = await sendAndWait(rpcUrl, { data: `${code}${args}` })
  return r.contractAddress!.toLowerCase()
}

describe.skipIf(!ready && process.env.OPENRAMP_REQUIRE_SETTLEMENT_CHAIN !== '1')('OpenRampSettlement on Anvil', () => {
  let rpcUrl: string
  let stop: () => Promise<void>
  let usdc: string
  let vault: string
  let settlement: string

  beforeAll(async () => {
    const build = spawnSync('forge', ['build'], { cwd: CONTRACTS, encoding: 'utf8' })
    if (build.status !== 0) throw new Error(`forge build failed: ${build.stderr}`)
    ;({ rpcUrl, stop } = await startAnvil())
    usdc = await deployMockUsdc(rpcUrl)
    await mintMockUsdc(rpcUrl, usdc, ANVIL_ACCOUNT, 1000n * USDC_UNIT)
    vault = await deploy(rpcUrl, bytecode('Mocks.sol', 'MockVault'), word(usdc))
    // constructor(owner, signer = 0, targets = [vault])
    settlement = await deploy(rpcUrl, bytecode('OpenRampSettlement.sol', 'OpenRampSettlement'), `${word(ANVIL_ACCOUNT)}${word(0n)}${word(0x60n)}${word(1n)}${word(vault)}`)
  }, 120_000)

  afterAll(async () => {
    await stop?.()
  })

  it('pays a session into an ERC-4626 vault with approve + settle, and verifies it by session id', async () => {
    const sessionId = 'ors_000000000000000000000001'
    const amount = 25n * USDC_UNIT
    // deposit(amount, recipient)
    const calls = [{ target: vault, data: `0x6e553f65${word(amount)}${word(RECIPIENT)}` }]
    expect(await verifySettlement({ rpcUrl, contract: settlement, sessionId })).toEqual({ settled: false })

    const txs = buildSettlementTxs({ chainId: ANVIL_CHAIN_ID, contract: settlement, sessionId, token: usdc, amount, recipient: RECIPIENT, calls })
    for (const tx of txs) await sendAndWait(rpcUrl, { to: tx.to, data: tx.data! })

    const r = await verifySettlement({ rpcUrl, contract: settlement, sessionId, expect: { token: usdc, recipient: RECIPIENT, minAmount: amount, callsHash: hashSettlementCalls(calls) } })
    expect(r).toMatchObject({ settled: true, ok: true, record: { payer: ANVIL_ACCOUNT.toLowerCase(), token: usdc, recipient: RECIPIENT, amount } })
    // the recipient holds vault shares (1:1 on an empty vault), the contract holds nothing
    expect(await erc20BalanceOf(rpcUrl, vault, RECIPIENT)).toBe(amount)
    expect(await erc20BalanceOf(rpcUrl, usdc, settlement)).toBe(0n)

    // replay of the same session reverts
    await expect(sendAndWait(rpcUrl, { to: settlement, data: txs[1]!.data! })).rejects.toThrow()
  })

  it('settles with an EIP-712 intent signed by a standard signer', async () => {
    // setIntentSigner(ANVIL_ACCOUNT)
    await sendAndWait(rpcUrl, { to: settlement, data: `0x0f1ebfdb${word(ANVIL_ACCOUNT)}` })
    const signer = await rpc<string>(rpcUrl, 'eth_call', [{ to: settlement, data: SETTLEMENT_SELECTORS.intentSigner }, 'latest'])
    expect(`0x${signer.slice(-40)}`).toBe(ANVIL_ACCOUNT.toLowerCase())

    const sessionId = 'ors_000000000000000000000002'
    const amount = 10n * USDC_UNIT
    const typed = settlementIntentTypedData({ chainId: ANVIL_CHAIN_ID, contract: settlement, sessionId, token: usdc, recipient: RECIPIENT, minAmount: amount, deadline: 4_000_000_000n, payer: ANVIL_ACCOUNT })
    const json = JSON.parse(JSON.stringify({ ...typed, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...typed.types } }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    const signature = await rpc<string>(rpcUrl, 'eth_signTypedData_v4', [ANVIL_ACCOUNT, json])

    const intent = { payer: ANVIL_ACCOUNT, minAmount: amount, deadline: typed.message.deadline, signature }
    const txs = buildSettlementTxs({ chainId: ANVIL_CHAIN_ID, contract: settlement, sessionId, token: usdc, amount, recipient: RECIPIENT, intent })
    for (const tx of txs) await sendAndWait(rpcUrl, { to: tx.to, data: tx.data! })
    expect(await verifySettlement({ rpcUrl, contract: settlement, sessionId, expect: { minAmount: amount } })).toMatchObject({ settled: true, ok: true })

    // a changed recipient breaks the signature
    const other = encodeSettle({ sessionId: 'ors_000000000000000000000003', token: usdc, amount, recipient: ANVIL_ACCOUNT }, intent)
    await sendAndWait(rpcUrl, { to: usdc, data: txs[0]!.data! })
    await expect(sendAndWait(rpcUrl, { to: settlement, data: other })).rejects.toThrow()
  })
})
