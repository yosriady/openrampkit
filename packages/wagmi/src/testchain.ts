// Test-only helpers for a local Anvil chain: start anvil, deploy a mock USDC (6 decimals) and mint it.
// Used by anvil.test.ts and by `pnpm chain:local` (scripts/anvil.ts). Not part of the build
// (tsup bundles src/index.ts only). Plain JSON-RPC over fetch and node built-ins only, so Node can
// run this file directly with type stripping.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

export const ANVIL_CHAIN_ID = 31337
export const ANVIL_CHAIN = 'eip155:31337'
/**
 * Anvil's well-known default dev account 0 (from the public test mnemonic "test test ... junk").
 * Anvil unlocks it, so `eth_sendTransaction` from it needs no key here. Local test chains only.
 */
export const ANVIL_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/** Creation bytecode of scripts/anvil/MockUSDC.sol (solc 0.8.28, optimizer 200 runs, EVM paris, no metadata hash) */
export const MOCK_USDC_BYTECODE = '0x6080604052348015600f57600080fd5b5061060f8061001f6000396000f3fe608060405234801561001057600080fd5b506004361061009e5760003560e01c806340c10f191161006657806340c10f191461014c57806370a082311461016157806395d89b4114610181578063a9059cbb146101a4578063dd62ed3e146101b757600080fd5b806306fdde03146100a3578063095ea7b3146100e557806318160ddd1461010857806323b872dd1461011f578063313ce56714610132575b600080fd5b6100cf6040518060400160405280600d81526020016c26b7b1b5902aa9a21021b7b4b760991b81525081565b6040516100dc91906104a0565b60405180910390f35b6100f86100f336600461050a565b6101e2565b60405190151581526020016100dc565b61011160005481565b6040519081526020016100dc565b6100f861012d366004610534565b61024f565b61013a600681565b60405160ff90911681526020016100dc565b61015f61015a36600461050a565b610302565b005b61011161016f366004610571565b60016020526000908152604090205481565b6100cf604051806040016040528060048152602001635553444360e01b81525081565b6100f86101b236600461050a565b61038a565b6101116101c5366004610593565b600260209081526000928352604080842090915290825290205481565b3360008181526002602090815260408083206001600160a01b038716808552925280832085905551919290917f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259061023d9086815260200190565b60405180910390a35060015b92915050565b6001600160a01b038316600090815260026020908152604080832033845290915281205460001981146102ec57828110156102bd5760405162461bcd60e51b8152602060048201526009602482015268616c6c6f77616e636560b81b60448201526064015b60405180910390fd5b6102c783826105dc565b6001600160a01b03861660009081526002602090815260408083203384529091529020555b6102f78585856103a0565b506001949350505050565b8060008082825461031391906105ef565b90915550506001600160a01b038216600090815260016020526040812080548392906103409084906105ef565b90915550506040518181526001600160a01b038316906000907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200160405180910390a35050565b60006103973384846103a0565b50600192915050565b6001600160a01b0383166000908152600160205260409020548111156103f25760405162461bcd60e51b815260206004820152600760248201526662616c616e636560c81b60448201526064016102b4565b6001600160a01b0383166000908152600160205260408120805483929061041a9084906105dc565b90915550506001600160a01b038216600090815260016020526040812080548392906104479084906105ef565b92505081905550816001600160a01b0316836001600160a01b03167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef8360405161049391815260200190565b60405180910390a3505050565b602081526000825180602084015260005b818110156104ce57602081860181015160408684010152016104b1565b506000604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b038116811461050557600080fd5b919050565b6000806040838503121561051d57600080fd5b610526836104ee565b946020939093013593505050565b60008060006060848603121561054957600080fd5b610552846104ee565b9250610560602085016104ee565b929592945050506040919091013590565b60006020828403121561058357600080fd5b61058c826104ee565b9392505050565b600080604083850312156105a657600080fd5b6105af836104ee565b91506105bd602084016104ee565b90509250929050565b634e487b7160e01b600052601160045260246000fd5b81810381811115610249576102496105c6565b80820180821115610249576102496105c656fea164736f6c634300081c000a'

type Hex = `0x${string}`

export type TestChain = {
  rpcUrl: string
  /** The mock USDC contract (lower case) */
  usdc: string
  stop(): Promise<void>
}

/** True when the `anvil` binary (Foundry) is on PATH */
export function hasAnvil(bin = 'anvil'): boolean {
  try {
    return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export async function rpc<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await res.json()) as { result?: T; error?: { message?: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`)
  return body.result as T
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** Start anvil (chain id 31337, no fork) on a free port and wait until it answers. */
export async function startAnvil(opts: { port?: number; bin?: string; timeoutMs?: number } = {}): Promise<{ rpcUrl: string; stop(): Promise<void> }> {
  const port = opts.port ?? (await freePort())
  const child = spawn(opts.bin ?? 'anvil', ['--port', String(port), '--chain-id', String(ANVIL_CHAIN_ID), '--silent'], { stdio: 'ignore' })
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  const rpcUrl = `http://127.0.0.1:${port}`
  const stop = () =>
    new Promise<void>((resolve) => {
      if (exited) return resolve()
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    })
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
  for (;;) {
    if (exited) throw new Error('anvil exited before it was ready')
    try {
      const id = await rpc<string>(rpcUrl, 'eth_chainId')
      if (Number(id) === ANVIL_CHAIN_ID) return { rpcUrl, stop }
    } catch {}
    if (Date.now() > deadline) {
      await stop()
      throw new Error(`anvil did not start on ${rpcUrl}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

type Receipt = { status: string; contractAddress?: string | null }

/** Send a transaction from an unlocked dev account and wait for a successful receipt. */
export async function sendAndWait(rpcUrl: string, tx: { from?: string; to?: string; data: string }): Promise<Receipt & { transactionHash: Hex }> {
  const hash = await rpc<Hex>(rpcUrl, 'eth_sendTransaction', [{ from: tx.from ?? ANVIL_ACCOUNT, ...(tx.to ? { to: tx.to } : {}), data: tx.data }])
  for (let i = 0; i < 100; i++) {
    const receipt = await rpc<Receipt | null>(rpcUrl, 'eth_getTransactionReceipt', [hash])
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`Transaction ${hash} reverted`)
      return { ...receipt, transactionHash: hash }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`No receipt for ${hash}`)
}

const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0')

/** Deploy the mock USDC and return its address (lower case). */
export async function deployMockUsdc(rpcUrl: string, from = ANVIL_ACCOUNT): Promise<string> {
  const receipt = await sendAndWait(rpcUrl, { from, data: MOCK_USDC_BYTECODE })
  if (!receipt.contractAddress) throw new Error('The mock USDC deploy has no contract address')
  return receipt.contractAddress.toLowerCase()
}

/** Mint `amountBase` of the mock USDC to `to` (6 decimals: 1 USDC is 1000000n). Anyone can mint. */
export async function mintMockUsdc(rpcUrl: string, token: string, to: string, amountBase: bigint): Promise<void> {
  // mint(address,uint256)
  await sendAndWait(rpcUrl, { to: token, data: `0x40c10f19${word(to)}${word(amountBase)}` })
}

/** ERC-20 balanceOf(owner), in base units */
export async function erc20BalanceOf(rpcUrl: string, token: string, owner: string): Promise<bigint> {
  return BigInt(await rpc<Hex>(rpcUrl, 'eth_call', [{ to: token, data: `0x70a08231${word(owner)}` }, 'latest']))
}

/** Start anvil, deploy the mock USDC and mint `mintAmount` (base units, default 1000 USDC) to `mintTo` (default dev account 0). */
export async function startTestChain(opts: { mintTo?: string; mintAmount?: bigint; port?: number } = {}): Promise<TestChain> {
  const { rpcUrl, stop } = await startAnvil(opts.port ? { port: opts.port } : {})
  try {
    const usdc = await deployMockUsdc(rpcUrl)
    await mintMockUsdc(rpcUrl, usdc, opts.mintTo ?? ANVIL_ACCOUNT, opts.mintAmount ?? 1_000_000_000n)
    return { rpcUrl, usdc, stop }
  } catch (e) {
    await stop()
    throw e
  }
}
