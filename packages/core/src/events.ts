import type { OpenRampEvent, OpenRampEventType } from './types.js'

export function randomId(prefix: string, bytes = 12): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return `${prefix}_${s}`
}

/** Build an event envelope. The id is random unless `opts.id` is given (the server gives a deterministic one). */
export function createEvent<T>(type: OpenRampEventType, object: T, opts: { id?: string; sessionId?: string; livemode?: boolean } = {}): OpenRampEvent<T> {
  return {
    id: opts.id ?? randomId('evt'),
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: opts.livemode ?? false,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    data: { object },
  }
}
