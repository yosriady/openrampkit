import { openramp } from '@/lib/openramp'

export const dynamic = 'force-dynamic'

const received: Array<{ type: string; sessionId?: string; at: string }> = []

/** Your backend receives signed events here, e.g. to credit a balance on `session.completed`. */
export async function POST(req: Request) {
  const body = await req.text()
  const ok = await openramp.webhooks.verify(req, body)
  if (!ok) return new Response('bad signature', { status: 401 })
  const event = JSON.parse(body) as { type: string; sessionId?: string }
  received.unshift({ type: event.type, ...(event.sessionId ? { sessionId: event.sessionId } : {}), at: new Date().toISOString() })
  received.length = Math.min(received.length, 50)
  console.log('[openramp webhook]', event.type, event.sessionId)
  return new Response('ok')
}

export async function GET() {
  return Response.json(received)
}
