<script setup lang="ts">
import { ref } from 'vue'
import { createMockWallet } from '@openrampkit/client'
import { DepositButton, OpenRampProvider, lightTheme, type PublicSession } from '@openrampkit/vue'

// A mock wallet so that "Pay with wallet" works without a browser extension.
const wallet = createMockWallet()
const status = ref('')

async function getClientSecret() {
  const { clientSecret } = await $fetch<{ clientSecret: string }>('/api/deposit-session', { method: 'POST' })
  return clientSecret
}

function onComplete(session: PublicSession) {
  status.value = `Deposit ${session.id} completed`
}
</script>

<template>
  <main style="font-family: system-ui, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px">
    <h1>OpenRampKit + Nuxt</h1>
    <p>Mock providers only. No real money moves.</p>
    <OpenRampProvider base-url="/api/openramp" :theme="lightTheme()" :wallet="wallet">
      <DepositButton :get-client-secret="getClientSecret" @complete="onComplete">Add funds</DepositButton>
    </OpenRampProvider>
    <p v-if="status" role="status">{{ status }}</p>
  </main>
</template>
