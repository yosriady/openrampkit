import { openramp } from '@/lib/openramp'

export const dynamic = 'force-dynamic'

/**
 * Background sweep: retry failed webhooks, refresh open payments, expire old sessions.
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` (see vercel.json).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  // Fail closed in production: without CRON_SECRET nobody may call this route.
  if (!secret && process.env.NODE_ENV === 'production') return new Response('CRON_SECRET is not set', { status: 401 })
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 })
  return Response.json(await openramp.sweep())
}
