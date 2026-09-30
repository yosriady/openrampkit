'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { createMockWallet } from '@openrampkit/client'
import type { Destination, OrkEvent, WalletAdapter } from '@openrampkit/core'
import { DepositButton, OpenRampEmbedded, OpenRampProvider, WithdrawButton, autoTheme, darkTheme, lightTheme } from '@openrampkit/react'
import { wagmiWallet } from '@openrampkit/wagmi'
import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { wagmiConfig } from '@/lib/wagmi'

const COUNTRIES = [
  ['VN', 'Vietnam'], ['ID', 'Indonesia'], ['TH', 'Thailand'], ['PH', 'Philippines'], ['MY', 'Malaysia'],
  ['SG', 'Singapore'], ['IN', 'India'], ['US', 'United States'], ['DE', 'Germany'],
] as const

const DESTINATIONS: Record<string, { label: string; destination: Destination }> = {
  base: { label: 'USDC on Base', destination: { type: 'crypto', chain: 'eip155:8453', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, address: '0x000000000000000000000000000000000000dEaD' } },
  arbitrum: { label: 'USDC on Arbitrum', destination: { type: 'crypto', chain: 'eip155:42161', token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, address: '0x000000000000000000000000000000000000dEaD' } },
  monad: { label: 'Token on Monad (hop)', destination: { type: 'crypto', chain: 'eip155:143', token: '0x00000000000000000000000000000000000000c0', symbol: 'USDC', decimals: 6, address: '0x000000000000000000000000000000000000dEaD' } },
  merchant: { label: 'Merchant fiat account', destination: { type: 'merchant', currency: 'LOCAL' } },
}

const LOCALES = [['', 'Browser'], ['en', 'English'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['th', 'ไทย'], ['ms', 'Bahasa Melayu'], ['fil', 'Filipino']] as const

const CURRENCY: Record<string, string> = { VN: 'VND', ID: 'IDR', TH: 'THB', PH: 'PHP', MY: 'MYR', SG: 'SGD', IN: 'INR', US: 'USD', DE: 'EUR' }

type WalletMode = 'none' | 'mock' | 'wagmi'
type Direction = 'deposit' | 'withdraw'
type Custody = 'user_wallet' | 'app'

export function Playground({ mock }: { mock: boolean }) {
  const [direction, setDirection] = useState<Direction>('deposit')
  const [custody, setCustody] = useState<Custody>('user_wallet')
  const [country, setCountry] = useState('VN')
  const [dest, setDest] = useState('base')
  const [mode, setMode] = useState<'light' | 'dark' | 'auto'>('light')
  const [accent, setAccent] = useState('#2744C4')
  const [locale, setLocale] = useState('')
  const [walletMode, setWalletMode] = useState<WalletMode>('mock')
  const [embedded, setEmbedded] = useState(true)
  const [embedSecret, setEmbedSecret] = useState<string>()
  const [events, setEvents] = useState<OrkEvent[]>([])
  const [hooks, setHooks] = useState<Array<{ type: string; sessionId?: string; at: string }>>([])
  const { isConnected } = useAccount()

  const theme = useMemo(() => (mode === 'dark' ? darkTheme({ accent }) : mode === 'auto' ? autoTheme({ accent }) : lightTheme({ accent })), [mode, accent])

  const wallet: WalletAdapter | undefined = useMemo(() => {
    if (walletMode === 'mock') return createMockWallet()
    if (walletMode === 'wagmi' && isConnected) return wagmiWallet(wagmiConfig)
    return undefined
  }, [walletMode, isConnected])

  const destination: Destination = useMemo(() => {
    const d = DESTINATIONS[dest]!.destination
    return d.type === 'merchant' ? { type: 'merchant', currency: CURRENCY[country] ?? 'USD' } : d
  }, [dest, country])

  const getClientSecret = async () => {
    const r =
      direction === 'withdraw'
        ? await fetch('/api/withdraw-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ country, custody }) })
        : await fetch('/api/deposit-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ country, destination }) })
    const j = (await r.json()) as { clientSecret: string }
    return j.clientSecret
  }

  // Embedded mode: new session whenever the setup changes.
  useEffect(() => {
    if (!embedded) return
    let cancelled = false
    setEmbedSecret(undefined)
    void getClientSecret().then((s) => !cancelled && setEmbedSecret(s))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, direction, custody, country, dest, walletMode, isConnected])

  useEffect(() => {
    const t = setInterval(() => void fetch('/api/hooks').then((r) => r.json()).then(setHooks).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [])

  const onEvent = (e: OrkEvent) => setEvents((xs) => [e, ...xs].slice(0, 30))

  const code =
    direction === 'withdraw'
      ? `const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  direction: 'withdraw',
  country: '${country}',
  source: { chain: 'eip155:8453', token: USDC_BASE, custody: '${custody}' },
  allowedTargets: { crypto: { chains: [...] }, fiat: {} },
})

<OpenRampProvider baseUrl="/api/openramp" theme={${mode}Theme({ accent: '${accent}' })}>
  <WithdrawButton getClientSecret={getClientSecret} />
</OpenRampProvider>`
      : `const { clientSecret } = await openramp.sessions.create({
  userId: user.id,
  country: '${country}',
  destination: ${JSON.stringify(destination, null, 2).replace(/\n/g, '\n  ')},
})

<OpenRampProvider baseUrl="/api/openramp" theme={${mode}Theme({ accent: '${accent}' })}>
  <DepositButton getClientSecret={getClientSecret} />
</OpenRampProvider>`

  return (
    <OpenRampProvider baseUrl="/api/openramp" theme={theme} {...(wallet ? { wallet } : {})} {...(locale ? { locale } : {})} onEvent={onEvent}>
      <header className="top">
        <div className="brand">OpenRamp<span>Kit</span> <em>playground</em>{mock && <b className="pill">mock providers</b>}</div>
        <ConnectButton showBalance={false} chainStatus="icon" />
      </header>
      <main className="grid">
        <section className="panel" aria-label="Setup">
          <h2>Setup</h2>
          <label>Flow
            <select id="direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="deposit">Deposit</option>
              <option value="withdraw">Withdraw</option>
            </select>
          </label>
          <label>User country
            <select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
            </select>
          </label>
          {direction === 'deposit' ? (
            <label>Destination
              <select id="destination" value={dest} onChange={(e) => setDest(e.target.value)}>
                {Object.entries(DESTINATIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
          ) : (
            <>
              <p className="hint">Source: USDC on Base. The user picks the target: a wallet address or cash.</p>
              <label>Who holds the funds
                <select id="custody" value={custody} onChange={(e) => setCustody(e.target.value as Custody)}>
                  <option value="user_wallet">User wallet (user signs)</option>
                  <option value="app">App (demo treasury signs)</option>
                </select>
              </label>
            </>
          )}
          <label>Wallet
            <select id="wallet" value={walletMode} onChange={(e) => setWalletMode(e.target.value as WalletMode)}>
              <option value="none">No wallet</option>
              <option value="mock">Mock wallet (test)</option>
              <option value="wagmi">Connected wallet (wagmi)</option>
            </select>
          </label>
          {walletMode === 'wagmi' && !isConnected && <p className="hint">Connect a wallet with the button at the top.</p>}
          <label>Theme
            <select id="theme" value={mode} onChange={(e) => setMode(e.target.value as 'light' | 'dark' | 'auto')}>
              <option value="light">Light</option><option value="dark">Dark</option><option value="auto">System</option>
            </select>
          </label>
          <label>Language
            <select id="locale" value={locale} onChange={(e) => setLocale(e.target.value)}>
              {LOCALES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
          </label>
          <label>Accent
            <input id="accent" type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
          </label>
          <label className="row"><input id="embedded" type="checkbox" checked={embedded} onChange={(e) => setEmbedded(e.target.checked)} /> Embedded (inline)</label>
        </section>

        <section className="stage" aria-label="Widget">
          {embedded ? (
            embedSecret ? (
              <OpenRampEmbedded key={embedSecret} clientSecret={embedSecret} />
            ) : (
              <p className="hint">Creating a session...</p>
            )
          ) : direction === 'withdraw' ? (
            <WithdrawButton getClientSecret={getClientSecret} label="Withdraw" />
          ) : (
            <DepositButton getClientSecret={getClientSecret} label="Deposit" />
          )}
        </section>

        <section className="panel" aria-label="Output">
          <h2>Code</h2>
          <pre className="code">{code}</pre>
          <h2>Widget events</h2>
          <ol className="log" data-testid="events">{events.map((e) => <li key={e.id}><code>{e.type}</code></li>)}</ol>
          <h2>Webhooks received by your backend</h2>
          <ol className="log" data-testid="webhooks">{hooks.map((h, i) => <li key={i}><code>{h.type}</code> <small>{h.sessionId}</small></li>)}</ol>
        </section>
      </main>
    </OpenRampProvider>
  )
}
