import type { APIEvent } from '@solidjs/start/server'
import { openramp } from '~/lib/openramp.server'

// Mounts the OpenRampKit server at /api/openramp. It takes a web-standard Request.
const handle = (event: APIEvent) => openramp.handle(event.request)

export const GET = handle
export const POST = handle
export const OPTIONS = handle
