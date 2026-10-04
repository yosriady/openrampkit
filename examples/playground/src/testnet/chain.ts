// Testnet mode: calldata, error messages and the wallet guard. Pure code with no wagmi import,
// so the unit tests run in Node.

import { fromBaseUnits, isEvmTx, orkError, toBaseUnits } from '@openrampkit/core'
import type { TxRequest, WalletAdapter, WalletBalance } from '@openrampkit/core'
import { SETTLEMENT_SELECTORS, bytes32ToSessionId, erc20ApproveData } from '@openrampkit/adapter'

const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0')

/** `mint(address,uint256)` of the open-mint test token */
export function mintData(to: string, amountBase: bigint): string {
  return `0x40c10f19${word(to)}${word(amountBase)}`
}

/** ERC-20 `balanceOf(address)` */
export function balanceOfData(owner: string): string {
  return `0x70a08231${word(owner)}`
}

/** ERC-4626 `deposit(uint256 assets, address receiver)` */
export function vaultDepositData(amountBase: bigint, receiver: string): string {
  return `0x6e553f65${word(amountBase)}${word(receiver)}`
}

/** OpenRampSettlement `isSettled(bytes32)` */
export function isSettledData(sessionIdWord: string): string {
  return `${SETTLEMENT_SELECTORS.isSettled}${word(sessionIdWord)}`
}

const APPROVE_SELECTOR = erc20ApproveData('0x0000000000000000000000000000000000000000', 0n).slice(0, 10)

/** The amount of an ERC-20 `approve` call, or undefined when `data` is not one */
export function approveAmount(data: string | undefined): bigint | undefined {
  if (!data || !data.toLowerCase().startsWith(APPROVE_SELECTOR) || data.length < 10 + 128) return undefined
  return BigInt(`0x${data.slice(10 + 64, 10 + 128)}`)
}

/**
 * The session id word of a `settle(settlement, intent)` call, or undefined when `data` is not one.
 * Both arguments are dynamic tuples: the first head word is the offset of the settlement tuple,
 * whose first field is the session id.
 */
export function settleSessionWord(data: string | undefined): string | undefined {
  if (!data || !data.toLowerCase().startsWith(SETTLEMENT_SELECTORS.settle)) return undefined
  const args = data.slice(10)
  const offset = Number(BigInt(`0x${args.slice(0, 64) || '0'}`)) * 2
  const w = args.slice(offset, offset + 64)
  return w.length === 64 ? `0x${w}` : undefined
}

/** The session id (`ors_...`) of a `settle` call, or undefined */
export function settleSessionId(data: string | undefined): string | undefined {
  const w = settleSessionWord(data)
  return w ? bytes32ToSessionId(w) : undefined
}

type ErrorLike = { code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown; data?: unknown }

/** The error and its causes (viem and wagmi wrap the wallet error several times) */
function chain(e: unknown): ErrorLike[] {
  const out: ErrorLike[] = []
  let cur: unknown = e
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    out.push(cur as ErrorLike)
    cur = (cur as ErrorLike).cause
  }
  return out
}

/** keccak256("AlreadySettled(bytes32)")[0:4] */
export const ALREADY_SETTLED_SELECTOR = '0xb196a44a'

/**
 * A short, plain message for a wallet or chain error. The raw viem messages are long and
 * technical, so the widget shows this instead.
 */
export function friendlyWalletError(e: unknown, ctx: { chainName: string; symbol?: string }): string {
  const all = chain(e)
  const codes = all.map((x) => (typeof x.code === 'number' ? x.code : undefined))
  const text = all.map((x) => [x.name, x.shortMessage, x.message, x.details, typeof x.data === 'string' ? x.data : ''].filter((v) => typeof v === 'string').join(' ')).join(' ')
  if (codes.includes(4001) || /UserRejected|user rejected|user denied|rejected the request|denied transaction/i.test(text)) {
    return 'You rejected the request in your wallet. Nothing was sent.'
  }
  if (codes.includes(4902) || /Unrecognized chain|unknown chain|wallet_addEthereumChain/i.test(text)) {
    return `Your wallet does not know ${ctx.chainName}. Add the network in your wallet, then try again.`
  }
  if (/SwitchChain|switch chain|switching chain/i.test(text)) {
    return `Switch your wallet to ${ctx.chainName}, then try again.`
  }
  if (/AlreadySettled/i.test(text) || text.toLowerCase().includes(ALREADY_SETTLED_SELECTOR)) {
    return 'This session is already settled on chain. Start a new deposit.'
  }
  if (/insufficient funds|exceeds the balance of the account|gas required exceeds/i.test(text)) {
    return `Not enough test ETH for gas on ${ctx.chainName}. Get test ETH from a faucet, then try again.`
  }
  if (/transfer amount exceeds balance|ERC20InsufficientBalance|0xe450d38c/i.test(text)) {
    return `Not enough ${ctx.symbol ?? 'tokens'} in your wallet for this amount.`
  }
  if (codes.includes(-32002) || /already pending/i.test(text)) {
    return 'Your wallet has a request open already. Open your wallet to answer it.'
  }
  const first = all.find((x) => typeof x.shortMessage === 'string')?.shortMessage ?? all.find((x) => typeof x.message === 'string')?.message
  return typeof first === 'string' && first.trim() ? first.split('\n')[0]!.trim() : 'The wallet could not send the transaction.'
}

export type GuardOptions = {
  /** CAIP-2 chain of the network, e.g. `eip155:421614` */
  chain: string
  chainName: string
  settlement: string
  token: { address: string; symbol: string; decimals: number }
  /** The connected account's token balance, in base units */
  readBalance(): Promise<bigint>
  /** True when the settlement contract already settled this session id word */
  isSettled(sessionIdWord: string): Promise<boolean>
  /** What to say when the balance is too low, e.g. "Press Mint" */
  topUpHint?: string
}

/**
 * Wrap a wallet for testnet mode:
 * - It reports only the network's chosen token, so the widget pays with it.
 * - Before it sends, it checks the token balance and that the session did not settle yet.
 * - It turns wallet errors into short messages that the widget shows.
 */
export function guardWallet(base: WalletAdapter, g: GuardOptions): WalletAdapter {
  const fail = (message: string) => orkError('BAD_REQUEST', { message, recovery: 'retry_payment' })
  return {
    id: `${base.id}-testnet`,
    namespaces: ['eip155'],
    async getAccounts() {
      const accounts = await base.getAccounts()
      return accounts.filter((a) => a.chain === g.chain)
    },
    async getBalances(accounts) {
      const all = base.getBalances ? await base.getBalances(accounts) : []
      return all.filter((b: WalletBalance) => b.chain === g.chain && b.token.toLowerCase() === g.token.address.toLowerCase()).map((b) => ({ ...b, symbol: g.token.symbol, decimals: g.token.decimals }))
    },
    ...(base.switchChain ? { switchChain: (c: string) => base.switchChain!(c) } : {}),
    async sendTransactions(chain: string, txs: TxRequest[]) {
      const evm = txs.filter(isEvmTx)
      const need = evm.reduce<bigint | undefined>((n, t) => (t.to.toLowerCase() === g.token.address.toLowerCase() ? (approveAmount(t.data) ?? n) : n), undefined)
      if (need !== undefined) {
        const have = await g.readBalance()
        if (have < need) {
          const fmt = (v: bigint) => fromBaseUnits(v.toString(), g.token.decimals)
          throw fail(`Not enough ${g.token.symbol}. You have ${fmt(have)}, and this payment needs ${fmt(need)}.${g.topUpHint ? ` ${g.topUpHint}` : ''}`)
        }
      }
      const settle = evm.find((t) => t.to.toLowerCase() === g.settlement.toLowerCase())
      const sid = settleSessionWord(settle?.data)
      if (sid && (await g.isSettled(sid))) throw fail('This session is already settled on chain. Start a new deposit.')
      try {
        return await base.sendTransactions(chain, txs)
      } catch (e) {
        throw fail(friendlyWalletError(e, { chainName: g.chainName, symbol: g.token.symbol }))
      }
    },
  }
}

/** Base units of a decimal amount of the token */
export function baseUnits(amount: string, decimals: number): bigint {
  return BigInt(toBaseUnits(amount, decimals))
}
