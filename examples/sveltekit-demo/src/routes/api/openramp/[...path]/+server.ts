import { openramp } from '#lib/server/openramp.js'
import type { RequestHandler } from './$types'

// Mounts the OpenRampKit server at /api/openramp. It takes a web-standard Request.
const handle: RequestHandler = ({ request }) => openramp.handle(request)

export const GET = handle
export const POST = handle
export const OPTIONS = handle
