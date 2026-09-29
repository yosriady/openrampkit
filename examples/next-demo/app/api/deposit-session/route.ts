import { openramp } from '@/lib/openramp'
import type { Destination } from '@openrampkit/core'

export const dynamic = 'force-dynamic'

/**
 * Your backend decides who the user is and where the money goes.
 * This demo accepts the destination from the playground so you can try different setups.
 * In a real app, read the user from your auth and use their deposit address from your database.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { country?: string; destination?: Destination; userId?: string }
  const destination: Destination = body.destination ?? {
    type: 'crypto',
    chain: 'eip155:8453',
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    decimals: 6,
    address: '0x000000000000000000000000000000000000dEaD',
  }
  const session = await openramp.sessions.create({
    userId: body.userId ?? 'demo-user',
    destination,
    ...(body.country ? { country: body.country } : {}),
    metadata: { source: 'next-demo' },
  })
  return Response.json(session)
}
