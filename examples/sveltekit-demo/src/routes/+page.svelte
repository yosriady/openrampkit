<script lang="ts">
  import { createMockWallet } from '@openrampkit/client'
  import { depositButton, lightTheme, setOpenRamp, type PublicSession } from '@openrampkit/svelte'

  // A mock wallet so that "Pay with wallet" works without a browser extension.
  const ramp = setOpenRamp({ baseUrl: '/api/openramp', theme: lightTheme(), wallet: createMockWallet() })
  const isOpen = ramp.isOpen
  let status = $state('')

  async function getClientSecret() {
    const r = await fetch('/api/deposit-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const { clientSecret } = (await r.json()) as { clientSecret: string }
    return clientSecret
  }

  function onComplete(session: PublicSession) {
    status = `Deposit ${session.id} completed`
  }
</script>

<main style="font-family: system-ui, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px">
  <h1>OpenRampKit + SvelteKit</h1>
  <p>Mock providers only. No real money moves.</p>
  <button type="button" use:depositButton={{ ramp, getClientSecret, onComplete }}>
    {$isOpen ? 'Opening' : 'Add funds'}
  </button>
  {#if status}<p role="status">{status}</p>{/if}
</main>
