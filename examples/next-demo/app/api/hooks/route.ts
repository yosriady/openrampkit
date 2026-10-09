import type { WebhookEvent } from '@openrampkit/server'
import { openramp } from '@/lib/openramp'

export const dynamic = 'force-dynamic'

const received: Array<{ type: string; sessionId?: string; at: string }> = []

/**
 * Your backend receives signed events here, e.g. to credit a balance on `session.succeeded`. The headers
 * follow Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`). Verify the raw body.
 */
export async function POST(req: Request) {
  const body = await req.text()
  const ok = await openramp.webhooks.verify(req, body)
  if (!ok) return new Response('bad signature', { status: 401 })
  const event = JSON.parse(body) as WebhookEvent
  if (event.type === 'session.succeeded') {
    // Credit here, once per session (deduplicate by event.id and by session id).
    const { session } = event.data.object
    console.log('[openramp webhook] credit', session.userId, session.result?.output.value)
  }
  received.unshift({ type: event.type, sessionId: event.sessionId, at: event.createdAt })
  received.length = Math.min(received.length, 50)
  console.log('[openramp webhook]', event.type, event.sessionId)
  return new Response('ok')
}

export async function GET() {
  return Response.json(received)
}
