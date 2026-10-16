import { createMockWallet } from '@openrampkit/client'
import { DepositButton, OpenRampProvider, lightTheme, type PublicSession } from '@openrampkit/solid'
import { createSignal, Show } from 'solid-js'

// A mock wallet so that "Pay with wallet" works without a browser extension.
const wallet = createMockWallet()

async function getClientSecret() {
  const r = await fetch('/api/deposit-session', { method: 'POST' })
  const { clientSecret } = (await r.json()) as { clientSecret: string }
  return clientSecret
}

export default function Home() {
  const [status, setStatus] = createSignal('')
  const onComplete = (session: PublicSession) => setStatus(`Deposit ${session.id} completed`)

  return (
    <main style={{ 'font-family': 'system-ui, sans-serif', 'max-width': '480px', margin: '64px auto', padding: '0 16px' }}>
      <h1>OpenRampKit + SolidStart</h1>
      <p>Mock providers only. No real money moves.</p>
      <OpenRampProvider baseUrl="/api/openramp" theme={lightTheme()} wallet={wallet}>
        <DepositButton getClientSecret={getClientSecret} label="Add funds" onComplete={onComplete} />
      </OpenRampProvider>
      <Show when={status()}>
        <p role="status">{status()}</p>
      </Show>
    </main>
  )
}
