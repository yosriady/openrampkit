import { openramp } from '@/lib/openramp'

export const dynamic = 'force-dynamic'

/**
 * Background sweep: retry failed webhooks, refresh open payments, expire old sessions.
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` (see vercel.json).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 })
  return Response.json(await openramp.sweep())
}
