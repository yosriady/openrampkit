// Testnet mode of the playground: connect a browser wallet, pick a testnet and a token, then pay a
// session from the in-browser server through OpenRampSettlement with real transactions.
// On Solana devnet, a Wallet Standard wallet signs one SPL transfer of devnet USDC back to itself, and
// the server checks it on chain.
// Loaded on demand, so the default (mock) mode does not load wagmi. The Solana code loads when the
// visitor picks Solana Devnet.

import { reconnect } from '@wagmi/core'
import { fromBaseUnits, lamportsToSol } from '@openrampkit/core'
import type { ClientEvent } from '@openrampkit/core'
import { openDeposit } from '@openrampkit/web'
import type { DepositHandle, Theme } from '@openrampkit/web'
import { BASE_URL } from '../server.js'
import { baseUnits } from './chain.js'
import { DEVNET_BANNER, solanaDevnet, solanaTxLink, testnetBanner, testnetNetworks, txLinks } from './config.js'
import type { SolanaDevnetConfig, TestnetNetwork, TestnetToken } from './config.js'
import { createTestnetServer, testnetSessionInput } from './server.js'
import { MIN_FEE_LAMPORTS, solanaSessionInput } from './solana.js'
import type { SolanaDevnet } from './solana-wallet.js'
import { createTestnetWallet, hasInjectedWallet } from './wallet.js'
import type { WalletState } from './wallet.js'

export type TestnetEnv = {
  /** Where the widget goes */
  container: HTMLElement
  theme: Theme
  locale: string
  onEvent: (e: ClientEvent) => void
  setBanner(text: string): void
  setCode(text: string): void
}

/** Test tokens that one press of "Mint" gives */
const MINT_AMOUNT = '100'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let shared:
  | { networks: TestnetNetwork[]; solana?: SolanaDevnetConfig; server: ReturnType<typeof createTestnetServer>; wallet: ReturnType<typeof createTestnetWallet> }
  | undefined

function setup() {
  if (!shared) {
    const networks = testnetNetworks()
    const solana = solanaDevnet()
    shared = { networks, ...(solana ? { solana } : {}), server: createTestnetServer(networks, solana), wallet: createTestnetWallet(networks) }
    void reconnect(shared.wallet.config).catch(() => {})
  }
  return shared
}

let solanaLoad: Promise<SolanaDevnet> | undefined

/** The Solana devnet wallet code, loaded once on demand */
function loadSolana(cfg: SolanaDevnetConfig): Promise<SolanaDevnet> {
  solanaLoad ??= import('./solana-wallet.js').then(async ({ createSolanaDevnet }) => {
    const s = createSolanaDevnet(cfg)
    // A wallet that trusts this page already connects without a prompt.
    await s.connect({ silent: true }).catch(() => {})
    return s
  })
  return solanaLoad
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

function solanaCodeFor(cfg: SolanaDevnetConfig): string {
  return `// Your server
const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  destination: {
    type: 'crypto',
    chain: SOLANA_DEVNET, // '${cfg.chain}'
    token: SOLANA_DEVNET_USDC_MINT, // '${cfg.token.mint}'
    symbol: 'USDC',
    decimals: 6,
    address: user.solanaAddress, // owner address, here the connected wallet
  },
})

// Your page: the Wallet Standard wallet signs one SPL transfer (WALLET_TX)
import { solanaWallet } from '@openrampkit/solana'
const handle = openDeposit({ baseUrl: '/api/openramp', clientSecret, wallet: solanaWallet({ chain: SOLANA_DEVNET }) })

// The server checks the signature on chain: getSignatureStatuses, then getTransaction (jsonParsed)`
}

export function startTestnet(env: TestnetEnv) {
  const { networks, solana: sol, server, wallet } = setup()
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
    hintEvm: $('tn-hint-evm'),
    hintSol: $('tn-hint-sol'),
    destRow: $('tn-dest-row'),
    walletRow: $('tn-wallet-row'),
    walletPick: $<HTMLSelectElement>('tn-wallet-pick'),
    gasFaucet: $<HTMLAnchorElement>('tn-gas-faucet'),
  }

  let handle: DepositHandle | undefined
  let theme = env.theme
  let balance: bigint | undefined
  let stopped = false
  const cleanups: Array<() => void> = []
  /** The Solana devnet wallet code, once loaded */
  let solana: SolanaDevnet | undefined
  /** The placeholder text when the Solana widget cannot open yet */
  let solanaNotReady = ''

  const isSol = () => !!sol && el.network.value === sol.key

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
    el.network.replaceChildren(...networks.map((n) => new Option(n.name, n.key)), ...(sol ? [new Option(sol.name, sol.key)] : []))
    // `?network=solana-devnet` picks a network from the URL.
    const want = new URLSearchParams(location.search).get('network')
    if (want && [...el.network.options].some((o) => o.value === want)) el.network.value = want
  }

  function fillTokens() {
    if (isSol()) {
      el.token.replaceChildren(new Option(sol!.token.label, 'usdc'))
      return
    }
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
    if (isSol()) return syncSolana()
    el.hintEvm.hidden = false
    el.hintSol.hidden = true
    el.destRow.hidden = false
    el.walletRow.hidden = true
    el.gasFaucet.hidden = true
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
    el.faucet.textContent = `Get ${t.symbol} (${t.faucetName ?? 'Circle faucet'})`
    if (n.feeToken && n.feeToken.faucet !== t.faucet) {
      el.gasFaucet.hidden = false
      el.gasFaucet.href = n.feeToken.faucet
      el.gasFaucet.textContent = `Get ${n.feeToken.symbol} for fees (faucet)`
    }

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
    if (n.feeToken) notes.push(`${n.name} has no gas token. Your wallet pays fees in ${n.feeToken.symbol}, so it needs some ${n.feeToken.symbol} from the faucet.`)
    if (balance === 0n) {
      notes.push(t.mint ? `You have 0 ${t.symbol}. Press "Mint ${MINT_AMOUNT} ${t.symbol}" to get free test tokens.` : `You have 0 ${t.symbol}. Get test ${t.symbol} from the ${t.faucetName ?? 'Circle faucet'}, then press "Start deposit".`)
    }
    say(notes.join(' '), balance === 0n ? 'error' : 'info')
    return balance !== 0n
  }

  function solanaWatch(s: SolanaDevnet) {
    if (solana) return
    solana = s
    cleanups.push(
      s.watch(() => {
        if (stopped || !isSol()) return
        // A new account starts over (it is the recipient).
        if (s.state().address !== shownFor) void refresh()
        else void sync()
      }),
    )
  }

  /** The panel on Solana devnet. Returns true when the widget can open. */
  async function syncSolana(): Promise<boolean> {
    const cfg = sol!
    el.hintEvm.hidden = true
    el.hintSol.hidden = false
    el.destRow.hidden = true
    el.amountRow.hidden = true
    el.mint.hidden = true
    el.switchNet.hidden = true
    el.faucet.hidden = false
    el.faucet.href = cfg.token.faucet
    el.faucet.textContent = `Get devnet ${cfg.token.symbol} (Circle faucet)`
    el.gasFaucet.hidden = false
    el.gasFaucet.href = cfg.gasFaucet
    el.gasFaucet.textContent = 'Get devnet SOL (faucet)'
    env.setBanner(DEVNET_BANNER)
    env.setCode(solanaCodeFor(cfg))
    const s = solana ?? (await loadSolana(cfg))
    solanaWatch(s)
    if (stopped || !isSol()) return false
    const st = s.state()
    el.walletRow.hidden = st.wallets.length < 2
    if (st.wallets.length > 1) {
      el.walletPick.replaceChildren(...st.wallets.map((w) => new Option(w, w)))
      if (st.wallet) el.walletPick.value = st.wallet
    }
    el.connect.textContent = st.address || st.noDevnetAccount ? 'Disconnect' : 'Connect Solana wallet'
    if (!st.wallets.length) {
      el.status.textContent = 'No wallet'
      el.connect.disabled = true
      el.start.disabled = true
      say('No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page.', 'error')
      solanaNotReady = 'Solana devnet needs a Wallet Standard wallet: Phantom, Solflare or Backpack.'
      return false
    }
    el.connect.disabled = false
    if (!st.address) {
      el.status.textContent = st.noDevnetAccount ? 'Wrong network' : 'Not connected'
      el.start.disabled = true
      if (st.noDevnetAccount) {
        say(`Your ${st.wallet ?? 'wallet'} account does not support Solana devnet. Turn on testnet mode in your wallet, pick Devnet, then connect again.`, 'error')
        solanaNotReady = 'Switch your wallet to Solana devnet, then connect again.'
      } else {
        solanaNotReady = 'Connect your Solana wallet to pay on devnet. Your wallet signs a real devnet transaction with test USDC.'
      }
      return false
    }
    const addr = st.address
    let lamports: bigint | undefined
    let tok: { accounts: number; amount: bigint } | undefined
    try {
      ;[lamports, tok] = await Promise.all([s.solBalance(addr), s.tokenInfo(addr)])
    } catch {
      // The guard checks again before the wallet opens.
    }
    if (stopped || !isSol()) return false
    const usdc = tok ? fromBaseUnits(tok.amount.toString(), cfg.token.decimals) : '?'
    el.status.textContent = `${short(addr)} · ${usdc} ${cfg.token.symbol} · ${lamports === undefined ? '?' : lamportsToSol(lamports)} SOL`
    el.status.title = addr
    el.start.disabled = false
    const notes: string[] = []
    let ready = true
    if (tok && !tok.accounts) {
      notes.push(`You have no devnet ${cfg.token.symbol} token account yet. Get devnet ${cfg.token.symbol} from the Circle faucet (choose Solana Devnet), then press "Start deposit".`)
      ready = false
    } else if (tok && tok.amount === 0n) {
      notes.push(`You have 0 devnet ${cfg.token.symbol}. Get devnet ${cfg.token.symbol} from the Circle faucet (choose Solana Devnet), then press "Start deposit".`)
      ready = false
    }
    if (lamports !== undefined && lamports < MIN_FEE_LAMPORTS) {
      notes.push(`You have ${lamportsToSol(lamports)} devnet SOL. Get devnet SOL for fees from the Solana faucet, then press "Start deposit".`)
      ready = false
    }
    say(notes.join(' '), ready ? 'info' : 'error')
    solanaNotReady = `Get devnet ${cfg.token.symbol} and a little devnet SOL first, then press "Start deposit".`
    return ready
  }

  function openSolanaWidget() {
    closeWidget()
    el.result.hidden = true
    const cfg = sol!
    const s = solana
    const addr = s?.state().address
    if (!s || !addr) return
    const opened = openDeposit({
      baseUrl: BASE_URL,
      fetch: server.fakeFetch,
      clientSecret: async () => (await server.openramp.sessions.create(solanaSessionInput(cfg, addr))).clientSecret,
      wallet: s.adapter(),
      theme,
      locale: env.locale,
      onEvent: env.onEvent,
      container: env.container,
      embedded: true,
    })
    handle = opened
    opened.done.then(
      (session) => {
        if (handle !== opened) return
        showSolanaResult(cfg, session.step.progress?.legs.find((l) => l.txHash)?.txHash)
        void sync()
      },
      () => {},
    )
  }

  function showSolanaResult(cfg: SolanaDevnetConfig, signature: string | undefined) {
    el.result.replaceChildren()
    const title = document.createElement('strong')
    title.textContent = 'Deposit complete on Solana devnet.'
    el.result.append(title)
    if (signature) {
      el.result.append(' View the transaction: ')
      const a = document.createElement('a')
      a.href = solanaTxLink(cfg, signature)
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = 'Solana Explorer'
      a.dataset.testid = 'tx-link-solana-explorer'
      const code = document.createElement('code')
      code.textContent = signature
      el.result.append(a, document.createElement('br'), code)
    }
    el.result.hidden = false
  }

  function openWidget() {
    if (isSol()) return openSolanaWidget()
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

  const currentAddress = () => (isSol() ? solana?.state().address : wallet.state().address)

  async function refresh(open = true) {
    const seq = ++refreshSeq
    shownFor = currentAddress()
    const ready = await sync()
    // A newer refresh (another change while this one read the chain) wins.
    if (stopped || seq !== refreshSeq) return
    shownFor = currentAddress()
    if (ready && open) openWidget()
    else if (!ready && isSol()) placeholder(solanaNotReady)
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
    el.result.hidden = true
    say('')
    void refresh()
  })
  on(el.walletPick, 'change', () => {
    solana?.select(el.walletPick.value)
    void refresh()
  })
  on(el.token, 'change', () => void refresh())
  on(el.dest, 'change', () => void refresh())
  on(el.amount, 'change', () => void refresh())
  on(el.connect, 'click', () =>
    void guarded(el.connect, 'Connecting…', async () => {
      if (isSol()) {
        const s = solana ?? (await loadSolana(sol!))
        const st = s.state()
        if (st.address || st.noDevnetAccount) {
          await s.disconnect()
          say('')
        } else {
          await s.connect()
        }
        await refresh()
        return
      }
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
      if (isSol()) return
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
