// Testnet mode of the playground: connect a browser wallet, pick a testnet and a token, then pay a
// session from the in-browser server through OpenRampSettlement with real transactions.
// Loaded on demand, so the default (mock) mode does not load wagmi.

import { reconnect } from '@wagmi/core'
import { fromBaseUnits } from '@openrampkit/core'
import type { OrkEvent } from '@openrampkit/core'
import { openDeposit } from '@openrampkit/web'
import type { DepositHandle, Theme } from '@openrampkit/web'
import { BASE_URL } from '../server.js'
import { baseUnits } from './chain.js'
import { testnetBanner, testnetNetworks, txLinks } from './config.js'
import type { TestnetNetwork, TestnetToken } from './config.js'
import { createTestnetServer, testnetSessionInput } from './server.js'
import { createTestnetWallet, hasInjectedWallet } from './wallet.js'
import type { WalletState } from './wallet.js'

export type TestnetEnv = {
  /** Where the widget goes */
  container: HTMLElement
  theme: Theme
  locale: string
  onEvent: (e: OrkEvent) => void
  setBanner(text: string): void
  setCode(text: string): void
}

/** Test tokens that one press of "Mint" gives */
const MINT_AMOUNT = '100'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let shared: { networks: TestnetNetwork[]; server: ReturnType<typeof createTestnetServer>; wallet: ReturnType<typeof createTestnetWallet> } | undefined

function setup() {
  if (!shared) {
    const networks = testnetNetworks()
    shared = { networks, server: createTestnetServer(networks), wallet: createTestnetWallet(networks) }
    void reconnect(shared.wallet.config).catch(() => {})
  }
  return shared
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function codeFor(n: TestnetNetwork, t: TestnetToken, vault: boolean, amount: string): string {
  const calls = vault
    ? `\n    // Deposit into the ERC-4626 vault for the user, in the same transaction\n    calls: [{ to: '${t.vault}', data: encodeFunctionData({ abi: erc4626Abi, functionName: 'deposit', args: [${baseUnits(amount, t.decimals)}n, user.address] }) }],`
    : ''
  return `// Your server
const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  destination: {
    type: 'crypto',
    chain: 'eip155:${n.chainId}', // ${n.name}
    token: '${t.address}', // ${t.symbol}
    address: user.address,
    settlement: { contract: '${n.settlement}' },${calls}
  },
})

// Your page: the user's wallet sends approve + settle (WALLET_TX)
import { wagmiWallet } from '@openrampkit/wagmi'
const handle = openDeposit({ baseUrl: '/api/openramp', clientSecret, wallet: wagmiWallet(config) })

// The server checks the session on chain with verifySettlement (receiptOf + the Settled log)`
}

export function startTestnet(env: TestnetEnv) {
  const { networks, server, wallet } = setup()
  const el = {
    network: $<HTMLSelectElement>('tn-network'),
    token: $<HTMLSelectElement>('tn-token'),
    dest: $<HTMLSelectElement>('tn-dest'),
    amountRow: $('tn-amount-row'),
    amount: $<HTMLInputElement>('tn-amount'),
    status: $('tn-status'),
    connect: $<HTMLButtonElement>('tn-connect'),
    switchNet: $<HTMLButtonElement>('tn-switch'),
    mint: $<HTMLButtonElement>('tn-mint'),
    faucet: $<HTMLAnchorElement>('tn-faucet'),
    start: $<HTMLButtonElement>('tn-start'),
    message: $('tn-message'),
    result: $('tn-result'),
  }

  let handle: DepositHandle | undefined
  let theme = env.theme
  let balance: bigint | undefined
  let stopped = false
  const cleanups: Array<() => void> = []

  const network = () => networks.find((n) => n.key === el.network.value) ?? networks[0]!
  const token = () => network().tokens.find((t) => t.key === el.token.value) ?? network().tokens[0]!
  const vaultOn = () => el.dest.value === 'vault' && !!token().vault
  const amount = () => el.amount.value.trim()

  function say(text: string, tone: 'info' | 'error' | 'ok' = 'info') {
    el.message.textContent = text
    el.message.dataset.tone = tone
    el.message.hidden = !text
  }

  function fillNetworks() {
    el.network.replaceChildren(...networks.map((n) => new Option(n.name, n.key)))
  }

  function fillTokens() {
    const prev = el.token.value
    el.token.replaceChildren(...network().tokens.map((t) => new Option(t.label, t.key)))
    if (network().tokens.some((t) => t.key === prev)) el.token.value = prev
  }

  function fillDest() {
    const t = token()
    const vaultOpt = el.dest.querySelector<HTMLOptionElement>('option[value="vault"]')!
    vaultOpt.disabled = !t.vault
    if (!t.vault && el.dest.value === 'vault') el.dest.value = 'plain'
    el.amountRow.hidden = !vaultOn()
  }

  function closeWidget() {
    handle?.close()
    handle = undefined
    env.container.replaceChildren()
  }

  function placeholder(text: string) {
    closeWidget()
    const p = document.createElement('div')
    p.className = 'tn-placeholder'
    p.dataset.testid = 'testnet-placeholder'
    p.textContent = text
    env.container.append(p)
  }

  async function refreshBalance(s: WalletState) {
    balance = undefined
    if (!s.address) return
    try {
      balance = await wallet.tokenBalance(network(), token(), s.address)
    } catch {
      balance = undefined
    }
  }

  /** Update the wallet line and the buttons from the wallet state. Returns true when the widget can open. */
  async function sync(): Promise<boolean> {
    const n = network()
    const t = token()
    const s = wallet.state()
    env.setBanner(testnetBanner(n))
    env.setCode(codeFor(n, t, vaultOn(), amount() || '0'))
    fillDest()
    el.mint.hidden = !t.mint
    el.mint.textContent = `Mint ${MINT_AMOUNT} ${t.symbol}`
    el.faucet.hidden = !t.faucet
    if (t.faucet) el.faucet.href = t.faucet
    el.faucet.textContent = `Get ${t.symbol} (Circle faucet)`

    if (!hasInjectedWallet()) {
      el.status.textContent = 'No wallet'
      el.connect.disabled = true
      el.mint.disabled = true
      el.start.disabled = true
      el.switchNet.hidden = true
      say('No browser wallet found. Install MetaMask or Rabby, then reload this page.', 'error')
      placeholder('Testnet mode needs a browser wallet (MetaMask, Rabby or another EIP-1193 wallet).')
      return false
    }
    el.connect.disabled = false
    const connected = s.status === 'connected' && !!s.address
    el.connect.textContent = connected ? 'Disconnect' : 'Connect wallet'
    if (!connected) {
      el.status.textContent = 'Not connected'
      el.switchNet.hidden = true
      el.mint.disabled = true
      el.start.disabled = true
      return false
    }
    const wrongChain = s.chainId !== n.chainId
    el.switchNet.hidden = !wrongChain
    el.switchNet.textContent = `Switch to ${n.name}`
    el.mint.disabled = false
    await refreshBalance(s)
    if (stopped) return false
    const bal = balance === undefined ? '?' : fromBaseUnits(balance.toString(), t.decimals)
    el.status.textContent = `${short(s.address!)} · ${bal} ${t.symbol}`
    el.status.title = s.address!
    el.start.disabled = false
    const notes: string[] = []
    if (wrongChain) notes.push(`Your wallet is on another network. Switch to ${n.name}. The widget also asks your wallet to switch before it pays.`)
    if (balance === 0n) {
      notes.push(t.mint ? `You have 0 ${t.symbol}. Press "Mint ${MINT_AMOUNT} ${t.symbol}" to get free test tokens.` : `You have 0 ${t.symbol}. Get test ${t.symbol} from the Circle faucet, then press "Start deposit".`)
    }
    say(notes.join(' '), balance === 0n ? 'error' : 'info')
    return balance !== 0n
  }

  function openWidget() {
    closeWidget()
    el.result.hidden = true
    const n = network()
    const t = token()
    const s = wallet.state()
    if (!s.address) return
    if (vaultOn() && !(Number(amount()) > 0)) {
      say('Enter the vault amount.', 'error')
      return
    }
    const vault = vaultOn() ? { amount: amount() } : undefined
    const opened = openDeposit({
      baseUrl: BASE_URL,
      fetch: server.fakeFetch,
      clientSecret: async () => (await server.openramp.sessions.create(testnetSessionInput({ network: n, token: t, recipient: s.address!, ...(vault ? { vault } : {}) }))).clientSecret,
      wallet: wallet.adapter(n, t),
      theme,
      locale: env.locale,
      onEvent: env.onEvent,
      container: env.container,
      embedded: true,
    })
    handle = opened
    if (vault) say(`Vault deposit: pay exactly ${vault.amount} ${t.symbol} in the widget.`)
    opened.done.then(
      (session) => {
        if (handle !== opened) return
        const hash = session.step.progress?.legs.find((l) => l.txHash)?.txHash
        showResult(n, hash)
        void sync()
      },
      () => {},
    )
  }

  function showResult(n: TestnetNetwork, hash: string | undefined) {
    el.result.replaceChildren()
    const title = document.createElement('strong')
    title.textContent = `Settled on ${n.name}.`
    el.result.append(title)
    if (hash) {
      el.result.append(' View the transaction: ')
      txLinks(n, hash).forEach((l, i) => {
        if (i) el.result.append(' · ')
        const a = document.createElement('a')
        a.href = l.href
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = l.name
        a.dataset.testid = `tx-link-${l.name.toLowerCase()}`
        el.result.append(a)
      })
      const code = document.createElement('code')
      code.textContent = hash
      el.result.append(document.createElement('br'), code)
    }
    el.result.hidden = false
  }

  /** The account that the current widget (or placeholder) is for */
  let shownFor: string | undefined

  let refreshSeq = 0

  async function refresh(open = true) {
    const seq = ++refreshSeq
    shownFor = wallet.state().address
    const ready = await sync()
    // A newer refresh (another change while this one read the chain) wins.
    if (stopped || seq !== refreshSeq) return
    if (ready && open) openWidget()
    else if (!ready) {
      const s = wallet.state()
      if (s.status !== 'connected') placeholder('Connect your wallet to pay on a testnet. Your wallet signs real transactions with test tokens.')
      else placeholder(`Get ${token().symbol} first, then press "Start deposit".`)
    }
  }

  async function guarded(btn: HTMLButtonElement, busyText: string, fn: () => Promise<void>) {
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = busyText
    try {
      await fn()
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      btn.textContent = label
      btn.disabled = false
    }
  }

  const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    target.addEventListener(type, fn)
    cleanups.push(() => target.removeEventListener(type, fn))
  }

  on(el.network, 'change', () => {
    fillTokens()
    void refresh()
  })
  on(el.token, 'change', () => void refresh())
  on(el.dest, 'change', () => void refresh())
  on(el.amount, 'change', () => void refresh())
  on(el.connect, 'click', () =>
    void guarded(el.connect, 'Connecting…', async () => {
      if (wallet.state().status === 'connected') {
        await wallet.disconnect()
        say('')
      } else {
        await wallet.connect()
      }
      if (wallet.state().address !== shownFor) await refresh()
    }),
  )
  on(el.switchNet, 'click', () =>
    void guarded(el.switchNet, 'Switching…', async () => {
      await wallet.switchTo(network())
      await refresh()
    }),
  )
  on(el.mint, 'click', () =>
    void guarded(el.mint, 'Minting…', async () => {
      const t = token()
      say(`Minting ${MINT_AMOUNT} ${t.symbol}. Confirm in your wallet.`)
      const hash = await wallet.mint(network(), t, baseUnits(MINT_AMOUNT, t.decimals))
      say(`Minted ${MINT_AMOUNT} ${t.symbol} (${short(hash)}).`, 'ok')
      await refresh()
      say(`Minted ${MINT_AMOUNT} ${t.symbol} (${short(hash)}).`, 'ok')
    }),
  )
  on(el.start, 'click', () => void refresh())
  cleanups.push(
    wallet.watch((s) => {
      // A new account starts over (it is the recipient). A new chain only updates the panel.
      if (s.address !== shownFor) void refresh()
      else void sync()
    }),
  )

  fillNetworks()
  fillTokens()
  void refresh()

  return {
    restyle(t: Theme) {
      theme = t
      if (handle) handle.element.theme = t
    },
    stop() {
      stopped = true
      closeWidget()
      el.result.hidden = true
      for (const c of cleanups) c()
    },
  }
}
