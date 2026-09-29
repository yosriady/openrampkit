import type { OrkEvent, OrkEventType } from './types.js'

export function randomId(prefix: string, bytes = 12): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return `${prefix}_${s}`
}

export function createEvent<T>(type: OrkEventType, object: T, opts: { sessionId?: string; livemode?: boolean } = {}): OrkEvent<T> {
  return {
    id: randomId('evt'),
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: opts.livemode ?? false,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    data: { object },
  }
}
