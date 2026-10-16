import type { Destination } from '@openrampkit/core'

/**
 * Your backend decides who the user is and where the money goes.
 * In a real app, read the user from your auth and their deposit address from your database.
 */
export default defineEventHandler(async () => {
  const destination: Destination = {
    type: 'crypto',
    chain: 'eip155:8453',
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    decimals: 6,
    address: '0x000000000000000000000000000000000000dEaD',
  }
  return openramp.sessions.create({ userId: 'demo-user', destination, metadata: { source: 'nuxt-demo' } })
})
