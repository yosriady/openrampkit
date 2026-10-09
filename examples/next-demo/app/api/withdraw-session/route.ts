import { openramp } from '@/lib/openramp'

export const dynamic = 'force-dynamic'

/**
 * Your backend decides who the user is and which funds leave. The user picks where they go
 * (their own wallet, or cash to their bank or e-wallet), inside the limits you set here.
 *
 * This demo withdraws USDC on Base. With `custody: 'user_wallet'` the user's wallet signs; with
 * `custody: 'app'` the server's `treasury` hook sends from the app's wallet.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { country?: string; custody?: 'user_wallet' | 'app'; userId?: string }
  const session = await openramp.sessions.create({
    userId: body.userId ?? 'demo-user',
    direction: 'withdraw',
    source: {
      chain: 'eip155:8453',
      token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      symbol: 'USDC',
      decimals: 6,
      custody: body.custody === 'app' ? 'app' : 'user_wallet',
    },
    // Where the user may send it: these networks, and cash in any currency.
    allowedDestinations: {
      crypto: { chains: ['eip155:8453', 'eip155:42161', 'eip155:10', 'eip155:137', 'eip155:1'] },
      fiat: {},
    },
    ...(body.country ? { country: body.country } : {}),
    metadata: { source: 'next-demo' },
  })
  return Response.json(session)
}
